//! IPC client (hop B) used by `uabc mcp`, `uabc status` and `uabc call`.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use futures::StreamExt;
use serde_json::Value;
use tokio::io::AsyncWriteExt;
use tokio::sync::{mpsc, oneshot};
use tokio_util::codec::{FramedRead, LinesCodec};
use tokio_util::sync::CancellationToken;

use crate::host::MAX_LINE;
use crate::ipc;
use crate::paths;
use crate::proto::*;

type Waiters = Arc<Mutex<HashMap<u64, oneshot::Sender<Result<Value, ErrorBody>>>>>;

/// One connection to a running host, i.e. to one browser profile.
pub struct Bridge {
    out: mpsc::UnboundedSender<String>,
    waiters: Waiters,
    next_id: AtomicU64,
    closed: Arc<AtomicBool>,
    pub welcome: Welcome,
}

/// Running hosts, newest first.
pub fn list_instances() -> Vec<InstanceDescriptor> {
    let mut found: Vec<InstanceDescriptor> = std::fs::read_dir(paths::instances_dir())
        .into_iter()
        .flatten()
        .flatten()
        .filter(|e| e.path().extension().is_some_and(|x| x == "json"))
        .filter_map(|e| serde_json::from_slice(&std::fs::read(e.path()).ok()?).ok())
        .collect();
    found.sort_by_key(|i| std::cmp::Reverse(i.started_at));
    found
}

fn host_not_running(detail: &str) -> ErrorBody {
    ErrorBody::new(codes::HOST_NOT_RUNNING, format!("No browser is connected to UABC ({detail}).")).with_hint(
        "Ask the user to open Chrome with the UABC extension enabled. If they just installed it, \
             they also need to run `uabc install` once; `uabc status` shows what is missing.",
    )
}

impl Bridge {
    /// Connects to the newest running host, or to the one whose instance id or
    /// label matches `target`.
    pub async fn connect(target: Option<&str>, client: ClientInfo) -> Result<Bridge, ErrorBody> {
        let candidates: Vec<_> = list_instances()
            .into_iter()
            .filter(|i| target.is_none_or(|t| i.instance_id == t || i.label.eq_ignore_ascii_case(t)))
            .collect();
        if candidates.is_empty() {
            return Err(host_not_running(
                match target {
                    Some(t) => format!("no running browser profile named {t:?}"),
                    None => "no running browser bridge found".into(),
                }
                .as_str(),
            ));
        }
        let mut last = String::new();
        for instance in candidates {
            match tokio::time::timeout(Duration::from_secs(3), ipc::connect(&instance.endpoint)).await {
                Ok(Ok(stream)) => match Self::handshake(stream, client.clone()).await {
                    Ok(bridge) => return Ok(bridge),
                    Err(e) if e.code == codes::PROTOCOL_MISMATCH => return Err(e),
                    Err(e) => last = e.message,
                },
                Ok(Err(e)) => last = format!("{}: {e}", instance.endpoint),
                Err(_) => last = format!("{}: timed out", instance.endpoint),
            }
        }
        Err(host_not_running(&format!("stale bridge records; last error: {last}")))
    }

    async fn handshake(stream: ipc::BoxStream, client: ClientInfo) -> Result<Bridge, ErrorBody> {
        let (read_half, mut write_half) = tokio::io::split(stream);
        let mut lines = FramedRead::new(read_half, LinesCodec::new_with_max_length(MAX_LINE));
        let io_err = |e: std::io::Error| host_not_running(&e.to_string());

        let hello = IpcMessage::Hello { protocol: PROTOCOL, client, pid: Some(std::process::id()) };
        let mut line = serde_json::to_string(&hello).expect("serializable");
        line.push('\n');
        write_half.write_all(line.as_bytes()).await.map_err(io_err)?;

        let first = tokio::time::timeout(Duration::from_secs(5), lines.next())
            .await
            .map_err(|_| host_not_running("the bridge did not answer"))?;
        let welcome = match first.map(|l| l.map(|l| serde_json::from_str::<IpcMessage>(&l))) {
            Some(Ok(Ok(IpcMessage::Welcome(w)))) => *w,
            Some(Ok(Ok(IpcMessage::Error { error }))) => return Err(error),
            _ => return Err(host_not_running("unexpected handshake reply")),
        };

        let (out, mut out_rx) = mpsc::unbounded_channel::<String>();
        tokio::spawn(async move {
            while let Some(line) = out_rx.recv().await {
                if write_half.write_all(line.as_bytes()).await.is_err() {
                    break;
                }
            }
        });

        let waiters: Waiters = Arc::default();
        let closed = Arc::new(AtomicBool::new(false));
        let (reader_waiters, reader_closed) = (waiters.clone(), closed.clone());
        tokio::spawn(async move {
            while let Some(Ok(line)) = lines.next().await {
                if let Ok(IpcMessage::Response(resp)) = serde_json::from_str::<IpcMessage>(&line)
                    && let Some(tx) = reader_waiters.lock().unwrap().remove(&resp.id)
                {
                    let _ = tx.send(resp.into_result());
                }
            }
            reader_closed.store(true, Ordering::SeqCst);
            for (_, tx) in reader_waiters.lock().unwrap().drain() {
                let _ = tx.send(Err(ErrorBody::new(
                    codes::EXTENSION_DISCONNECTED,
                    "The browser bridge closed the connection (was the browser closed or the extension reloaded?).",
                )
                .with_hint("Retry; if it keeps failing, ask the user to check the UABC extension.")));
            }
        });

        Ok(Bridge { out, waiters, next_id: AtomicU64::new(1), closed, welcome })
    }

    pub fn is_closed(&self) -> bool {
        self.closed.load(Ordering::SeqCst)
    }

    /// Sends a command and waits for its result, honouring `cancel`.
    pub async fn request(
        &self,
        method: &str,
        params: Value,
        timeout: Duration,
        cancel: &CancellationToken,
    ) -> Result<Value, ErrorBody> {
        if self.is_closed() {
            return Err(host_not_running("connection closed"));
        }
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = oneshot::channel();
        self.waiters.lock().unwrap().insert(id, tx);
        self.send_line(&IpcMessage::Request { id, method: method.into(), params })?;

        tokio::select! {
            res = tokio::time::timeout(timeout, rx) => match res {
                Ok(Ok(result)) => result,
                Ok(Err(_)) => Err(host_not_running("connection closed")),
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
        let _ = self.send_line(&IpcMessage::Cancel { id });
    }

    fn send_line(&self, msg: &IpcMessage) -> Result<(), ErrorBody> {
        let mut line = serde_json::to_string(msg).map_err(|e| ErrorBody::new(codes::INTERNAL, e.to_string()))?;
        line.push('\n');
        self.out.send(line).map_err(|_| host_not_running("connection closed"))
    }
}
