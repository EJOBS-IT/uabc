//! Filesystem layout. Everything lives under `UABC_HOME`:
//!
//! ```text
//! <UABC_HOME>/instances/<id>.json   discovery records of running hosts
//! <UABC_HOME>/run/<id>.sock         IPC endpoints (Unix; Windows uses named pipes)
//! <UABC_HOME>/logs/host.log         host-mode log (stdout is the protocol channel)
//! ```

use std::io;
use std::path::{Path, PathBuf};

pub fn home() -> PathBuf {
    if let Some(dir) = std::env::var_os("UABC_HOME").filter(|v| !v.is_empty()) {
        return PathBuf::from(dir);
    }
    #[cfg(windows)]
    {
        std::env::var_os("LOCALAPPDATA")
            .map(|p| PathBuf::from(p).join("uabc"))
            .unwrap_or_else(|| PathBuf::from(".uabc"))
    }
    #[cfg(not(windows))]
    {
        std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".uabc")).unwrap_or_else(|| PathBuf::from("/tmp/.uabc"))
    }
}

pub fn instances_dir() -> PathBuf {
    home().join("instances")
}

pub fn logs_dir() -> PathBuf {
    home().join("logs")
}

#[cfg(unix)]
pub fn run_dir() -> PathBuf {
    home().join("run")
}

/// Creates `dir` (and parents) readable only by the current user.
pub fn ensure_private_dir(dir: &Path) -> io::Result<()> {
    std::fs::create_dir_all(dir)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700))?;
    }
    Ok(())
}

/// Instance ids come from the extension and become file and pipe names, so
/// they are restricted to a boring alphabet (no path traversal, no spaces).
pub fn valid_instance_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 32 && id.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}

pub fn endpoint_for(instance_id: &str) -> String {
    debug_assert!(valid_instance_id(instance_id));
    #[cfg(unix)]
    {
        run_dir().join(format!("{instance_id}.sock")).to_string_lossy().into_owned()
    }
    #[cfg(windows)]
    {
        format!(r"\\.\pipe\uabc-{instance_id}")
    }
}

pub fn descriptor_path(instance_id: &str) -> PathBuf {
    instances_dir().join(format!("{instance_id}.json"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn instance_ids_cannot_escape_their_directory() {
        assert!(valid_instance_id("a1b2c3d4e5f6"));
        assert!(valid_instance_id("work-profile"));
        for bad in ["", "../x", "a/b", r"a\b", "A1", "x y", "a.sock", &"a".repeat(33)] {
            assert!(!valid_instance_id(bad), "{bad:?} must be rejected");
        }
    }
}
