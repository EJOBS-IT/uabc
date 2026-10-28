//! `uabc` — Universal AI Browser Controller.
//!
//! One binary, several roles:
//! * native messaging host (Chrome runs `uabc chrome-extension://<id>/`),
//! * MCP server for AI clients (`uabc mcp`),
//! * relay for AI apps in the cloud (`uabc relay`),
//! * installer and diagnostics (`uabc install`, `uabc status`, `uabc call`).
//!
//! In host and MCP mode stdout is a protocol channel: never print to it.

mod client;
mod format;
mod host;
mod install;
mod ipc;
mod mcp;
mod native;
mod paths;
mod proto;
mod relay;

use std::net::SocketAddr;
use std::path::PathBuf;
use std::process::ExitCode;
use std::time::Duration;

use clap::{Parser, Subcommand};
use tokio_util::sync::CancellationToken;
use tracing_subscriber::EnvFilter;

use crate::install::Browser;
use crate::proto::{ClientInfo, VERSION};

#[derive(Parser)]
#[command(name = "uabc", version, about = "Let AI agents drive your real browser — safely.", long_about = None)]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// Run the MCP server on stdio (this is what AI clients launch).
    Mcp {
        /// Browser profile to control (instance id or label) when several are running.
        #[arg(long)]
        target: Option<String>,
    },
    /// Register this binary as the browser's native messaging host.
    Install {
        /// Browsers to register with (default: all supported).
        #[arg(long = "browser", value_enum)]
        browsers: Vec<Browser>,
        /// Trust the unpacked development build of the extension.
        #[arg(long)]
        dev: bool,
        /// Additionally trust this extension id (repeatable).
        #[arg(long = "extension-id")]
        extension_ids: Vec<String>,
        /// Register for one custom profile directory only (browser started with --user-data-dir).
        #[arg(long)]
        user_data_dir: Option<PathBuf>,
    },
    /// Remove the native messaging host registration.
    Uninstall {
        #[arg(long = "browser", value_enum)]
        browsers: Vec<Browser>,
        #[arg(long)]
        user_data_dir: Option<PathBuf>,
    },
    /// Show registrations and running browser bridges.
    Status,
    /// Print MCP configuration snippets for AI clients.
    Config {
        /// claude-code, codex, antigravity, cursor, gemini, vscode or generic (default: all).
        client: Option<String>,
    },
    /// Send one raw command to the extension (for debugging), e.g. `uabc call tabs.list`.
    Call {
        method: String,
        /// JSON params, e.g. '{"url":"https://example.com"}'.
        #[arg(default_value = "{}")]
        params: String,
        #[arg(long)]
        target: Option<String>,
    },
    /// Run a relay so AI apps in the cloud (Claude, ChatGPT …) can reach browsers that connect to it.
    Relay {
        /// Address to listen on. For public use put a TLS reverse proxy in front.
        #[arg(long, default_value = "127.0.0.1:8787")]
        listen: SocketAddr,
        /// Where device records (secret hashes only) are kept [default: <UABC_HOME>/relay].
        #[arg(long)]
        data_dir: Option<PathBuf>,
        /// Also accept WebSocket clients that are not browser extensions.
        #[arg(long, hide = true)]
        allow_any_origin: bool,
        /// Require this access code to add a new browser (or set UABC_RELAY_TOKEN).
        #[arg(long)]
        registration_token: Option<String>,
    },
    /// Run as native messaging host (normally started by the browser).
    #[command(hide = true)]
    Host {
        #[arg(long)]
        origin: String,
    },
}

fn main() -> ExitCode {
    // The browser starts native hosts as `<path> chrome-extension://<id>/ [--parent-window=N]`.
    if let Some(origin) = std::env::args().nth(1).filter(|a| a.starts_with("chrome-extension://")) {
        return run_host(&origin);
    }
    let cli = Cli::parse();
    let result = match cli.command {
        Command::Host { origin } => return run_host(&origin),
        Command::Mcp { target } => {
            init_logging(false, "warn");
            runtime().block_on(mcp::serve(target))
        }
        Command::Install { browsers, dev, extension_ids, user_data_dir } => {
            let browsers = if browsers.is_empty() { Browser::ALL.to_vec() } else { browsers };
            install::install(&install::InstallOptions { browsers, extension_ids, dev, user_data_dir })
        }
        Command::Uninstall { browsers, user_data_dir } => {
            let browsers = if browsers.is_empty() { Browser::ALL.to_vec() } else { browsers };
            install::uninstall(&browsers, user_data_dir.as_deref())
        }
        Command::Relay { listen, data_dir, allow_any_origin, registration_token } => {
            init_logging(false, "info");
            let data_dir = data_dir.unwrap_or_else(|| paths::home().join("relay"));
            let registration_token = registration_token.or_else(|| std::env::var("UABC_RELAY_TOKEN").ok());
            runtime().block_on(relay::run(relay::RelayOptions {
                listen,
                data_dir,
                allow_any_origin,
                registration_token,
            }))
        }
        Command::Status => runtime().block_on(status()),
        Command::Config { client } => install::client_config(client.as_deref()).map(|s| println!("{s}")),
        Command::Call { method, params, target } => runtime().block_on(call(method, params, target)),
    };
    match result {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            eprintln!("error: {e:#}");
            ExitCode::FAILURE
        }
    }
}

