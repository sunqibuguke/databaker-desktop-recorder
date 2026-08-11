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
        "seal_interrupted_session" => {
            let payload: ExportPayload = parse(command.payload)?;
            engine.seal_interrupted_session(&PathBuf::from(payload.session_dir))
        }
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
    use crate::engine::{AudioFormat, ItemState, SessionSnapshot};
    use crate::wav::RecoverableWav;
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn shutdown_protocol_does_not_turn_a_stop_failure_into_success() {
        let error = shutdown_protocol_response(Err(anyhow!(
            "audio stopped but metadata could not be sealed"
        )))
        .unwrap_err();
        assert!(format!("{error:#}").contains("metadata could not be sealed"));
    }

    #[test]
    fn production_seal_command_succeeds_without_opening_an_audio_device() {
        let root = std::env::temp_dir().join(format!(
            "recorder-engine-protocol-seal-{}",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        for name in ["audio", "metadata", "script"] {
            std::fs::create_dir_all(root.join(name)).unwrap();
        }
        let master = root.join("audio/master.wav");
        let mut writer = RecoverableWav::create(&master, 48_000, 1, 24).unwrap();
        writer.write_samples(&[0.25, -0.25]).unwrap();
        writer.finalize().unwrap();
        let snapshot = SessionSnapshot {
            schema_version: 1,
            journal_seq: 1,
            session_id: "protocol-seal".to_string(),
            script_name: "test.csv".to_string(),
            status: "stopped".to_string(),
            device_name: "disconnected interface".to_string(),
            device_id: "missing:device".to_string(),
            input_sample_format: "f32".to_string(),
            audio_format: AudioFormat {
                sample_rate: 48_000,
                bit_depth: 24,
                encoding: "pcm".to_string(),
                channels: 1,
                input_channels: 1,
                input_channel: 1,
            },
            master_audio: "audio/master.wav".to_string(),
            storage_layout_version: 1,
            segment_frames: Some(48_000 * 300),
            captured_samples: 2,
            committed_samples: 2,
            overflow_samples: 0,
            started_at: "2026-08-10T11:00:00Z".to_string(),
            updated_at: "2026-08-10T12:00:00Z".to_string(),
            noise_check: None,
            silence_duration_ms: 1_000,
            silence_threshold_dbfs: -42.0,
            items: vec![ItemState {
                id: "001".to_string(),
                text: "测试文本".to_string(),
                label: String::new(),
                status: "accepted".to_string(),
                attempts: Vec::new(),
                selected_attempt_id: None,
            }],
        };
        std::fs::write(
            root.join("metadata/items.snapshot.json"),
            serde_json::to_vec_pretty(&snapshot).unwrap(),
        )
        .unwrap();
        let mut engine = Engine::new(Emitter::new());
        let result = dispatch(
            &mut engine,
            CommandEnvelope {
                protocol_version: PROTOCOL_VERSION,
                request_id: "seal-1".to_string(),
                command: "seal_interrupted_session".to_string(),
                payload: json!({ "session_dir": root.to_string_lossy() }),
            },
        )
        .unwrap();
        assert_eq!(result["no_op"].as_bool(), Some(true));
        assert_eq!(result["durable_frames"].as_u64(), Some(2));
        let _ = std::fs::remove_dir_all(root);
    }
}
