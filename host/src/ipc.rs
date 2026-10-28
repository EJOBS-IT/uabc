//! Local, user-scoped IPC endpoints (hop B). There is deliberately no TCP:
//! the operating system decides who may connect (ADR-0003).
//!
//! * Unix: a domain socket with mode `0600` inside a `0700` directory, plus a
//!   peer-credential check on every accepted connection.
//! * Windows: a named pipe whose DACL grants access only to the current user
//!   (and SYSTEM), with remote (SMB) clients rejected.

use tokio::io::{AsyncRead, AsyncWrite};

pub trait Stream: AsyncRead + AsyncWrite + Unpin + Send + 'static {}
impl<T: AsyncRead + AsyncWrite + Unpin + Send + 'static> Stream for T {}

pub type BoxStream = Box<dyn Stream>;

pub use imp::{Listener, connect};

#[cfg(unix)]
mod imp {
    use std::io;
    use std::os::unix::fs::PermissionsExt;
    use std::path::PathBuf;

    use tokio::net::{UnixListener, UnixStream};

    use super::BoxStream;

    pub struct Listener {
        inner: UnixListener,
        path: PathBuf,
    }

    impl Listener {
        pub fn bind(endpoint: &str) -> io::Result<Self> {
            let path = PathBuf::from(endpoint);
            if let Some(dir) = path.parent() {
                crate::paths::ensure_private_dir(dir)?;
            }
            if path.exists() {
                if std::os::unix::net::UnixStream::connect(&path).is_ok() {
                    return Err(io::Error::new(
                        io::ErrorKind::AddrInUse,
                        "another uabc host is already serving this browser profile",
                    ));
                }
                // Left behind by a host that was killed; nobody is listening.
                std::fs::remove_file(&path)?;
            }
            let inner = UnixListener::bind(&path)?;
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600))?;
            Ok(Self { inner, path })
        }

        pub async fn accept(&self) -> io::Result<BoxStream> {
            // SAFETY: geteuid has no preconditions and cannot fail.
            let me = unsafe { libc::geteuid() };
            loop {
                let (stream, _) = self.inner.accept().await?;
                match stream.peer_cred() {
                    Ok(cred) if cred.uid() == me => return Ok(Box::new(stream)),
                    Ok(cred) => tracing::warn!(uid = cred.uid(), "rejected IPC client owned by another user"),
                    Err(e) => tracing::warn!(error = %e, "rejected IPC client without peer credentials"),
                }
            }
        }
    }

    impl Drop for Listener {
        fn drop(&mut self) {
            let _ = std::fs::remove_file(&self.path);
        }
    }

    pub async fn connect(endpoint: &str) -> io::Result<BoxStream> {
        Ok(Box::new(UnixStream::connect(endpoint).await?))
    }
}

#[cfg(windows)]
mod imp {
    use std::ffi::c_void;
    use std::io;
    use std::ptr::null_mut;
    use std::time::{Duration, Instant};

