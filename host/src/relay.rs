//! `uabc relay`: MCP access for AI apps in the cloud (Claude custom
//! connectors, ChatGPT developer-mode connectors, any remote MCP client) to a
//! browser that cannot be reached from the internet.
//!
//! ```text
//!  AI app ──HTTPS: MCP Streamable HTTP──▶ uabc relay ◀──WebSocket (outbound)── UABC extension
//!          /mcp/<device id>/<connector secret>      /ws
//! ```
//!
//! * The extension connects out and proves its device id with a device secret
//!   (trust on first use). The relay stores SHA-256 hashes of secrets only.
//! * A device's connector URL ends in a 256-bit secret the extension chose;
//!   the relay knows only its hash. Rotating it in the extension replaces the
//!   hash at once, so the old URL stops working.
//! * Commands reach the extension in the same messages the native host uses
//!   (docs/protocol.md, hop C), so the extension applies the same gates as for
//!   local clients: tab group, per-site approval in the browser, sensitive
//!   fields, Stop.
//! * TLS is terminated in front of the relay (Caddy, nginx, a tunnel).
//! * Strangers can reach `/ws`, so everything before authentication is
//!   bounded: hello size, pending hellos, registrations per address, devices;
//!   an optional access code limits who may add browsers at all.

use std::collections::HashMap;
use std::net::{IpAddr, SocketAddr};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, Weak};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use axum::Router;
use axum::body::Body;
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{ConnectInfo, Path, Request, State};
use axum::http::{HeaderMap, StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::routing::{any, get};
use futures::future::BoxFuture;
use futures::{SinkExt, StreamExt};
use rmcp::transport::streamable_http_server::session::local::LocalSessionManager;
use rmcp::transport::streamable_http_server::{StreamableHttpServerConfig, StreamableHttpService};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use tokio::sync::{OwnedSemaphorePermit, Semaphore, mpsc, oneshot};
use tokio_util::sync::CancellationToken;

use crate::mcp::{Connector, Link, States, UabcServer};
use crate::paths;
use crate::proto::*;

/// Screenshots of tall pages are several MB of base64.
const MAX_MESSAGE: usize = 16 << 20;
/// A hello is a few hundred bytes; anything bigger is refused before authentication.
const MAX_HELLO: usize = 16 << 10;
/// WebSockets that have not said hello yet (each may hold one message in memory).
const MAX_PENDING_HELLOS: usize = 32;
/// Commands waiting to be written to one browser; a browser that stops reading is dropped.
const OUT_QUEUE: usize = 256;
const MAX_LABEL: usize = 64;
/// The extension pings every 20 s; a connection silent for longer than this is dead.
const IDLE_TIMEOUT: Duration = Duration::from_secs(75);
const HELLO_TIMEOUT: Duration = Duration::from_secs(10);
const MAX_DEVICES: usize = 10_000;
/// New device registrations per client address and hour.
const REGISTRATIONS_PER_HOUR: usize = 10;
/// Devices not seen for this long are forgotten (they register again on their next visit).
const DEVICE_TTL: Duration = Duration::from_secs(30 * 24 * 3600);
/// A remote app's extension session (and its "allow this time" grants) ends
/// after this long without a call; the next call starts a new one.
pub const REMOTE_SESSION_IDLE: Duration = Duration::from_secs(600);
/// Changed device records are written at most this often (never once per hello).
const FLUSH_EVERY: Duration = Duration::from_secs(2);

pub struct RelayOptions {
    pub listen: SocketAddr,
    pub data_dir: PathBuf,
    /// Accept WebSocket clients that are not browser extensions (tests, other clients).
    pub allow_any_origin: bool,
    /// When set, adding a new browser requires this access code (existing ones are unaffected).
    pub registration_token: Option<String>,
}

// ----- persisted device records ---------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
struct DeviceRecord {
    secret_sha256: String,
    connector_sha256: String,
    #[serde(default)]
    label: String,
    created: u64,
    last_seen: u64,
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct Store {
    devices: HashMap<String, DeviceRecord>,
}

fn now() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_secs())
}

