//! `uabc install` / `uabc uninstall`: registers this binary as the native
//! messaging host `com.ejobsit.uabc` for Chromium-family browsers.
//!
//! * Linux/macOS: a JSON manifest in the browser's `NativeMessagingHosts` directory.
//! * Windows: the manifest is written under `%LOCALAPPDATA%\uabc\` and the
//!   browser's `HKCU\Software\…\NativeMessagingHosts\com.ejobsit.uabc` key points to it.

use std::path::{Path, PathBuf};

use anyhow::{Context, bail};
use serde_json::json;

use crate::proto::NATIVE_HOST_NAME;

/// Derived from the public `key` in `extension/manifest.json` (unpacked dev builds).
pub const DEV_EXTENSION_ID: &str = "opidijgpffpkhmnenmcdmjbhkgkdceec";
/// Assigned by the Chrome Web Store on first upload; fill in before the first release.
pub const STORE_EXTENSION_ID: Option<&str> = None;

#[derive(Debug, Clone, Copy, PartialEq, Eq, clap::ValueEnum)]
pub enum Browser {
    Chrome,
    Chromium,
    Edge,
    Brave,
}

impl Browser {
    pub const ALL: [Browser; 4] = [Browser::Chrome, Browser::Chromium, Browser::Edge, Browser::Brave];

    fn name(self) -> &'static str {
        match self {
            Browser::Chrome => "Google Chrome",
            Browser::Chromium => "Chromium",
            Browser::Edge => "Microsoft Edge",
            Browser::Brave => "Brave",
        }
    }

    /// Per-user manifest directory (Linux/macOS).
    #[cfg(not(windows))]
    fn manifest_dir(self) -> Option<PathBuf> {
        let home = PathBuf::from(std::env::var_os("HOME")?);
        #[cfg(target_os = "macos")]
        let base = home.join("Library/Application Support");
        #[cfg(not(target_os = "macos"))]
        let base = home.join(".config");
        let profile_root = match self {
            #[cfg(target_os = "macos")]
            Browser::Chrome => "Google/Chrome",
            #[cfg(not(target_os = "macos"))]
            Browser::Chrome => "google-chrome",
            #[cfg(target_os = "macos")]
            Browser::Chromium => "Chromium",
            #[cfg(not(target_os = "macos"))]
            Browser::Chromium => "chromium",
            #[cfg(target_os = "macos")]
            Browser::Edge => "Microsoft Edge",
            #[cfg(not(target_os = "macos"))]
            Browser::Edge => "microsoft-edge",
            Browser::Brave => "BraveSoftware/Brave-Browser",
        };
        Some(base.join(profile_root).join("NativeMessagingHosts"))
    }

    #[cfg(windows)]
    fn registry_key(self) -> String {
        let vendor = match self {
            Browser::Chrome => r"Google\Chrome",
            Browser::Chromium => "Chromium",
            Browser::Edge => r"Microsoft\Edge",
            Browser::Brave => r"BraveSoftware\Brave-Browser",
        };
        format!(r"Software\{vendor}\NativeMessagingHosts\{NATIVE_HOST_NAME}")
    }
}

pub struct InstallOptions {
    pub browsers: Vec<Browser>,
    pub extension_ids: Vec<String>,
    pub dev: bool,
    /// Register for a single custom profile directory (`--user-data-dir`), e.g. for tests.
    pub user_data_dir: Option<PathBuf>,
}

pub fn allowed_ids(opts: &InstallOptions) -> anyhow::Result<Vec<String>> {
    let mut ids: Vec<String> = STORE_EXTENSION_ID.map(str::to_owned).into_iter().collect();
    if opts.dev {
        ids.push(DEV_EXTENSION_ID.to_owned());
    }
    ids.extend(opts.extension_ids.iter().cloned());
    for id in &ids {
        if id.len() != 32 || !id.bytes().all(|b| (b'a'..=b'p').contains(&b)) {
            bail!("{id:?} is not a Chrome extension id (32 letters a-p)");
        }
    }
    ids.dedup();
    if ids.is_empty() {
        bail!(
            "No extension id to trust. Until the Chrome Web Store id is published, use `--dev` \
             (unpacked extension from this repo) or `--extension-id <id>`."
        );
    }
    Ok(ids)
}

