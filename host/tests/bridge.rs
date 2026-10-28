//! Drives the real `uabc` binary: the test plays the browser (native
//! messaging on stdio) and the AI clients (IPC socket / MCP on stdio).

#![cfg(unix)]

use std::path::Path;
use std::process::Stdio;
use std::time::Duration;

use serde_json::{Value, json};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader, Lines};
use tokio::net::UnixStream;
use tokio::net::unix::{OwnedReadHalf, OwnedWriteHalf};
use tokio::process::{Child, ChildStdin, ChildStdout, Command};

const EXT_ID: &str = "opidijgpffpkhmnenmcdmjbhkgkdceec";
const T: Duration = Duration::from_secs(10);

struct FakeBrowser {
    child: Child,
    stdin: Option<ChildStdin>,
    stdout: ChildStdout,
}

impl FakeBrowser {
    /// Starts the host exactly like Chrome does and completes the hello/welcome exchange.
    async fn launch(home: &Path, instance: &str) -> (Self, Value) {
        let mut child = Command::new(env!("CARGO_BIN_EXE_uabc"))
            .arg(format!("chrome-extension://{EXT_ID}/"))
            .env("UABC_HOME", home)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .kill_on_drop(true)
            .spawn()
            .unwrap();
        let mut browser = Self { stdin: child.stdin.take(), stdout: child.stdout.take().unwrap(), child };
        browser
            .send(json!({
                "type": "hello", "protocol": 1,
                "extension": {"id": EXT_ID, "version": "0.1.0"},
                "instance": {"id": instance, "label": "Test profile"},
                "browser": {"name": "Chromium", "version": "142"}
            }))
            .await;
        let welcome = browser.recv().await;
        (browser, welcome)
    }

    async fn send(&mut self, v: Value) {
        let bytes = serde_json::to_vec(&v).unwrap();
        let stdin = self.stdin.as_mut().unwrap();
        stdin.write_all(&(bytes.len() as u32).to_ne_bytes()).await.unwrap();
        stdin.write_all(&bytes).await.unwrap();
        stdin.flush().await.unwrap();
    }

    async fn recv(&mut self) -> Value {
        tokio::time::timeout(T, async {
            let mut len = [0u8; 4];
            self.stdout.read_exact(&mut len).await.unwrap();
            let mut buf = vec![0u8; u32::from_ne_bytes(len) as usize];
            self.stdout.read_exact(&mut buf).await.unwrap();
            serde_json::from_slice(&buf).unwrap()
        })
        .await
        .expect("host did not write to the browser in time")
    }

    /// Closing stdin is how Chrome says goodbye.
    async fn close(mut self) -> std::process::ExitStatus {
        self.stdin.take();
        tokio::time::timeout(T, self.child.wait()).await.unwrap().unwrap()
    }
}

struct Ai {
    lines: Lines<BufReader<OwnedReadHalf>>,
    write: OwnedWriteHalf,
}

impl Ai {
    async fn connect(endpoint: &str, protocol: u32) -> (Self, Value) {
        let (read, write) = UnixStream::connect(endpoint).await.unwrap().into_split();
        let mut ai = Self { lines: BufReader::new(read).lines(), write };
        ai.send(json!({"type": "hello", "protocol": protocol, "client": {"name": "test-client", "version": "1"}}))
            .await;
        let reply = ai.recv().await;
        (ai, reply)
    }

    async fn send(&mut self, v: Value) {
        let mut line = v.to_string();
        line.push('\n');
        self.write.write_all(line.as_bytes()).await.unwrap();
    }

    async fn recv(&mut self) -> Value {
        let line = tokio::time::timeout(T, self.lines.next_line()).await.unwrap().unwrap().unwrap();
        serde_json::from_str(&line).unwrap()
    }
}