fn sha256_hex(s: &str) -> String {
    Sha256::digest(s.as_bytes()).iter().map(|b| format!("{b:02x}")).collect()
}

/// Compares secrets' hashes without leaking where they differ.
fn same(a: &str, b: &str) -> bool {
    a.len() == b.len() && a.bytes().zip(b.bytes()).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

fn is_hex(s: &str, len: usize) -> bool {
    s.len() == len && s.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// Device ids and secrets are generated by the extension: lowercase hex.
fn valid_device_id(id: &str) -> bool {
    (16..=64).contains(&id.len()) && id.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

// ----- the extension's hello ------------------------------------------------------------

#[derive(Debug, Deserialize)]
struct DeviceCredentials {
    id: String,
    secret: String,
}

#[derive(Debug, Deserialize)]
struct ConnectorInfo {
    sha256: String,
}

#[derive(Debug, Default, Deserialize)]
struct Registration {
    #[serde(default)]
    token: String,
}

#[derive(Debug, Deserialize)]
struct RelayHello {
    #[serde(rename = "type")]
    kind: String,
    protocol: u32,
    device: DeviceCredentials,
    connector: ConnectorInfo,
    extension: ExtensionInfo,
    #[serde(default)]
    instance: InstanceInfo,
    #[serde(default)]
    browser: BrowserInfo,
    /// The relay's access code, for adding a new browser.
    #[serde(default)]
    registration: Registration,
}

/// Page-chosen strings never reach the relay, but labels and versions come from
/// whoever connects: keep them short and printable.
fn short(s: &str, max: usize) -> String {
    s.chars().filter(|c| !c.is_control()).take(max).collect()
}

// ----- one live extension connection --------------------------------------------------

type Waiters = Mutex<HashMap<u64, oneshot::Sender<Result<Value, ErrorBody>>>>;

struct DeviceConn {
    out: mpsc::Sender<String>,
    waiters: Waiters,
    next_id: AtomicU64,
    next_session: AtomicU64,
    closed: AtomicBool,
    /** Ends the socket's read loop (the connection was replaced). */
    shutdown: CancellationToken,
    welcome: Welcome,
}

fn offline() -> ErrorBody {
    ErrorBody::new(codes::HOST_NOT_RUNNING, "The user's browser is not connected to the UABC relay right now.")
        .with_hint("Ask the user to open Chrome; remote access must be turned on in the UABC extension's settings.")
}

impl DeviceConn {
    fn send(&self, msg: &ToExtension) -> Result<(), ErrorBody> {
        if self.closed.load(Ordering::SeqCst) {
            return Err(offline());
        }
        let text = serde_json::to_string(msg).map_err(|e| ErrorBody::new(codes::INTERNAL, e.to_string()))?;
        self.out.try_send(text).map_err(|e| {
            if matches!(e, mpsc::error::TrySendError::Full(_)) {
                // The browser stopped reading; drop it rather than queue without bound.
                tracing::warn!("a browser is not reading its commands; disconnecting it");
                self.close();
            }
            offline()
        })
    }

    fn close(&self) {
        self.closed.store(true, Ordering::SeqCst);
        self.shutdown.cancel();
        for (_, tx) in self.waiters.lock().unwrap().drain() {
            let _ = tx.send(Err(ErrorBody::new(
                codes::EXTENSION_DISCONNECTED,
                "The browser disconnected from the relay while this action was running.",
            )
            .with_hint("Check the page with browser_get_state once the browser is back.")));
        }
    }

    fn resolve(&self, resp: Response_) {
        if let Some(tx) = self.waiters.lock().unwrap().remove(&resp.id) {
            let _ = tx.send(resp.into_result());
        }
    }

    async fn request(
        &self,
        session: &str,
        method: &str,
        params: Value,
        timeout: Duration,
        cancel: &CancellationToken,
    ) -> Result<Value, ErrorBody> {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = oneshot::channel();
        self.waiters.lock().unwrap().insert(id, tx);
        if let Err(e) = self.send(&ToExtension::Request { id, session: session.into(), method: method.into(), params })
        {
            self.waiters.lock().unwrap().remove(&id);
            return Err(e);
        }
        tokio::select! {
            res = tokio::time::timeout(timeout, rx) => match res {
                Ok(Ok(result)) => result,
                Ok(Err(_)) => Err(offline()),
                Err(_) => {
                    self.abandon(id);
                    Err(ErrorBody::new(codes::TIMEOUT, format!("`{method}` did not finish within {}s.", timeout.as_secs()))
                        .with_hint("The page may be slow or waiting for the user. Check with browser_get_state."))
                }
            },
            _ = cancel.cancelled() => {
                self.abandon(id);
                Err(ErrorBody::new(codes::TIMEOUT, "cancelled by the client"))
            }
        }
    }

    fn abandon(&self, id: u64) {
        self.waiters.lock().unwrap().remove(&id);
        let _ = self.send(&ToExtension::Cancel { id });
    }
}

type Response_ = crate::proto::Response;

/// One remote AI client's session in the extension, on one connection.
struct DeviceLink {
    conn: Arc<DeviceConn>,
    session: String,
}

impl Link for DeviceLink {
    fn request<'a>(
        &'a self,
        method: &'a str,
        params: Value,
        timeout: Duration,
        cancel: &'a CancellationToken,
    ) -> BoxFuture<'a, Result<Value, ErrorBody>> {
        Box::pin(self.conn.request(&self.session, method, params, timeout, cancel))
    }
    fn is_closed(&self) -> bool {
        self.conn.closed.load(Ordering::SeqCst)
    }
    fn welcome(&self) -> &Welcome {
        &self.conn.welcome
    }
}

impl Drop for DeviceLink {
    fn drop(&mut self) {
        let _ = self.conn.send(&ToExtension::SessionClose { session: self.session.clone() });
    }
}

// ----- devices ---------------------------------------------------------------------------

struct Device {
    conn: Mutex<Option<Arc<DeviceConn>>>,
    service: StreamableHttpService<UabcServer, LocalSessionManager>,
}

impl Device {
    fn live(&self) -> Option<Arc<DeviceConn>> {
        self.conn.lock().unwrap().clone().filter(|c| !c.closed.load(Ordering::SeqCst))
    }
}

struct DeviceConnector {
    device: Weak<Device>,
}

impl Connector for DeviceConnector {
    fn connect(&self, client: ClientInfo) -> BoxFuture<'_, Result<Arc<dyn Link>, ErrorBody>> {
        Box::pin(async move {
            let conn = self.device.upgrade().and_then(|d| d.live()).ok_or_else(offline)?;
            let session = format!("r{}", conn.next_session.fetch_add(1, Ordering::Relaxed) + 1);
            // The user sees this name in site prompts and the toolbar popup.
            let client = ClientInfo { name: format!("{} (remote)", client.name), version: client.version };
            conn.send(&ToExtension::SessionOpen { session: session.clone(), client })?;
            Ok(Arc::new(DeviceLink { conn, session }) as Arc<dyn Link>)
        })
    }

    fn idle_limit(&self) -> Option<Duration> {
        Some(REMOTE_SESSION_IDLE)
    }
}