fn run_host(origin: &str) -> ExitCode {
    init_logging(true, "info");
    match runtime().block_on(host::run(origin)) {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            tracing::error!("{e:#}");
            ExitCode::FAILURE
        }
    }
}

fn runtime() -> tokio::runtime::Runtime {
    tokio::runtime::Builder::new_multi_thread().enable_all().build().expect("tokio runtime")
}

/// Host mode logs to `<UABC_HOME>/logs/host.log` (the browser swallows stderr);
/// everything else logs to stderr. Level via `UABC_LOG` (e.g. `UABC_LOG=debug`).
fn init_logging(to_file: bool, default_level: &str) {
    let filter = EnvFilter::try_from_env("UABC_LOG").unwrap_or_else(|_| EnvFilter::new(default_level));
    let builder = tracing_subscriber::fmt().with_env_filter(filter).with_target(false);
    if to_file {
        let dir = paths::logs_dir();
        let path = dir.join("host.log");
        let file = paths::ensure_private_dir(&dir).ok().and_then(|_| {
            // Crude rotation: start over once the log passes 5 MB.
            let too_big = std::fs::metadata(&path).map(|m| m.len() > 5 << 20).unwrap_or(false);
            std::fs::OpenOptions::new().create(true).append(!too_big).write(true).truncate(too_big).open(&path).ok()
        });
        match file {
            Some(file) => builder.with_ansi(false).with_writer(std::sync::Mutex::new(file)).init(),
            None => builder.with_writer(std::io::stderr).init(),
        }
    } else {
        builder.with_writer(std::io::stderr).init();
    }
}

async fn status() -> anyhow::Result<()> {
    println!("uabc {VERSION} · home {}", paths::home().display());
    println!("\nNative host registration:");
    let installed = install::installed();
    for browser in Browser::ALL {
        match installed.iter().find(|(b, ..)| *b == browser) {
            Some((_, manifest, exe)) => println!(
                "  ✓ {browser:?}: {} → {}",
                manifest.display(),
                exe.as_deref().unwrap_or("(unreadable manifest)")
            ),
            None => println!("  · {browser:?}: not registered"),
        }
    }

    println!("\nRunning browser bridges:");
    let instances = client::list_instances();
    if instances.is_empty() {
        println!("  (none) — open the browser with the UABC extension enabled.");
        println!("  If the extension shows \"bridge not installed\", run `uabc install`.");
    }
    let me = ClientInfo { name: "uabc-status".into(), version: VERSION.into() };
    let cancel = CancellationToken::new();
    for i in instances {
        let label = if i.label.is_empty() { String::new() } else { format!(" \"{}\"", i.label) };
        print!("  • {}{label} · {} · extension {} · pid {} · ", i.instance_id, i.browser, i.extension_version, i.pid);
        match client::Bridge::connect(Some(&i.instance_id), me.clone()).await {
            Ok(bridge) => {
                match bridge.request("browser.status", serde_json::json!({}), Duration::from_secs(5), &cancel).await {
                    Ok(v) => println!(
                        "reachable ✓ (paused: {}, shared tabs: {}, sessions: {})",
                        v["paused"].as_bool().unwrap_or(false),
                        v["tabs"].as_array().map_or(0, Vec::len),
                        // A count since 0.2; a list before.
                        v["sessions"]
                            .as_u64()
                            .unwrap_or_else(|| v["sessions"].as_array().map_or(0, |a| a.len() as u64)),
                    ),
                    Err(e) => println!("reachable, but status failed: {e}"),
                }
            }
            Err(e) => println!("unreachable ✗ ({})", e.message),
        }
    }
    Ok(())
}

async fn call(method: String, params: String, target: Option<String>) -> anyhow::Result<()> {
    let params: serde_json::Value = serde_json::from_str(&params)?;
    let me = ClientInfo { name: "uabc-cli".into(), version: VERSION.into() };
    let bridge = client::Bridge::connect(target.as_deref(), me).await?;
    let result = bridge.request(&method, params, Duration::from_secs(150), &CancellationToken::new()).await?;
    println!("{}", serde_json::to_string_pretty(&result)?);
    Ok(())
}
