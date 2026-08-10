mod durable_fs;
mod engine;
mod protocol;
mod segmented_wav;
mod session_lock;
mod storage_guard;
mod wav;

use crate::engine::{
    Engine, NoiseCheckPayload, ResumeSessionPayload, StartSessionPayload,
    is_no_active_session_error,
};
use crate::protocol::{CommandEnvelope, Emitter, PROTOCOL_VERSION};
use anyhow::{Context, Result, anyhow};
use serde::Deserialize;
use serde_json::{Value, json};
use std::io::{self, BufRead};
use std::path::PathBuf;

#[derive(Deserialize)]
struct ItemPayload {
    item_id: String,
}

#[derive(Deserialize)]
struct AttemptPayload {
    item_id: String,
    attempt_id: String,
}

#[derive(Deserialize)]
struct ExportPayload {
    session_dir: String,
}

fn main() -> Result<()> {
    let emitter = Emitter::new();
    emitter.event(
        "engine_ready",
        json!({
            "engine_version": env!("CARGO_PKG_VERSION"),
            "protocol_version": PROTOCOL_VERSION,
            "platform": std::env::consts::OS,
            "arch": std::env::consts::ARCH,
        }),
    );
    let stdin = io::stdin();
    let mut engine = Engine::new(emitter.clone());
    for line in stdin.lock().lines() {
        let line = match line {
            Ok(line) if !line.trim().is_empty() => line,
            Ok(_) => continue,
            Err(error) => {
                eprintln!("stdin read failed: {error}");
                break;
            }
        };
        let command: CommandEnvelope = match serde_json::from_str(&line) {
            Ok(command) => command,
            Err(error) => {
                emitter.response_error("unknown", "INVALID_JSON", error.to_string());
                continue;
            }
        };
        if command.protocol_version != PROTOCOL_VERSION {
            emitter.response_error(
                &command.request_id,
                "PROTOCOL_MISMATCH",
                format!(
                    "engine protocol is {}, request protocol is {}",
                    PROTOCOL_VERSION, command.protocol_version
                ),
            );
            continue;
        }
        let request_id = command.request_id.clone();
        let command_name = command.command.clone();
        match dispatch(&mut engine, command) {
            Ok(result) => emitter.response_ok(&request_id, result),
            Err(error) => {
                let code = if is_no_active_session_error(&error) {
                    "NO_ACTIVE_SESSION"
                } else {
                    "COMMAND_FAILED"
                };
                eprintln!("command {command_name} [{request_id}] failed: {error:#}");
                emitter.response_error(&request_id, code, format!("{error:#}"));
            }
        }
    }
    if let Err(error) = engine.shutdown() {
        eprintln!("engine shutdown after stdin EOF failed: {error:#}");
        return Err(error.context("safely stop recording after stdin EOF"));
    }
    Ok(())
}

fn dispatch(engine: &mut Engine, command: CommandEnvelope) -> Result<Value> {
    match command.command.as_str() {
        "hello" => Ok(json!({
            "engine_version": env!("CARGO_PKG_VERSION"),
            "protocol_version": PROTOCOL_VERSION,
        })),
        "list_devices" => engine.list_devices(),
        "start_session" => {
            let payload: StartSessionPayload =
                serde_json::from_value(command.payload).context("invalid start_session payload")?;
            engine.start_session(payload)
        }
        "resume_session" => {
            let payload: ResumeSessionPayload = serde_json::from_value(command.payload)
                .context("invalid resume_session payload")?;
            engine.resume_session(payload)
        }
        "check_noise" => {
            let payload: NoiseCheckPayload = parse(command.payload)?;
            engine.check_noise(payload)
        }
        "start_attempt" => {
            let payload: ItemPayload = parse(command.payload)?;
            engine.start_attempt(&payload.item_id)
        }
        "stop_attempt" => engine.stop_attempt(),
        "accept_attempt" => {
            let payload: AttemptPayload = parse(command.payload)?;
            engine.accept_attempt(&payload.item_id, &payload.attempt_id)
        }
        "skip_item" => {
            let payload: ItemPayload = parse(command.payload)?;
            engine.skip_item(&payload.item_id)
        }
        "render_attempt" => {
            let payload: AttemptPayload = parse(command.payload)?;
            engine.render_attempt(&payload.item_id, &payload.attempt_id)
        }
        "get_state" => engine.get_state(),
        "get_state_optional" => Ok(engine.get_state_optional()),
        "stop_session" => engine.stop_session(),
        "export_session" => {
            let payload: ExportPayload = parse(command.payload)?;
            engine.export_session(&PathBuf::from(payload.session_dir))
        }
        "shutdown" => shutdown_protocol_response(engine.shutdown()),
        other => Err(anyhow!("unknown command {other}")),
    }
}

fn shutdown_protocol_response(shutdown: Result<()>) -> Result<Value> {
    shutdown?;
    Ok(json!({ "shutting_down": true }))
}

fn parse<T: for<'de> Deserialize<'de>>(value: Value) -> Result<T> {
    serde_json::from_value(value).context("invalid command payload")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shutdown_protocol_does_not_turn_a_stop_failure_into_success() {
        let error = shutdown_protocol_response(Err(anyhow!(
            "audio stopped but metadata could not be sealed"
        )))
        .unwrap_err();
        assert!(format!("{error:#}").contains("metadata could not be sealed"));
    }
}