    use tokio::net::windows::named_pipe::{ClientOptions, NamedPipeServer, ServerOptions};
    use tokio::sync::Mutex;
    use windows_sys::Win32::Foundation::{CloseHandle, ERROR_PIPE_BUSY, HANDLE, LocalFree};
    use windows_sys::Win32::Security::Authorization::{
        ConvertSidToStringSidW, ConvertStringSecurityDescriptorToSecurityDescriptorW, SDDL_REVISION_1,
    };
    use windows_sys::Win32::Security::{
        GetTokenInformation, PSECURITY_DESCRIPTOR, SECURITY_ATTRIBUTES, TOKEN_QUERY, TOKEN_USER, TokenUser,
    };
    use windows_sys::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};

    use super::BoxStream;

    pub struct Listener {
        name: String,
        security: SecurityDescriptor,
        next: Mutex<NamedPipeServer>,
    }

    impl Listener {
        pub fn bind(endpoint: &str) -> io::Result<Self> {
            let security = SecurityDescriptor::current_user_only()?;
            // first_pipe_instance fails if someone else already owns the name.
            let first = security.create(endpoint, true)?;
            Ok(Self { name: endpoint.to_owned(), security, next: Mutex::new(first) })
        }

        pub async fn accept(&self) -> io::Result<BoxStream> {
            let mut next = self.next.lock().await;
            next.connect().await?;
            let fresh = self.security.create(&self.name, false)?;
            Ok(Box::new(std::mem::replace(&mut *next, fresh)))
        }
    }

    pub async fn connect(endpoint: &str) -> io::Result<BoxStream> {
        let deadline = Instant::now() + Duration::from_secs(2);
        loop {
            match ClientOptions::new().open(endpoint) {
                Ok(client) => return Ok(Box::new(client)),
                Err(e) if e.raw_os_error() == Some(ERROR_PIPE_BUSY as i32) && Instant::now() < deadline => {
                    tokio::time::sleep(Duration::from_millis(20)).await
                }
                Err(e) => return Err(e),
            }
        }
    }

    /// `D:P(A;;GA;;;<current user SID>)(A;;GA;;;SY)`: protected DACL, full
    /// access for the current user and LocalSystem, nobody else.
    struct SecurityDescriptor(PSECURITY_DESCRIPTOR);

    // SAFETY: the descriptor is immutable after creation and freed exactly once.
    unsafe impl Send for SecurityDescriptor {}
    unsafe impl Sync for SecurityDescriptor {}

    impl SecurityDescriptor {
        fn current_user_only() -> io::Result<Self> {
            let sddl = format!("D:P(A;;GA;;;{})(A;;GA;;;SY)", current_user_sid()?);
            let wide: Vec<u16> = sddl.encode_utf16().chain(Some(0)).collect();
            let mut sd: PSECURITY_DESCRIPTOR = null_mut();
            // SAFETY: `wide` is NUL-terminated; `sd` receives a LocalAlloc'd descriptor.
            let ok = unsafe {
                ConvertStringSecurityDescriptorToSecurityDescriptorW(
                    wide.as_ptr(),
                    SDDL_REVISION_1,
                    &mut sd,
                    null_mut(),
                )
            };
            if ok == 0 {
                return Err(io::Error::last_os_error());
            }
            Ok(Self(sd))
        }

        fn create(&self, name: &str, first: bool) -> io::Result<NamedPipeServer> {
            let mut attrs = SECURITY_ATTRIBUTES {
                nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
                lpSecurityDescriptor: self.0,
                bInheritHandle: 0,
            };
            // SAFETY: `attrs` points to a valid SECURITY_ATTRIBUTES for the duration of the call.
            unsafe {
                ServerOptions::new()
                    .first_pipe_instance(first)
                    .reject_remote_clients(true)
                    .create_with_security_attributes_raw(name, &mut attrs as *mut _ as *mut c_void)
            }
        }
    }

    impl Drop for SecurityDescriptor {
        fn drop(&mut self) {
            // SAFETY: allocated by ConvertStringSecurityDescriptorToSecurityDescriptorW.
            unsafe { LocalFree(self.0 as _) };
        }
    }

    fn current_user_sid() -> io::Result<String> {
        // SAFETY: standard token query sequence; every out-pointer is valid and
        // every handle/allocation is released before returning.
        unsafe {
            let mut token: HANDLE = null_mut();
            if OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) == 0 {
                return Err(io::Error::last_os_error());
            }
            let mut len = 0u32;
            GetTokenInformation(token, TokenUser, null_mut(), 0, &mut len);
            let mut buf = vec![0u8; len as usize];
            let ok = GetTokenInformation(token, TokenUser, buf.as_mut_ptr() as *mut c_void, len, &mut len);
            CloseHandle(token);
            if ok == 0 {
                return Err(io::Error::last_os_error());
            }
            let user = &*(buf.as_ptr() as *const TOKEN_USER);
            let mut wide: *mut u16 = null_mut();
            if ConvertSidToStringSidW(user.User.Sid, &mut wide) == 0 {
                return Err(io::Error::last_os_error());
            }
            let n = (0..).take_while(|&i| *wide.add(i) != 0).count();
            let sid = String::from_utf16_lossy(std::slice::from_raw_parts(wide, n));
            LocalFree(wide as _);
            Ok(sid)
        }
    }
}