// ----- the relay ---------------------------------------------------------------------------

pub struct Relay {
    store: Mutex<Store>,
    store_path: PathBuf,
    /// The store changed since it was last written.
    dirty: AtomicBool,
    devices: Mutex<HashMap<String, Arc<Device>>>,
    registrations: Mutex<HashMap<IpAddr, Vec<Instant>>>,
    pending_hellos: Arc<Semaphore>,
    allow_any_origin: bool,
    registration_token: Option<String>,
}

impl Relay {
    fn open(opts: &RelayOptions) -> anyhow::Result<Relay> {
        paths::ensure_private_dir(&opts.data_dir)?;
        let store_path = opts.data_dir.join("devices.json");
        let store = match std::fs::read(&store_path) {
            Ok(bytes) => serde_json::from_slice(&bytes)?,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Store::default(),
            Err(e) => return Err(e.into()),
        };
        Ok(Relay {
            store: Mutex::new(store),
            store_path,
            dirty: AtomicBool::new(false),
            devices: Mutex::default(),
            registrations: Mutex::default(),
            pending_hellos: Arc::new(Semaphore::new(MAX_PENDING_HELLOS)),
            allow_any_origin: opts.allow_any_origin,
            registration_token: opts.registration_token.clone().filter(|t| !t.is_empty()),
        })
    }

