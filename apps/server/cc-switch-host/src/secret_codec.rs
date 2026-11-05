//! Whole MCP spec encryption preserves unknown upstream fields and prevents
//! secrets embedded in URL/args from escaping the env/header boundary.
//! Every child receives a distinct context-derived key. AAD binds the row id;
//! moving ciphertext across rows or context keys fails authentication.
use aes_gcm::{Aes256Gcm, Nonce, aead::{Aead, KeyInit, OsRng, Payload, rand_core::RngCore}};
use anyhow::{anyhow, bail, Result};
use base64::{Engine, engine::general_purpose::STANDARD};
use serde_json::{json, Value};
use std::sync::OnceLock;
static CIPHER: OnceLock<Aes256Gcm> = OnceLock::new();
pub fn initialize(encoded: &str) -> Result<()> {
    let mut key = STANDARD.decode(encoded).map_err(|_| anyhow!("Invalid context key encoding"))?;
    if key.len() != 32 { key.fill(0); bail!("Context key must contain 32 bytes"); }
    let cipher = Aes256Gcm::new_from_slice(&key).map_err(|_| anyhow!("Invalid context key"))?;
    key.fill(0);
    CIPHER.set(cipher).map_err(|_| anyhow!("Context key already initialized"))
}
fn cipher() -> Result<&'static Aes256Gcm> { CIPHER.get().ok_or_else(|| anyhow!("Context key is not initialized")) }
fn aad(id: &str) -> Vec<u8> { [b"cc-switch-host:mcp:v1:".as_slice(), id.as_bytes()].concat() }
pub fn seal(id: &str, value: &Value) -> Result<String> { seal_bound(&aad(id), value) }
pub fn seal_override(id: &str, app: &str, value: &Value) -> Result<String> {
    seal_bound(&override_aad(id, app), value)
}
pub fn open_override(id: &str, app: &str, stored: &str) -> Result<Value> {
    open_bound(&override_aad(id, app), stored)
}
fn override_aad(id: &str, app: &str) -> Vec<u8> {
    [b"cc-switch-host:mcp-agent-override:v1:".as_slice(), serde_json::to_vec(&(id, app)).expect("string tuple").as_slice()].concat()
}
fn seal_bound(binding: &[u8], value: &Value) -> Result<String> {
    let mut nonce = [0u8; 12]; OsRng.fill_bytes(&mut nonce);
    let mut plaintext = serde_json::to_vec(value)?;
    let sealed = cipher()?.encrypt(Nonce::from_slice(&nonce), Payload { msg: &plaintext, aad: binding });
    plaintext.fill(0);
    let sealed = sealed.map_err(|_| anyhow!("Cannot protect MCP configuration"))?;
    Ok(json!({"$ccSwitchSealed":1,"nonce":STANDARD.encode(nonce),"ciphertext":STANDARD.encode(sealed)}).to_string())
}
pub fn open(id: &str, stored: &str) -> Result<Value> { open_bound(&aad(id), stored) }
fn open_bound(binding: &[u8], stored: &str) -> Result<Value> {
    let envelope: Value = serde_json::from_str(stored).map_err(|_| anyhow!("Invalid protected MCP record"))?;
    if envelope["$ccSwitchSealed"] != 1 { bail!("Unprotected MCP record refused; import through the protected host"); }
    let nonce = STANDARD.decode(envelope["nonce"].as_str().unwrap_or_default()).map_err(|_| anyhow!("Invalid protected MCP record"))?;
    if nonce.len() != 12 { bail!("Invalid protected MCP record"); }
    let ciphertext = STANDARD.decode(envelope["ciphertext"].as_str().unwrap_or_default()).map_err(|_| anyhow!("Invalid protected MCP record"))?;
    let mut plaintext = cipher()?.decrypt(Nonce::from_slice(&nonce), Payload { msg: &ciphertext, aad: binding })
        .map_err(|_| anyhow!("Context key authentication failed"))?;
    let value = serde_json::from_slice(&plaintext).map_err(|_| anyhow!("Invalid protected MCP payload"));
    plaintext.fill(0);
    value
}

#[cfg(test)]
pub(crate) fn initialize_test_key() {
    CIPHER.get_or_init(|| Aes256Gcm::new_from_slice(&[0x42; 32]).expect("test fixture key"));
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn specs_round_trip_without_plaintext_and_bind_row_identity() {
        initialize_test_key();
        let spec = json!({"command":"fixture","env":{"TOKEN":"fixture-secret"},"headers":{"Authorization":"fixture-header"},"futureField":{"kept":true}});
        let sealed = seal("server-a", &spec).unwrap();
        assert!(!sealed.contains("fixture-secret"));
        assert!(!sealed.contains("fixture-header"));
        assert_eq!(open("server-a", &sealed).unwrap(), spec);
        assert!(open("server-b", &sealed).is_err());
        assert!(open("server-a", &spec.to_string()).is_err());
        let envelope: Value = serde_json::from_str(&sealed).unwrap();
        let nonce = STANDARD.decode(envelope["nonce"].as_str().unwrap()).unwrap();
        let ciphertext = STANDARD.decode(envelope["ciphertext"].as_str().unwrap()).unwrap();
        let other = Aes256Gcm::new_from_slice(&[0x43; 32]).unwrap();
        assert!(other.decrypt(Nonce::from_slice(&nonce), Payload { msg: &ciphertext, aad: &aad("server-a") }).is_err());
    }
}
