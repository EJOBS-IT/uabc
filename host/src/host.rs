//! Host mode: `uabc` as Chrome's native messaging host.
//!
//! Chrome starts this process when the extension calls `connectNative()` and
//! talks to it over stdin/stdout (hop C). The host opens a user-scoped IPC
//! endpoint (hop B) where any number of `uabc mcp` processes — one per AI
//! client — can connect. It is a router: it re-numbers request ids, tags them
//! with the client session, and maps responses back. All policy decisions are
//! made in the extension, which is the component the user controls.
//!
//! The process exits when Chrome closes the port (stdin EOF).

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use anyhow::{Context, bail};
use futures::StreamExt;
use tokio::io::{AsyncRead, AsyncWrite, AsyncWriteExt};
use tokio::sync::mpsc;
use tokio_util::codec::{FramedRead, LinesCodec};

use crate::ipc::{self, BoxStream};
use crate::native;
use crate::paths;
use crate::proto::*;

/// Maximum IPC line: generous enough for full-page screenshots.
pub const MAX_LINE: usize = 64 * 1024 * 1024;
const HELLO_TIMEOUT: Duration = Duration::from_secs(10);

/// Entry point when Chrome launches us: `uabc chrome-extension://<id>/ [--parent-window=N]`.
pub async fn run(origin: &str) -> anyhow::Result<()> {
    let extension_id = parse_origin(origin).with_context(|| format!("unexpected caller origin {origin:?}"))?;
    tracing::info!(%extension_id, pid = std::process::id(), "native host starting");
    serve(tokio::io::stdin(), tokio::io::stdout(), extension_id).await
}

/// Validates `chrome-extension://<32 chars a-p>/` and returns the id.
pub fn parse_origin(origin: &str) -> anyhow::Result<String> {
    let id = origin
        .strip_prefix("chrome-extension://")
        .map(|rest| rest.trim_end_matches('/'))
        .context("not a chrome-extension:// origin")?;
    if id.len() != 32 || !id.bytes().all(|b| (b'a'..=b'p').contains(&b)) {
        bail!("malformed extension id");
    }
    Ok(id.to_owned())
}

/// Runs the host over arbitrary streams (stdin/stdout in production, pipes in tests).
pub async fn serve<R, W>(mut from_browser: R, to_browser: W, extension_id: String) -> anyhow::Result<()>
where
    R: AsyncRead + Unpin,
    W: AsyncWrite + Unpin + Send + 'static,
{
    let hello = tokio::time::timeout(HELLO_TIMEOUT, read_from_extension(&mut from_browser))
        .await
        .context("extension did not say hello in time")??;
    let Some(FromExtension::Hello { protocol, extension, instance, browser }) = hello else {
        bail!("first message from the extension must be hello");
    };
    if protocol != PROTOCOL {
        bail!("extension speaks protocol {protocol}, this host speaks {PROTOCOL}; update both together");
    }
    if extension.id != extension_id {
        tracing::warn!(claimed = %extension.id, actual = %extension_id, "extension id mismatch; trusting Chrome's argv");
    }
    if !paths::valid_instance_id(&instance.id) {
        bail!("invalid instance id {:?}", instance.id);
    }

    let endpoint = paths::endpoint_for(&instance.id);
    let listener = ipc::Listener::bind(&endpoint).with_context(|| format!("binding {endpoint}"))?;

    let (to_ext, to_ext_rx) = mpsc::channel::<Vec<u8>>(256);
    let writer = tokio::spawn(write_to_browser(to_browser, to_ext_rx));

    let host = HostInfo { version: VERSION.into(), pid: std::process::id(), endpoint: Some(endpoint.clone()) };
    let state = Arc::new(State {
        to_ext,
        pending: Mutex::new(HashMap::new()),
        next_id: AtomicU64::new(1),
        next_session: AtomicU64::new(1),
        welcome: Welcome {
            protocol: PROTOCOL,
            session: String::new(),
            instance: instance.clone(),
            host: host.clone(),
            extension: ExtensionInfo { id: extension_id.clone(), version: extension.version.clone() },
            browser: browser.clone(),
        },
    });
    let _descriptor = DescriptorFile::write(&InstanceDescriptor {
        instance_id: instance.id.clone(),
        label: instance.label.clone(),
        pid: std::process::id(),
        endpoint: endpoint.clone(),
        extension_id,
        extension_version: extension.version,
        browser: format!("{} {}", browser.name, browser.version).trim().to_owned(),
        host_version: VERSION.into(),
        started_at: SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or_default(),
    })?;
    // Only now is the host fully ready (endpoint bound and discoverable).
    state.send(&ToExtension::Welcome { protocol: PROTOCOL, host }).await?;
    tracing::info!(%endpoint, instance = %instance.id, "listening for AI clients");

    let accept_state = state.clone();
    let acceptor = tokio::spawn(async move {
        loop {
            match listener.accept().await {
                Ok(stream) => {
                    tokio::spawn(serve_client(stream, accept_state.clone()));
                }
                Err(e) => {
                    tracing::warn!(error = %e, "accept failed");
                    tokio::time::sleep(Duration::from_millis(100)).await;
                }
            }
        }
    });

    loop {
        match read_from_extension(&mut from_browser).await {
            Ok(Some(FromExtension::Response(resp))) => state.route_response(resp),
            Ok(Some(FromExtension::Hello { .. })) => tracing::warn!("ignoring duplicate hello"),
            Ok(Some(FromExtension::Ping | FromExtension::Unknown)) => {
                tracing::debug!("ignoring keepalive or unknown message")
            }
            Ok(None) => break,
            Err(e) if e.kind() == std::io::ErrorKind::InvalidData => {
                tracing::warn!(error = %e, "malformed message from extension");
            }
            Err(e) => {
                tracing::warn!(error = %e, "lost connection to the browser");
                break;
            }
        }
    }

    tracing::info!("browser closed the port; shutting down");
    acceptor.abort(); // drops the listener, which removes the socket file
    writer.abort();
    Ok(())
}

