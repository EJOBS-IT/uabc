//! Chrome native messaging framing: a `u32` length in native byte order
//! followed by that many bytes of UTF-8 JSON.
//! <https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging>

use std::io;

use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};

/// Chrome accepts up to 64 MiB from the extension (screenshots can be large).
pub const MAX_FROM_BROWSER: usize = 64 * 1024 * 1024;
/// Chrome rejects host → extension messages above 1 MiB and closes the port.
pub const MAX_TO_BROWSER: usize = 1024 * 1024;

/// Reads one message. `Ok(None)` means the browser closed the port.
pub async fn read_message<R: AsyncRead + Unpin>(reader: &mut R) -> io::Result<Option<Vec<u8>>> {
    let mut len = [0u8; 4];
    match reader.read_exact(&mut len).await {
        Ok(_) => {}
        Err(e) if e.kind() == io::ErrorKind::UnexpectedEof => return Ok(None),
        Err(e) => return Err(e),
    }
    let len = u32::from_ne_bytes(len) as usize;
    if len > MAX_FROM_BROWSER {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            format!("native message of {len} bytes exceeds the {MAX_FROM_BROWSER} byte limit"),
        ));
    }
    let mut buf = vec![0u8; len];
    reader.read_exact(&mut buf).await?;
    Ok(Some(buf))
}

/// Writes one message. Oversized payloads are refused *before* anything is
/// written, because Chrome would otherwise tear down the whole port.
pub async fn write_message<W: AsyncWrite + Unpin>(writer: &mut W, payload: &[u8]) -> io::Result<()> {
    check_outgoing_size(payload.len())?;
    writer.write_all(&(payload.len() as u32).to_ne_bytes()).await?;
    writer.write_all(payload).await?;
    writer.flush().await
}

pub fn check_outgoing_size(len: usize) -> io::Result<()> {
    if len > MAX_TO_BROWSER {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            format!("message of {len} bytes exceeds Chrome's {MAX_TO_BROWSER} byte host→extension limit"),
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn round_trips_messages() {
        let mut wire = Vec::new();
        write_message(&mut wire, br#"{"type":"hello"}"#).await.unwrap();
        write_message(&mut wire, "{\"t\":\"বাংলা\"}".as_bytes()).await.unwrap();

        let mut r = wire.as_slice();
        assert_eq!(read_message(&mut r).await.unwrap().unwrap(), br#"{"type":"hello"}"#);
        assert_eq!(read_message(&mut r).await.unwrap().unwrap(), "{\"t\":\"বাংলা\"}".as_bytes());
        assert!(read_message(&mut r).await.unwrap().is_none(), "EOF is a clean close");
    }

    #[tokio::test]
    async fn refuses_oversized_outgoing_message_without_writing() {
        let mut wire = Vec::new();
        let big = vec![b' '; MAX_TO_BROWSER + 1];
        assert!(write_message(&mut wire, &big).await.is_err());
        assert!(wire.is_empty());
    }

    #[tokio::test]
    async fn rejects_absurd_incoming_length() {
        let wire = ((MAX_FROM_BROWSER + 1) as u32).to_ne_bytes();
        let err = read_message(&mut wire.as_slice()).await.unwrap_err();
        assert_eq!(err.kind(), io::ErrorKind::InvalidData);
    }
}