    /// Forgets devices that have not connected for [`DEVICE_TTL`] and are offline.
    fn expire(&self) {
        let cutoff = now().saturating_sub(DEVICE_TTL.as_secs());
        let online: Vec<String> =
            self.devices.lock().unwrap().iter().filter(|(_, d)| d.live().is_some()).map(|(id, _)| id.clone()).collect();
        let mut store = self.store.lock().unwrap();
        let before = store.devices.len();
        store.devices.retain(|id, rec| rec.last_seen >= cutoff || online.contains(id));
        if store.devices.len() != before {
            tracing::info!(forgotten = before - store.devices.len(), "forgot devices not seen for 30 days");
            self.dirty.store(true, Ordering::SeqCst);
        }
    }

    /// Writes the device records if they changed (never while holding the lock for I/O).
    fn flush(&self) {
        if !self.dirty.swap(false, Ordering::SeqCst) {
            return;
        }
        let bytes = match serde_json::to_vec_pretty(&*self.store.lock().unwrap()) {
            Ok(bytes) => bytes,
            Err(e) => return tracing::error!(error = %e, "could not serialize the device list"),
        };
        let tmp = self.store_path.with_extension("json.tmp");
        let written = std::fs::write(&tmp, bytes).and_then(|()| {
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o600))?;
            }
            std::fs::rename(&tmp, &self.store_path)
        });
        if let Err(e) = written {
            self.dirty.store(true, Ordering::SeqCst); // try again next time
            tracing::error!(error = %e, "could not save the device list");
        }
    }

    /// The runtime object of a device, with its own MCP service and client state.
    fn device(&self, id: &str) -> Arc<Device> {
        let mut devices = self.devices.lock().unwrap();
        devices
            .entry(id.to_owned())
            .or_insert_with(|| {
                Arc::new_cyclic(|weak: &Weak<Device>| {
                    let connector: Arc<dyn Connector> = Arc::new(DeviceConnector { device: weak.clone() });
                    // Client state lives per device and client name: HTTP clients
                    // may use a fresh server instance for every request.
                    let states = States::PerClient(Arc::default());
                    // The secret URL is the credential, so Host and Origin
                    // checks (DNS-rebinding protection for local servers) are off.
                    let config = StreamableHttpServerConfig::default()
                        .disable_allowed_hosts()
                        .disable_allowed_origins()
                        .with_json_response(true);
                    let service = StreamableHttpService::new(
                        move || Ok(UabcServer::with(connector.clone(), states.clone())),
                        Arc::new(LocalSessionManager::default()),
                        config,
                    );
                    Device { conn: Mutex::default(), service }
                })
            })
            .clone()
    }

    /// Checks a device's credentials, registering unknown devices (trust on first use).
    fn authenticate(&self, hello: &RelayHello, ip: IpAddr) -> Result<Arc<Device>, ErrorBody> {
        let refuse = |message: &str| ErrorBody::new("UNAUTHORIZED", message);
        if hello.kind != "hello" || hello.protocol != PROTOCOL {
            return Err(ErrorBody::new(
                codes::PROTOCOL_MISMATCH,
                format!("This relay speaks protocol {PROTOCOL}; update UABC."),
            ));
        }
        let id = hello.device.id.as_str();
        if !valid_device_id(id) || !is_hex(&hello.device.secret, 64) || !is_hex(&hello.connector.sha256, 64) {
            return Err(refuse("Malformed device credentials."));
        }
        let secret_sha256 = sha256_hex(&hello.device.secret);
        let label = short(&hello.instance.label, MAX_LABEL);
        let mut store = self.store.lock().unwrap();
        match store.devices.get_mut(id) {
            Some(rec) if !same(&rec.secret_sha256, &secret_sha256) => {
                return Err(refuse("This device id is registered with a different secret."));
            }
            Some(rec) => {
                // Write only real changes (and refresh last_seen about daily), not every reconnect.
                let changed = rec.connector_sha256 != hello.connector.sha256
                    || rec.label != label
                    || now().saturating_sub(rec.last_seen) > 86_400;
                rec.connector_sha256.clone_from(&hello.connector.sha256);
                rec.label = label;
                rec.last_seen = now();
                if changed {
                    self.dirty.store(true, Ordering::SeqCst);
                }
            }
            None => {
                if let Some(expected) = &self.registration_token
                    && !same(&sha256_hex(expected), &sha256_hex(&hello.registration.token))
                {
                    return Err(refuse("This relay needs the right access code to add a browser."));
                }
                if store.devices.len() >= MAX_DEVICES {
                    return Err(refuse("This relay has no room for new devices."));
                }
                let mut regs = self.registrations.lock().unwrap();
                let recent = regs.entry(ip).or_default();
                recent.retain(|t| t.elapsed() < Duration::from_secs(3600));
                if recent.len() >= REGISTRATIONS_PER_HOUR {
                    return Err(refuse("Too many new devices from this address; try again later."));
                }
                recent.push(Instant::now());
                store.devices.insert(
                    id.to_owned(),
                    DeviceRecord {
                        secret_sha256,
                        connector_sha256: hello.connector.sha256.clone(),
                        label,
                        created: now(),
                        last_seen: now(),
                    },
                );
                self.dirty.store(true, Ordering::SeqCst);
                tracing::info!(device = &id[..8], "registered a new device");
            }
        }
        drop(store);
        Ok(self.device(id))
    }

    /// The device behind a connector URL, or None (callers answer 404 either way).
    fn authorize(&self, id: &str, secret: &str) -> Option<Arc<Device>> {
        if !valid_device_id(id) || !is_hex(secret, 64) {
            return None;
        }
        let hash = sha256_hex(secret);
        let ok = self.store.lock().unwrap().devices.get(id).is_some_and(|rec| same(&rec.connector_sha256, &hash));
        ok.then(|| self.device(id))
    }

    fn online(&self) -> usize {
        self.devices.lock().unwrap().values().filter(|d| d.live().is_some()).count()
    }

    async fn serve_socket(self: Arc<Self>, socket: WebSocket, ip: IpAddr, pending: OwnedSemaphorePermit) {
        let (mut sink, mut stream) = socket.split();
        let reject = |error: ErrorBody| {
            serde_json::to_string(&ToExtension::Error { error }).map(|t| Message::Text(t.into())).ok()
        };
        let hello = match tokio::time::timeout(HELLO_TIMEOUT, stream.next()).await {
            Ok(Some(Ok(Message::Text(text)))) if text.len() <= MAX_HELLO => serde_json::from_str::<RelayHello>(&text),
            _ => return,
        };
        let hello = match hello {
            Ok(h) => h,
            Err(e) => {
                if let Some(m) = reject(ErrorBody::new(codes::INVALID_PARAMS, format!("Bad hello: {e}"))) {
                    let _ = sink.send(m).await;
                }
                return;
            }
        };
        let device = match self.authenticate(&hello, ip) {
            Ok(d) => d,
            Err(error) => {
                tracing::warn!(device = %hello.device.id.chars().take(8).collect::<String>(), code = %error.code, "refused a browser");
                if let Some(m) = reject(error) {
                    let _ = sink.send(m).await;
                }
                return;
            }
        };
        drop(pending);

        let (out, mut out_rx) = mpsc::channel::<String>(OUT_QUEUE);
        let conn = Arc::new(DeviceConn {
            out,
            waiters: Mutex::default(),
            next_id: AtomicU64::new(1),
            next_session: AtomicU64::new(0),
            closed: AtomicBool::new(false),
            shutdown: CancellationToken::new(),
            welcome: Welcome {
                protocol: PROTOCOL,
                session: String::new(),
                instance: InstanceInfo {
                    id: short(&hello.instance.id, 32),
                    label: short(&hello.instance.label, MAX_LABEL),
                },
                host: HostInfo { version: VERSION.into(), pid: std::process::id(), endpoint: None },
                extension: ExtensionInfo {
                    id: short(&hello.extension.id, 64),
                    version: short(&hello.extension.version, 32),
                },
                browser: BrowserInfo {
                    name: short(&hello.browser.name, 40),
                    version: short(&hello.browser.version, 40),
                },
            },
        });
        let _ = conn.send(&ToExtension::Welcome { protocol: PROTOCOL, host: conn.welcome.host.clone() });
        // A newer connection of the same browser replaces the old one.
        if let Some(old) = device.conn.lock().unwrap().replace(conn.clone()) {
            old.close();
        }
        tracing::info!(device = &hello.device.id[..8], "browser connected");

        let writer = tokio::spawn(async move {
            while let Some(text) = out_rx.recv().await {
                if sink.send(Message::Text(text.into())).await.is_err() {
                    break;
                }
            }
            let _ = sink.close().await;
        });
        loop {
            let next = tokio::select! {
                next = tokio::time::timeout(IDLE_TIMEOUT, stream.next()) => next,
                _ = conn.shutdown.cancelled() => break,
            };
            match next {
                Ok(Some(Ok(Message::Text(text)))) => match serde_json::from_str::<FromExtension>(&text) {
                    Ok(FromExtension::Response(resp)) => conn.resolve(resp),
                    Ok(FromExtension::Ping) => {
                        let _ = conn.send(&ToExtension::Pong);
                    }
                    Ok(_) => {}
                    Err(e) => tracing::debug!(error = %e, "ignoring a malformed message"),
                },
                Ok(Some(Ok(Message::Close(_)) | Err(_)) | None) | Err(_) => break,
                Ok(Some(Ok(_))) => {} // binary, ping and pong frames
            }
        }
        conn.close();
        writer.abort();
        let mut slot = device.conn.lock().unwrap();
        if slot.as_ref().is_some_and(|c| Arc::ptr_eq(c, &conn)) {
            *slot = None;
        }
        tracing::info!(device = &hello.device.id[..8], "browser disconnected");
    }
}