struct State {
    to_ext: mpsc::Sender<Vec<u8>>,
    pending: Mutex<HashMap<u64, Pending>>,
    next_id: AtomicU64,
    next_session: AtomicU64,
    welcome: Welcome,
}

struct Pending {
    session: String,
    client_id: u64,
    reply: mpsc::UnboundedSender<IpcMessage>,
}

impl State {
    async fn send(&self, msg: &ToExtension) -> Result<(), ErrorBody> {
        let bytes = serde_json::to_vec(msg).map_err(|e| ErrorBody::new(codes::INTERNAL, e.to_string()))?;
        native::check_outgoing_size(bytes.len()).map_err(|e| {
            ErrorBody::new(codes::INVALID_PARAMS, e.to_string())
                .with_hint("Send less data per call: Chrome limits host-to-extension messages to 1 MiB.")
        })?;
        self.to_ext
            .send(bytes)
            .await
            .map_err(|_| ErrorBody::new(codes::EXTENSION_DISCONNECTED, "the browser connection is closed"))
    }

    fn route_response(&self, resp: Response) {
        let pending = self.pending.lock().unwrap().remove(&resp.id);
        match pending {
            Some(p) => {
                let _ = p.reply.send(IpcMessage::Response(Response { id: p.client_id, ..resp }));
            }
            None => tracing::debug!(id = resp.id, "response for a request nobody waits for"),
        }
    }
}