#[tokio::test]
async fn routes_requests_responses_cancellation_and_sessions() {
    let home = tempfile::tempdir().unwrap();
    let (mut browser, welcome) = FakeBrowser::launch(home.path(), "profile1").await;
    assert_eq!(welcome["type"], "welcome");
    let endpoint = welcome["host"]["endpoint"].as_str().unwrap().to_owned();

    let descriptor: Value =
        serde_json::from_slice(&std::fs::read(home.path().join("instances/profile1.json")).unwrap()).unwrap();
    assert_eq!(descriptor["endpoint"], endpoint);
    assert_eq!(descriptor["extension_id"], EXT_ID);
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = std::fs::metadata(&endpoint).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600, "socket must be private to the user");
    }

    let (mut ai, hello) = Ai::connect(&endpoint, 1).await;
    assert_eq!(hello["type"], "welcome");
    assert_eq!(hello["instance"]["label"], "Test profile");
    let session = hello["session"].as_str().unwrap().to_owned();

    let open = browser.recv().await;
    assert_eq!(
        open,
        json!({"type": "session.open", "session": session, "client": {"name": "test-client", "version": "1"}})
    );

    // request → extension → response, with ids re-mapped in both directions
    ai.send(json!({"type": "request", "id": 42, "method": "tabs.list", "params": {}})).await;
    let req = browser.recv().await;
    assert_eq!(
        (req["type"].as_str(), req["method"].as_str(), req["session"].as_str()),
        (Some("request"), Some("tabs.list"), Some(session.as_str()))
    );
    browser.send(json!({"type": "response", "id": req["id"], "ok": true, "result": {"tabs": []}})).await;
    assert_eq!(ai.recv().await, json!({"type": "response", "id": 42, "ok": true, "result": {"tabs": []}}));

    // errors pass through untouched
    ai.send(json!({"type": "request", "id": 43, "method": "input.click", "params": {"ref": "9"}})).await;
    let req = browser.recv().await;
    browser
        .send(json!({"type": "response", "id": req["id"], "ok": false, "error": {"code": "OBSCURED", "message": "covered by dialog", "hint": "close it"}}))
        .await;
    let resp = ai.recv().await;
    assert_eq!(resp["error"]["code"], "OBSCURED");
    assert_eq!(resp["error"]["hint"], "close it");

    // cancellation is forwarded with the extension-side id
    ai.send(json!({"type": "request", "id": 44, "method": "page.wait_for", "params": {}})).await;
    let req = browser.recv().await;
    ai.send(json!({"type": "cancel", "id": 44})).await;
    assert_eq!(browser.recv().await, json!({"type": "cancel", "id": req["id"]}));

    // a disconnecting client closes its session in the extension
    drop(ai);
    assert_eq!(browser.recv().await, json!({"type": "session.close", "session": session}));

    // browser goes away → host exits and cleans up after itself
    let status = browser.close().await;
    assert!(status.success());
    assert!(!home.path().join("instances/profile1.json").exists());
    assert!(!Path::new(&endpoint).exists());
}

#[tokio::test]
async fn refuses_clients_with_another_protocol_version() {
    let home = tempfile::tempdir().unwrap();
    let (mut browser, welcome) = FakeBrowser::launch(home.path(), "profile2").await;
    let endpoint = welcome["host"]["endpoint"].as_str().unwrap();
    let (_, reply) = Ai::connect(endpoint, 99).await;
    assert_eq!(reply["type"], "error");
    assert_eq!(reply["error"]["code"], "PROTOCOL_MISMATCH");
    // the extension never hears about the rejected client
    browser.send(json!({"type": "noise"})).await;
    assert!(browser.close().await.success());
}

#[tokio::test]
async fn a_second_host_for_the_same_profile_does_not_hijack_the_endpoint() {
    let home = tempfile::tempdir().unwrap();
    let (first, _) = FakeBrowser::launch(home.path(), "profile3").await;

    let mut second = Command::new(env!("CARGO_BIN_EXE_uabc"))
        .arg(format!("chrome-extension://{EXT_ID}/"))
        .env("UABC_HOME", home.path())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .spawn()
        .unwrap();
    let hello = serde_json::to_vec(&json!({
        "type": "hello", "protocol": 1,
        "extension": {"id": EXT_ID, "version": "0.1.0"},
        "instance": {"id": "profile3"}
    }))
    .unwrap();
    let mut stdin = second.stdin.take().unwrap();
    stdin.write_all(&(hello.len() as u32).to_ne_bytes()).await.unwrap();
    stdin.write_all(&hello).await.unwrap();
    let status = tokio::time::timeout(T, second.wait()).await.unwrap().unwrap();
    assert!(!status.success(), "second host must refuse to start");
    assert!(first.close().await.success());
}