// ----- HTTP ------------------------------------------------------------------------------------

async fn ws_handler(
    State(relay): State<Arc<Relay>>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    ws: WebSocketUpgrade,
) -> Response {
    // Only browser extensions connect here; a web page must not be able to register devices.
    let origin = headers.get(header::ORIGIN).and_then(|v| v.to_str().ok()).unwrap_or("");
    if !relay.allow_any_origin && !origin.starts_with("chrome-extension://") {
        return (StatusCode::FORBIDDEN, "Only the UABC browser extension connects here.").into_response();
    }
    let Ok(pending) = relay.pending_hellos.clone().try_acquire_owned() else {
        return (StatusCode::SERVICE_UNAVAILABLE, "Busy; try again shortly.").into_response();
    };
    ws.max_message_size(MAX_MESSAGE).on_upgrade(move |socket| relay.serve_socket(socket, addr.ip(), pending))
}

async fn mcp_handler(
    State(relay): State<Arc<Relay>>,
    Path((id, secret)): Path<(String, String)>,
    req: Request,
) -> Response {
    // Unknown device and wrong secret look the same.
    let Some(device) = relay.authorize(&id, &secret) else {
        return (StatusCode::NOT_FOUND, "Not found").into_response();
    };
    device.service.handle(req).await.map(Body::new)
}

