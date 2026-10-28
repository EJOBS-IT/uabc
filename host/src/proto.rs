//! Wire types for the IPC hop (B) and the native-messaging hop (C).
//! The authoritative description lives in `docs/protocol.md`.

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// Bumped only on breaking changes to hops B or C.
pub const PROTOCOL: u32 = 1;
pub const VERSION: &str = env!("CARGO_PKG_VERSION");
/// Name under which the native messaging host is registered with the browser.
pub const NATIVE_HOST_NAME: &str = "com.ejobsit.uabc";

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct ClientInfo {
    pub name: String,
    #[serde(default)]
    pub version: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ExtensionInfo {
    pub id: String,
    pub version: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct InstanceInfo {
    pub id: String,
    #[serde(default)]
    pub label: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct BrowserInfo {
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub version: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct HostInfo {
    pub version: String,
    pub pid: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub endpoint: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ErrorBody {
    pub code: String,
    pub message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hint: Option<String>,
    /// The message quotes page-controlled text (element names, page-chosen hosts).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub page_text: Option<bool>,
}

impl ErrorBody {
    pub fn new(code: &str, message: impl Into<String>) -> Self {
        Self { code: code.to_owned(), message: message.into(), hint: None, page_text: None }
    }

    pub fn with_hint(mut self, hint: impl Into<String>) -> Self {
        self.hint = Some(hint.into());
        self
    }
}

impl std::fmt::Display for ErrorBody {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.code, self.message)
    }
}

impl std::error::Error for ErrorBody {}

/// Error codes shared with the extension (`extension/src/shared/protocol.ts`).
pub mod codes {
    pub const HOST_NOT_RUNNING: &str = "HOST_NOT_RUNNING";
    pub const EXTENSION_DISCONNECTED: &str = "EXTENSION_DISCONNECTED";
    pub const PROTOCOL_MISMATCH: &str = "PROTOCOL_MISMATCH";
    pub const TIMEOUT: &str = "TIMEOUT";
    pub const INVALID_PARAMS: &str = "INVALID_PARAMS";
    pub const INTERNAL: &str = "INTERNAL";
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Response {
    pub id: u64,
    pub ok: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub result: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<ErrorBody>,
}

impl Response {
    pub fn err(id: u64, error: ErrorBody) -> Self {
        Self { id, ok: false, result: None, error: Some(error) }
    }

    pub fn into_result(self) -> Result<Value, ErrorBody> {
        if self.ok {
            Ok(self.result.unwrap_or(Value::Null))
        } else {
            Err(self.error.unwrap_or_else(|| ErrorBody::new(codes::INTERNAL, "error response without details")))
        }
    }
}

/// Hop B: messages on the local IPC endpoint (one JSON object per line).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum IpcMessage {
    Hello {
        protocol: u32,
        client: ClientInfo,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pid: Option<u32>,
    },
    Welcome(Box<Welcome>),
    Error {
        error: ErrorBody,
    },
    Request {
        id: u64,
        method: String,
        #[serde(default)]
        params: Value,
    },
    Response(Response),
    Cancel {
        id: u64,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Welcome {
    pub protocol: u32,
    pub session: String,
    pub instance: InstanceInfo,
    pub host: HostInfo,
    pub extension: ExtensionInfo,
    #[serde(default)]
    pub browser: BrowserInfo,
}

/// Hop C, extension → host.
#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum FromExtension {
    Hello {
        protocol: u32,
        extension: ExtensionInfo,
        instance: InstanceInfo,
        #[serde(default)]
        browser: BrowserInfo,
    },
    Response(Response),
    /// Keepalive (relay connections only; MV3 service workers need traffic to stay alive).
    Ping,
    /// Forward compatibility: unknown message types are ignored.
    #[serde(other)]
    Unknown,
}

/// Hop C, host → extension.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type")]
pub enum ToExtension {
    #[serde(rename = "welcome")]
    Welcome { protocol: u32, host: HostInfo },
    #[serde(rename = "session.open")]
    SessionOpen { session: String, client: ClientInfo },
    #[serde(rename = "session.close")]
    SessionClose { session: String },
    #[serde(rename = "request")]
    Request { id: u64, session: String, method: String, params: Value },
    #[serde(rename = "cancel")]
    Cancel { id: u64 },
    /// Relay only: the connection is refused (bad device secret, limits); the relay closes it next.
    #[serde(rename = "error")]
    Error { error: ErrorBody },
    /// Relay only: answer to the extension's keepalive.
    #[serde(rename = "pong")]
    Pong,
}

/// Discovery record written by every running host to `<UABC_HOME>/instances/<id>.json`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InstanceDescriptor {
    pub instance_id: String,
    #[serde(default)]
    pub label: String,
    pub pid: u32,
    pub endpoint: String,
    pub extension_id: String,
    pub extension_version: String,
    #[serde(default)]
    pub browser: String,
    pub host_version: String,
    pub started_at: u64,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn ipc_messages_use_documented_shape() {
        let hello = IpcMessage::Hello {
            protocol: 1,
            client: ClientInfo { name: "claude-code".into(), version: "2.1.0".into() },
            pid: None,
        };
        assert_eq!(
            serde_json::to_value(&hello).unwrap(),
            json!({"type":"hello","protocol":1,"client":{"name":"claude-code","version":"2.1.0"}})
        );

        let resp: IpcMessage = serde_json::from_value(json!({
            "type":"response","id":7,"ok":false,
            "error":{"code":"OBSCURED","message":"covered","hint":"dismiss it"}
        }))
        .unwrap();
        let IpcMessage::Response(r) = resp else { panic!("expected response") };
        assert_eq!(r.into_result().unwrap_err().code, "OBSCURED");
    }

    #[test]
    fn extension_messages_tolerate_unknown_types_and_fields() {
        let m: FromExtension = serde_json::from_value(json!({"type":"telemetry.v9","whatever":1})).unwrap();
        assert!(matches!(m, FromExtension::Unknown));

        let m: FromExtension = serde_json::from_value(json!({
            "type":"hello","protocol":1,"future_field":true,
            "extension":{"id":"abc","version":"0.1.0"},
            "instance":{"id":"a1b2c3d4e5f6","label":"Work"}
        }))
        .unwrap();
        assert!(matches!(m, FromExtension::Hello { protocol: 1, .. }));
    }

    #[test]
    fn host_to_extension_names_are_dotted() {
        let open = ToExtension::SessionOpen { session: "s1".into(), client: ClientInfo::default() };
        assert_eq!(serde_json::to_value(&open).unwrap()["type"], "session.open");
    }
}
