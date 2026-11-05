//! Headless production assembly of the pinned cc-switch MCP and Skills core.
//! No desktop runtime, account, pricing, proxy server or cloud-sync initialization.
//!
//! One child owns one immutable context and a distinct host-derived secret key.
//! MCP server_config is authenticated with that context key and the server id.
#[path = "../../../../vendor/cc-switch/src-tauri/src/app_config.rs"]
pub mod app_config;
#[path = "../../../../vendor/cc-switch/src-tauri/src/config.rs"]
pub mod config;
#[path = "../../../../vendor/cc-switch/src-tauri/src/error.rs"]
pub mod error;
#[path = "../../../../vendor/cc-switch/src-tauri/src/prompt.rs"]
pub mod prompt;
#[path = "../../../../vendor/cc-switch/src-tauri/src/provider.rs"]
pub mod provider;
#[path = "../../../../vendor/cc-switch/src-tauri/src/jsonc_document.rs"]
pub mod jsonc_document;
#[path = "../../../../vendor/cc-switch/src-tauri/src/claude_mcp.rs"]
pub mod claude_mcp;
#[path = "../../../../vendor/cc-switch/src-tauri/src/gemini_mcp.rs"]
pub mod gemini_mcp;
#[path = "../../../../vendor/cc-switch/src-tauri/src/gemini_config.rs"]
pub mod gemini_config;
#[path = "../../../../vendor/cc-switch/src-tauri/src/grok_config.rs"]
pub mod grok_config;
#[path = "../../../../vendor/cc-switch/src-tauri/src/hermes_config.rs"]
pub mod hermes_config;
#[path = "../../../../vendor/cc-switch/src-tauri/src/opencode_config.rs"]
pub mod opencode_config;
#[path = "../../../../vendor/cc-switch/src-tauri/src/mcode_config.rs"]
pub mod mcode_config;
#[path = "../../../../vendor/cc-switch/src-tauri/src/kimi_config.rs"]
pub mod kimi_config;
#[path = "../../../../vendor/cc-switch/src-tauri/src/dsh_config.rs"]
pub mod dsh_config;
#[path = "../../../../vendor/cc-switch/src-tauri/src/omp_config.rs"]
pub mod omp_config;
#[path = "../../../../vendor/cc-switch/src-tauri/src/codex_mcp_config.rs"]
pub mod codex_config;
#[path = "../../../../vendor/cc-switch/src-tauri/src/pi_config/mod.rs"]
pub mod pi_config;
#[path = "../../../../vendor/cc-switch/src-tauri/src/mcp/mod.rs"]
pub mod mcp;
pub mod host_context;
pub mod settings;
pub mod database;
pub mod store;
pub mod services;
pub mod protocol;
pub mod secret_codec;
pub mod mcp_management;
pub mod agy_config {
    pub fn customizations_dir() -> std::path::PathBuf {
        crate::host_context::app_dir("agy")
    }
}
pub mod proxy;
