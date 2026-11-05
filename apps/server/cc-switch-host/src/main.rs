use cc_switch_host::protocol::{Host, Request};
use serde_json::{json, Value};
use std::sync::OnceLock;
use tokio::{io::{AsyncBufReadExt, AsyncWriteExt, BufReader}, sync::mpsc};

static EVENTS: OnceLock<mpsc::Sender<Value>> = OnceLock::new();
tokio::task_local! { static REQUEST_ID: String; }
struct SafeWarnings;
impl log::Log for SafeWarnings {
    fn enabled(&self, metadata: &log::Metadata<'_>) -> bool { metadata.level() <= log::Level::Warn }
    fn log(&self, record: &log::Record<'_>) {
        if !self.enabled(record.metadata()) { return; }
        // Never serialize the upstream log arguments: download/native parse
        // errors can carry secrets. Warnings still remain observable by callers.
        if let Some(events) = EVENTS.get() {
            let request_id = REQUEST_ID.try_with(Clone::clone).ok();
            let _ = events.try_send(json!({"event":"extension-warning","requestId":request_id,"data":{
                "code":"NATIVE_OPERATION_WARNING",
                "message":"Operation reported native warnings; resynchronize to inspect per-app outcomes."
            }}));
        }
    }
    fn flush(&self) {}
}
static LOGGER: SafeWarnings = SafeWarnings;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    std::panic::set_hook(Box::new(|_| eprintln!("cc-switch-host invariant failure (details redacted)")));
    #[cfg(unix)] unsafe { libc::umask(0o077); }
    let (output, mut responses) = mpsc::channel::<Value>(256);
    let _ = EVENTS.set(output.clone());
    let _ = log::set_logger(&LOGGER); log::set_max_level(log::LevelFilter::Warn);
    let (shutdown, mut stop_writer) = tokio::sync::oneshot::channel::<()>();
    let writer = tokio::spawn(async move {
        let mut stdout = tokio::io::stdout();
        let mut stopping = false;
        loop {
            let next = if stopping {
                responses.recv().await
            } else {
                tokio::select! {
                    _ = &mut stop_writer => { responses.close(); stopping = true; continue; }
                    value = responses.recv() => value,
                }
            };
            let Some(value) = next else { break; };
            let mut bytes = serde_json::to_vec(&value)?; bytes.push(b'\n');
            stdout.write_all(&bytes).await?; stdout.flush().await?;
        }
        Ok::<(), Box<dyn std::error::Error + Send + Sync>>(())
    });
    let mut lines = BufReader::new(tokio::io::stdin()).lines();
    let mut host = None;
    let mut tasks = tokio::task::JoinSet::new();
    while let Some(line) = lines.next_line().await? {
        if line.len() > 16 * 1024 * 1024 { break; }
        let request = match serde_json::from_str::<Request>(&line) {
            Ok(request) if !request.id.is_empty() && request.id.len() <= 256 => request,
            _ => { output.send(json!({"id":"","error":{"code":"INVALID_REQUEST","message":"Invalid private host request"}})).await?; continue; }
        };
        if host.is_none() {
            if request.command != "host_initialize" {
                output.send(json!({"id":request.id,"error":{"code":"NOT_INITIALIZED","message":"host_initialize must be the first command"}})).await?;
                continue;
            }
            match Host::initialize(request.args, output.clone()) {
                Ok((initialized, result)) => {
                    host = Some(initialized); output.send(json!({"id":request.id,"result":result})).await?;
                },
                Err(_) => {
                    output.send(json!({"id":request.id,"error":{"code":"INITIALIZATION_FAILED","message":"Context initialization failed; verify bound paths, ownership, schema and key"}})).await?;
                    break;
                }
            }
            continue;
        }
        let initialized = host.as_ref().unwrap().clone();
        let out = output.clone();
        tasks.spawn(async move {
            REQUEST_ID.scope(request.id.clone(), async move {
                let response = match initialized.invoke(&request).await {
                    Ok(result) => json!({"id":request.id,"result":result}),
                    // Deliberately opaque: even upstream validation errors can
                    // quote env/header values or private native file contents.
                    Err(error) => json!({"id":request.id,"error":{"code":cc_switch_host::protocol::public_error_code(&error),"message":"Management operation failed; authoritative state may be partially updated"}}),
                };
                let _ = out.send(response).await;
            }).await;
        });
        while let Some(result) = tasks.try_join_next() {
            if result.is_err() { break; }
        }
    }
    // EOF means owner disconnect, not permission to finish queued side effects.
    tasks.abort_all();
    while tasks.join_next().await.is_some() {}
    // Exiting the Tokio runtime drops all bounded connectivity futures and their
    // process-group/job guards. No detached native MCP child is intentionally kept.
    drop(output);
    let _ = shutdown.send(());
    let _ = writer.await;
    Ok(())
}
