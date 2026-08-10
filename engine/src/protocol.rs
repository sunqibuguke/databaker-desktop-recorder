use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::io::{self, Write};
use std::sync::{Arc, Mutex};

pub const PROTOCOL_VERSION: u32 = 1;

#[derive(Debug, Deserialize)]
pub struct CommandEnvelope {
    pub protocol_version: u32,
    pub request_id: String,
    pub command: String,
    #[serde(default)]
    pub payload: Value,
}

#[derive(Debug, Serialize)]
pub struct ProtocolError {
    pub code: String,
    pub message: String,
}

#[derive(Clone)]
pub struct Emitter {
    stdout: Arc<Mutex<io::Stdout>>,
}

impl Emitter {
    pub fn new() -> Self {
        Self {
            stdout: Arc::new(Mutex::new(io::stdout())),
        }
    }

    pub fn response_ok(&self, request_id: &str, result: Value) {
        self.write(json!({
            "protocol_version": PROTOCOL_VERSION,
            "request_id": request_id,
            "ok": true,
            "result": result,
        }));
    }

    pub fn response_error(&self, request_id: &str, code: &str, message: impl Into<String>) {
        self.write(json!({
            "protocol_version": PROTOCOL_VERSION,
            "request_id": request_id,
            "ok": false,
            "error": ProtocolError { code: code.to_string(), message: message.into() },
        }));
    }

    pub fn event(&self, event: &str, payload: Value) {
        self.write(json!({
            "protocol_version": PROTOCOL_VERSION,
            "event": event,
            "payload": payload,
        }));
    }

    fn write(&self, value: Value) {
        let Ok(mut stdout) = self.stdout.lock() else {
            return;
        };
        if serde_json::to_writer(&mut *stdout, &value).is_ok() {
            let _ = stdout.write_all(b"\n");
            let _ = stdout.flush();
        }
    }
}