async fn health(State(relay): State<Arc<Relay>>) -> Response {
    let body = json!({"ok": true, "version": VERSION, "devices_online": relay.online()}).to_string();
    ([(header::CONTENT_TYPE, "application/json")], body).into_response()
}

async fn index() -> &'static str {
    "UABC relay. Browsers connect at /ws; AI apps use the connector URL shown in the UABC extension's settings.\n"
}

pub fn router(relay: Arc<Relay>) -> Router {
    Router::new()
        .route("/", get(index))
        .route("/healthz", get(health))
        .route("/ws", get(ws_handler))
        .route("/mcp/{id}/{secret}", any(mcp_handler))
        .with_state(relay)
}

pub async fn run(opts: RelayOptions) -> anyhow::Result<()> {
    let relay = Arc::new(Relay::open(&opts)?);
    relay.expire();
    let listener = tokio::net::TcpListener::bind(opts.listen).await?;
    // Tests and scripts read the actual address (port 0 picks a free one).
    println!("UABC relay listening on http://{}", listener.local_addr()?);
    if relay.registration_token.is_none() {
        tracing::info!("anyone who can reach /ws may add a browser; use --registration-token for a private relay");
    }
    let flusher = {
        let relay = relay.clone();
        tokio::spawn(async move {
            let mut tick = tokio::time::interval(FLUSH_EVERY);
            loop {
                tick.tick().await;
                relay.expire();
                let relay = relay.clone();
                let _ = tokio::task::spawn_blocking(move || relay.flush()).await;
            }
        })
    };
    axum::serve(listener, router(relay.clone()).into_make_service_with_connect_info::<SocketAddr>())
        .with_graceful_shutdown(async {
            let _ = tokio::signal::ctrl_c().await;
        })
        .await?;
    flusher.abort();
    relay.flush();
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn relay() -> (Relay, tempfile::TempDir) {
        let dir = tempfile::tempdir().unwrap();
        let opts = RelayOptions {
            listen: "127.0.0.1:0".parse().unwrap(),
            data_dir: dir.path().to_owned(),
            allow_any_origin: false,
            registration_token: None,
        };
        (Relay::open(&opts).unwrap(), dir)
    }

    fn hello(id: &str, secret: &str, connector: &str) -> RelayHello {
        serde_json::from_value(json!({
            "type": "hello", "protocol": PROTOCOL,
            "device": {"id": id, "secret": secret},
            "connector": {"sha256": sha256_hex(connector)},
            "extension": {"id": "ext", "version": "0.2.0"},
            "instance": {"id": "abc", "label": "Work"},
        }))
        .unwrap()
    }

    const ID: &str = "0123456789abcdef0123456789abcdef";
    const IP: IpAddr = IpAddr::V4(std::net::Ipv4Addr::LOCALHOST);
    fn secret(c: char) -> String {
        std::iter::repeat_n(c, 64).collect()
    }

    #[test]
    fn devices_register_once_and_keep_their_secret() {
        let (r, dir) = relay();
        assert!(r.authenticate(&hello(ID, &secret('a'), &secret('c')), IP).is_ok());
        let err = r.authenticate(&hello(ID, &secret('b'), &secret('c')), IP).err().unwrap();
        assert_eq!(err.code, "UNAUTHORIZED");
        r.flush();
        // Only hashes reach the disk.
        let saved = std::fs::read_to_string(dir.path().join("devices.json")).unwrap();
        assert!(!saved.contains(&secret('a')) && !saved.contains(&secret('c')));
        assert!(saved.contains(&sha256_hex(&secret('a'))));
        // And they survive a restart.
        let opts = RelayOptions {
            listen: "127.0.0.1:0".parse().unwrap(),
            data_dir: dir.path().to_owned(),
            allow_any_origin: false,
            registration_token: None,
        };
        let again = Relay::open(&opts).unwrap();
        assert!(again.authenticate(&hello(ID, &secret('b'), &secret('c')), IP).is_err());
        assert!(again.authenticate(&hello(ID, &secret('a'), &secret('c')), IP).is_ok());
    }

    #[test]
    fn the_connector_secret_opens_only_its_own_device_and_rotation_revokes_it() {
        let (r, _dir) = relay();
        r.authenticate(&hello(ID, &secret('a'), &secret('1')), IP).unwrap();
        assert!(r.authorize(ID, &secret('1')).is_some());
        assert!(r.authorize(ID, &secret('2')).is_none());
        assert!(r.authorize("fedcba9876543210fedcba9876543210", &secret('1')).is_none());
        assert!(r.authorize("../../etc", &secret('1')).is_none());
        // The extension rotates its connector secret: the old URL stops working.
        r.authenticate(&hello(ID, &secret('a'), &secret('2')), IP).unwrap();
        assert!(r.authorize(ID, &secret('1')).is_none());
        assert!(r.authorize(ID, &secret('2')).is_some());
    }

    #[test]
    fn malformed_credentials_and_registration_floods_are_refused() {
        let (r, _dir) = relay();
        assert!(r.authenticate(&hello("NOT-HEX", &secret('a'), &secret('c')), IP).is_err());
        assert!(r.authenticate(&hello(ID, "short", &secret('c')), IP).is_err());
        for i in 0..REGISTRATIONS_PER_HOUR {
            let id = format!("{i:032x}");
            assert!(r.authenticate(&hello(&id, &secret('a'), &secret('c')), IP).is_ok());
        }
        let err = r.authenticate(&hello(&format!("{:032x}", 999), &secret('a'), &secret('c')), IP).err().unwrap();
        assert!(err.message.contains("Too many new devices"));
        // Known devices can always reconnect.
        assert!(r.authenticate(&hello(&format!("{:032x}", 0), &secret('a'), &secret('c')), IP).is_ok());
    }

    #[test]
    fn reconnecting_does_not_rewrite_the_store_and_labels_are_capped() {
        let (r, _dir) = relay();
        let mut h = hello(ID, &secret('a'), &secret('c'));
        h.instance.label = "x".repeat(10_000);
        r.authenticate(&h, IP).unwrap();
        r.flush();
        assert_eq!(r.store.lock().unwrap().devices[ID].label.len(), MAX_LABEL);
        r.authenticate(&h, IP).unwrap();
        assert!(!r.dirty.load(Ordering::SeqCst), "an unchanged reconnect must not schedule a write");
    }

    #[test]
    fn an_access_code_guards_new_browsers_only() {
        let dir = tempfile::tempdir().unwrap();
        let opts = RelayOptions {
            listen: "127.0.0.1:0".parse().unwrap(),
            data_dir: dir.path().to_owned(),
            allow_any_origin: false,
            registration_token: Some("letmein".into()),
        };
        let r = Relay::open(&opts).unwrap();
        let mut h = hello(ID, &secret('a'), &secret('c'));
        assert!(r.authenticate(&h, IP).err().unwrap().message.contains("access code"));
        h.registration.token = "letmein".into();
        assert!(r.authenticate(&h, IP).is_ok());
        // Once registered, the device secret is enough.
        h.registration.token.clear();
        assert!(r.authenticate(&h, IP).is_ok());
    }

    #[test]
    fn devices_unseen_for_a_month_are_forgotten() {
        let (r, _dir) = relay();
        r.authenticate(&hello(ID, &secret('a'), &secret('1')), IP).unwrap();
        r.store.lock().unwrap().devices.get_mut(ID).unwrap().last_seen = 0;
        r.expire();
        assert!(r.authorize(ID, &secret('1')).is_none());
        // Its next visit simply registers it again.
        assert!(r.authenticate(&hello(ID, &secret('a'), &secret('1')), IP).is_ok());
    }

    #[tokio::test]
    async fn tools_fail_cleanly_while_the_browser_is_offline() {
        let (r, _dir) = relay();
        r.authenticate(&hello(ID, &secret('a'), &secret('1')), IP).unwrap();
        let device = r.authorize(ID, &secret('1')).unwrap();
        let connector = DeviceConnector { device: Arc::downgrade(&device) };
        let err = connector.connect(ClientInfo::default()).await.err().unwrap();
        assert_eq!(err.code, codes::HOST_NOT_RUNNING);
    }
}