async fn serve_client(stream: BoxStream, state: Arc<State>) {
    let (read_half, mut write_half) = tokio::io::split(stream);
    let mut lines = FramedRead::new(read_half, LinesCodec::new_with_max_length(MAX_LINE));
    let (reply, mut replies) = mpsc::unbounded_channel::<IpcMessage>();
    let writer = tokio::spawn(async move {
        while let Some(msg) = replies.recv().await {
            let Ok(mut line) = serde_json::to_string(&msg) else { continue };
            line.push('\n');
            if write_half.write_all(line.as_bytes()).await.is_err() {
                break;
            }
        }
    });

    let client = match tokio::time::timeout(Duration::from_secs(5), lines.next()).await {
        Ok(Some(Ok(line))) => match serde_json::from_str::<IpcMessage>(&line) {
            Ok(IpcMessage::Hello { protocol, client, .. }) if protocol == PROTOCOL => client,
            Ok(IpcMessage::Hello { protocol, .. }) => {
                let _ = reply.send(IpcMessage::Error {
                    error: ErrorBody::new(
                        codes::PROTOCOL_MISMATCH,
                        format!("client speaks protocol {protocol}, host speaks {PROTOCOL}"),
                    )
                    .with_hint("Update the UABC extension and the uabc binary to matching versions."),
                });
                drop(reply);
                let _ = writer.await;
                return;
            }
            _ => return,
        },
        _ => return,
    };

    let session = format!("s{}", state.next_session.fetch_add(1, Ordering::Relaxed));
    tracing::info!(%session, client = %client.name, "AI client connected");
    if state.send(&ToExtension::SessionOpen { session: session.clone(), client }).await.is_err() {
        return;
    }
    let mut welcome = state.welcome.clone();
    welcome.session = session.clone();
    let _ = reply.send(IpcMessage::Welcome(Box::new(welcome)));

    while let Some(line) = lines.next().await {
        let Ok(line) = line else { break }; // over-long line or I/O error
        match serde_json::from_str::<IpcMessage>(&line) {
            Ok(IpcMessage::Request { id, method, params }) => {
                let gid = state.next_id.fetch_add(1, Ordering::Relaxed);
                state
                    .pending
                    .lock()
                    .unwrap()
                    .insert(gid, Pending { session: session.clone(), client_id: id, reply: reply.clone() });
                let msg = ToExtension::Request { id: gid, session: session.clone(), method, params };
                if let Err(error) = state.send(&msg).await {
                    state.pending.lock().unwrap().remove(&gid);
                    let _ = reply.send(IpcMessage::Response(Response::err(id, error)));
                }
            }
            Ok(IpcMessage::Cancel { id }) => {
                let gid = state
                    .pending
                    .lock()
                    .unwrap()
                    .iter()
                    .find(|(_, p)| p.session == session && p.client_id == id)
                    .map(|(gid, _)| *gid);
                if let Some(gid) = gid {
                    let _ = state.send(&ToExtension::Cancel { id: gid }).await;
                }
            }
            Ok(other) => tracing::debug!(?other, "unexpected message from IPC client"),
            Err(e) => {
                let _ = reply.send(IpcMessage::Error {
                    error: ErrorBody::new(codes::INVALID_PARAMS, format!("malformed message: {e}")),
                });
            }
        }
    }

    tracing::info!(%session, "AI client disconnected");
    state.pending.lock().unwrap().retain(|_, p| p.session != session);
    let _ = state.send(&ToExtension::SessionClose { session }).await;
    drop(reply);
    let _ = writer.await;
}

async fn read_from_extension<R: AsyncRead + Unpin>(r: &mut R) -> std::io::Result<Option<FromExtension>> {
    let Some(bytes) = native::read_message(r).await? else { return Ok(None) };
    serde_json::from_slice(&bytes).map(Some).map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))
}

async fn write_to_browser<W: AsyncWrite + Unpin>(mut out: W, mut rx: mpsc::Receiver<Vec<u8>>) {
    while let Some(bytes) = rx.recv().await {
        if let Err(e) = native::write_message(&mut out, &bytes).await {
            tracing::warn!(error = %e, "writing to the browser failed");
            break;
        }
    }
}

/// The discovery record; removed again when the host shuts down cleanly.
struct DescriptorFile(std::path::PathBuf);

impl DescriptorFile {
    fn write(d: &InstanceDescriptor) -> anyhow::Result<Self> {
        paths::ensure_private_dir(&paths::instances_dir())?;
        let path = paths::descriptor_path(&d.instance_id);
        let tmp = path.with_extension("json.tmp");
        std::fs::write(&tmp, serde_json::to_vec_pretty(d)?)?;
        std::fs::rename(&tmp, &path)?;
        Ok(Self(path))
    }
}

impl Drop for DescriptorFile {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_only_well_formed_extension_origins() {
        assert_eq!(
            parse_origin("chrome-extension://opidijgpffpkhmnenmcdmjbhkgkdceec/").unwrap(),
            "opidijgpffpkhmnenmcdmjbhkgkdceec"
        );
        for bad in [
            "https://evil.example/",
            "chrome-extension://short/",
            "chrome-extension://OPIDIJGPFFPKHMNENMCDMJBHKGKDCEEC/",
            "chrome-extension://opidijgpffpkhmnenmcdmjbhkgkdceez/",
        ] {
            assert!(parse_origin(bad).is_err(), "{bad}");
        }
    }
}