pub fn manifest(exe: &Path, ids: &[String]) -> serde_json::Value {
    json!({
        "name": NATIVE_HOST_NAME,
        "description": "UABC native messaging host (bridges AI clients to this browser)",
        "path": exe,
        "type": "stdio",
        "allowed_origins": ids.iter().map(|id| format!("chrome-extension://{id}/")).collect::<Vec<_>>(),
    })
}

fn current_exe() -> anyhow::Result<PathBuf> {
    let exe = std::env::current_exe().context("cannot locate the uabc binary")?;
    Ok(exe.canonicalize().unwrap_or(exe))
}

fn write_manifest(dir: &Path, body: &serde_json::Value) -> anyhow::Result<PathBuf> {
    std::fs::create_dir_all(dir).with_context(|| format!("creating {}", dir.display()))?;
    let path = dir.join(format!("{NATIVE_HOST_NAME}.json"));
    std::fs::write(&path, serde_json::to_vec_pretty(body)?).with_context(|| format!("writing {}", path.display()))?;
    Ok(path)
}

pub fn install(opts: &InstallOptions) -> anyhow::Result<()> {
    let ids = allowed_ids(opts)?;
    let exe = current_exe()?;
    let body = manifest(&exe, &ids);
    println!("Native host: {}", exe.display());
    println!("Trusted extension ids: {}", ids.join(", "));

    if let Some(dir) = &opts.user_data_dir {
        let path = write_manifest(&dir.join("NativeMessagingHosts"), &body)?;
        println!("  ✓ custom profile → {}", path.display());
        return Ok(());
    }

    #[cfg(not(windows))]
    for browser in &opts.browsers {
        let Some(dir) = browser.manifest_dir() else { continue };
        let path = write_manifest(&dir, &body)?;
        println!("  ✓ {:<15} → {}", browser.name(), path.display());
    }

    #[cfg(windows)]
    {
        let dir = crate::paths::home().join("native-host");
        let path = write_manifest(&dir, &body)?;
        let hkcu = winreg::RegKey::predef(winreg::enums::HKEY_CURRENT_USER);
        for browser in &opts.browsers {
            let (key, _) = hkcu.create_subkey(browser.registry_key())?;
            key.set_value("", &path.to_string_lossy().to_string())?;
            println!("  ✓ {:<15} → HKCU\\{}", browser.name(), browser.registry_key());
        }
    }

    println!("\nRestart the browser (or reload the UABC extension) so it reconnects.");
    println!("Then add UABC to your AI client — `uabc config` prints ready-to-paste snippets.");
    Ok(())
}

pub fn uninstall(browsers: &[Browser], user_data_dir: Option<&Path>) -> anyhow::Result<()> {
    let file = format!("{NATIVE_HOST_NAME}.json");
    if let Some(dir) = user_data_dir {
        let _ = std::fs::remove_file(dir.join("NativeMessagingHosts").join(&file));
        return Ok(());
    }
    #[cfg(not(windows))]
    for browser in browsers {
        if let Some(dir) = browser.manifest_dir()
            && std::fs::remove_file(dir.join(&file)).is_ok()
        {
            println!("  ✓ removed from {}", browser.name());
        }
    }
    #[cfg(windows)]
    {
        let hkcu = winreg::RegKey::predef(winreg::enums::HKEY_CURRENT_USER);
        for browser in browsers {
            if hkcu.delete_subkey(browser.registry_key()).is_ok() {
                println!("  ✓ removed from {}", browser.name());
            }
        }
        let _ = std::fs::remove_file(crate::paths::home().join("native-host").join(&file));
    }
    Ok(())
}

/// Which browsers currently have a manifest pointing at *some* uabc binary.
pub fn installed() -> Vec<(Browser, PathBuf, Option<String>)> {
    let mut found = Vec::new();
    for browser in Browser::ALL {
        #[cfg(not(windows))]
        let manifest = browser.manifest_dir().map(|d| d.join(format!("{NATIVE_HOST_NAME}.json")));
        #[cfg(windows)]
        let manifest = winreg::RegKey::predef(winreg::enums::HKEY_CURRENT_USER)
            .open_subkey(browser.registry_key())
            .and_then(|k| k.get_value::<String, _>(""))
            .ok()
            .map(PathBuf::from);
        if let Some(path) = manifest.filter(|p| p.exists()) {
            let exe = std::fs::read(&path)
                .ok()
                .and_then(|b| serde_json::from_slice::<serde_json::Value>(&b).ok())
                .and_then(|v| v["path"].as_str().map(str::to_owned));
            found.push((browser, path, exe));
        }
    }
    found
}