#[tokio::test]
async fn host_rejects_path_traversal_in_instance_ids() {
    let home = tempfile::tempdir().unwrap();
    let mut child = Command::new(env!("CARGO_BIN_EXE_uabc"))
        .arg(format!("chrome-extension://{EXT_ID}/"))
        .env("UABC_HOME", home.path())
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .spawn()
        .unwrap();
    let hello = serde_json::to_vec(&json!({
        "type": "hello", "protocol": 1,
        "extension": {"id": EXT_ID, "version": "0.1.0"},
        "instance": {"id": "../../escape"}
    }))
    .unwrap();
    let mut stdin = child.stdin.take().unwrap();
    stdin.write_all(&(hello.len() as u32).to_ne_bytes()).await.unwrap();
    stdin.write_all(&hello).await.unwrap();
    assert!(!tokio::time::timeout(T, child.wait()).await.unwrap().unwrap().success());
    assert!(!home.path().join("escape.json").exists());
}

/// Minimal MCP conversation over stdio, without any browser running.
#[tokio::test]
async fn mcp_server_lists_tools_and_explains_missing_browser() {
    let home = tempfile::tempdir().unwrap();
    let mut child = Command::new(env!("CARGO_BIN_EXE_uabc"))
        .arg("mcp")
        .env("UABC_HOME", home.path())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .kill_on_drop(true)
        .spawn()
        .unwrap();
    let mut stdin = child.stdin.take().unwrap();
    let mut out = BufReader::new(child.stdout.take().unwrap()).lines();
    let mut rpc = async |msg: Value| -> Option<Value> {
        stdin.write_all(format!("{msg}\n").as_bytes()).await.unwrap();
        msg.get("id")?;
        let line = tokio::time::timeout(T, out.next_line()).await.unwrap().unwrap().unwrap();
        Some(serde_json::from_str(&line).unwrap())
    };

    let init = rpc(json!({"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {
        "protocolVersion": "2025-06-18", "capabilities": {},
        "clientInfo": {"name": "bridge-test", "version": "1.0"}
    }}))
    .await
    .unwrap();
    assert_eq!(init["result"]["serverInfo"]["name"], "uabc");
    assert_eq!(init["result"]["protocolVersion"], "2025-06-18");
    assert!(init["result"]["instructions"].as_str().unwrap().contains("untrusted-web-content"));
    rpc(json!({"jsonrpc": "2.0", "method": "notifications/initialized"})).await;

    let tools = rpc(json!({"jsonrpc": "2.0", "id": 2, "method": "tools/list"})).await.unwrap();
    let tools = tools["result"]["tools"].as_array().unwrap();
    assert_eq!(tools.len(), 11);
    let click = tools.iter().find(|t| t["name"] == "browser_click").unwrap();
    assert_eq!(click["annotations"]["destructiveHint"], true);
    assert!(click["inputSchema"]["properties"]["ref"].is_object(), "{click}");
    let state = tools.iter().find(|t| t["name"] == "browser_get_state").unwrap();
    assert_eq!(state["annotations"]["readOnlyHint"], true);

    let call = rpc(json!({"jsonrpc": "2.0", "id": 3, "method": "tools/call", "params": {"name": "browser_status", "arguments": {}}}))
        .await
        .unwrap();
    assert_eq!(call["result"]["isError"], true);
    let text = call["result"]["content"][0]["text"].as_str().unwrap();
    assert!(text.contains("HOST_NOT_RUNNING"), "{text}");
    assert!(text.contains("uabc install"), "the hint must tell the user what to do: {text}");
}