/// Ready-to-paste MCP client configuration.
pub fn client_config(client: Option<&str>) -> anyhow::Result<String> {
    let exe = current_exe()?.to_string_lossy().replace('\\', "\\\\");
    let snippets = [
        ("claude-code", format!("claude mcp add --scope user uabc -- \"{exe}\" mcp")),
        ("codex", format!("# ~/.codex/config.toml\n[mcp_servers.uabc]\ncommand = \"{exe}\"\nargs = [\"mcp\"]")),
        (
            "cursor",
            format!(
                "// ~/.cursor/mcp.json\n{{ \"mcpServers\": {{ \"uabc\": {{ \"command\": \"{exe}\", \"args\": [\"mcp\"] }} }} }}"
            ),
        ),
        (
            "antigravity",
            format!(
                "// ~/.gemini/antigravity/mcp_config.json (in Antigravity: … menu of the agent panel → MCP Servers → Manage MCP Servers → View raw config)\n{{ \"mcpServers\": {{ \"uabc\": {{ \"command\": \"{exe}\", \"args\": [\"mcp\"] }} }} }}"
            ),
        ),
        (
            "gemini",
            format!(
                "// ~/.gemini/settings.json\n{{ \"mcpServers\": {{ \"uabc\": {{ \"command\": \"{exe}\", \"args\": [\"mcp\"] }} }} }}"
            ),
        ),
        (
            "vscode",
            format!(
                "// .vscode/mcp.json\n{{ \"servers\": {{ \"uabc\": {{ \"type\": \"stdio\", \"command\": \"{exe}\", \"args\": [\"mcp\"] }} }} }}"
            ),
        ),
        (
            "generic",
            format!(
                "# Any MCP client (LM Studio, Goose, Zed, Open WebUI via mcpo …): stdio server\ncommand: {exe}\nargs:    mcp [--target <profile label>]"
            ),
        ),
    ];
    match client {
        Some(name) => snippets.iter().find(|(n, _)| *n == name).map(|(_, s)| s.clone()).with_context(|| {
            let known: Vec<_> = snippets.iter().map(|(n, _)| *n).collect();
            format!("unknown client {name:?}; known: {}", known.join(", "))
        }),
        None => Ok(snippets.iter().map(|(n, s)| format!("## {n}\n{s}\n")).collect::<Vec<_>>().join("\n")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn manifest_lists_exact_origins() {
        let m = manifest(Path::new("/opt/uabc/uabc"), &[DEV_EXTENSION_ID.to_owned()]);
        assert_eq!(m["name"], NATIVE_HOST_NAME);
        assert_eq!(m["type"], "stdio");
        assert_eq!(m["allowed_origins"][0], format!("chrome-extension://{DEV_EXTENSION_ID}/"));
    }

    #[test]
    fn refuses_to_trust_nothing_or_garbage() {
        let opts = |dev, ids: Vec<&str>| InstallOptions {
            browsers: vec![],
            extension_ids: ids.into_iter().map(String::from).collect(),
            dev,
            user_data_dir: None,
        };
        if STORE_EXTENSION_ID.is_none() {
            assert!(allowed_ids(&opts(false, vec![])).is_err());
        }
        assert!(allowed_ids(&opts(false, vec!["not-an-id"])).is_err());
        assert_eq!(allowed_ids(&opts(true, vec![])).unwrap(), vec![DEV_EXTENSION_ID.to_owned()]);
    }

    #[test]
    fn dev_id_matches_the_extension_manifest_key() {
        use base64::Engine;
        use sha2::Digest;
        // Chrome derives an unpacked extension's id from SHA-256(public key DER):
        // the first 32 hex digits, mapped 0-f → a-p.
        let manifest: serde_json::Value = serde_json::from_str(include_str!("../../extension/manifest.json")).unwrap();
        let der = base64::engine::general_purpose::STANDARD.decode(manifest["key"].as_str().unwrap()).unwrap();
        let id: String = sha2::Sha256::digest(&der)[..16]
            .iter()
            .flat_map(|b| [b >> 4, b & 0xf])
            .map(|nibble| (b'a' + nibble) as char)
            .collect();
        assert_eq!(id, DEV_EXTENSION_ID);
    }
}
