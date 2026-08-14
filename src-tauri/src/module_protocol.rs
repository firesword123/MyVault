use serde_json::Value;
use std::{
    io,
    ptr::{null, null_mut},
    sync::Mutex,
    thread,
    time::{Duration, Instant},
};
use windows_sys::Win32::{
    Foundation::{
        CloseHandle, GetLastError, ERROR_PIPE_CONNECTED, ERROR_PIPE_LISTENING, GENERIC_READ,
        GENERIC_WRITE, HANDLE, INVALID_HANDLE_VALUE,
    },
    Storage::FileSystem::{
        CreateFileW, ReadFile, WriteFile, FILE_ATTRIBUTE_NORMAL, OPEN_EXISTING, PIPE_ACCESS_DUPLEX,
    },
    System::Pipes::{
        ConnectNamedPipe, CreateNamedPipeW, PeekNamedPipe, SetNamedPipeHandleState, WaitNamedPipeW,
        PIPE_NOWAIT, PIPE_READMODE_BYTE, PIPE_REJECT_REMOTE_CLIENTS, PIPE_TYPE_BYTE,
        PIPE_UNLIMITED_INSTANCES, PIPE_WAIT,
    },
};

pub(crate) const PROTOCOL_VERSION: u64 = 1;
pub(crate) const MODULE_ID: &str = "dl_asmr";
const MAX_MESSAGE_BYTES: usize = 1024 * 1024;

pub(crate) struct PipeHandle {
    raw: usize,
    write_lock: Mutex<()>,
}

unsafe impl Send for PipeHandle {}
unsafe impl Sync for PipeHandle {}

impl PipeHandle {
    fn new(raw: HANDLE) -> Self {
        Self {
            raw: raw as usize,
            write_lock: Mutex::new(()),
        }
    }

    fn raw(&self) -> HANDLE {
        self.raw as HANDLE
    }

    pub(crate) fn send(&self, message: &Value) -> Result<(), String> {
        let _guard = self
            .write_lock
            .lock()
            .map_err(|_| "module pipe write lock is poisoned".to_string())?;
        let payload = serde_json::to_vec(message)
            .map_err(|error| format!("failed to encode module message: {error}"))?;
        if payload.len() > MAX_MESSAGE_BYTES {
            return Err("module message exceeds 1 MiB".to_string());
        }
        write_all(self.raw(), &(payload.len() as u32).to_le_bytes())?;
        write_all(self.raw(), &payload)
    }

    pub(crate) fn receive(&self) -> Result<Value, String> {
        let mut length = [0_u8; 4];
        read_exact(self.raw(), &mut length)?;
        let length = u32::from_le_bytes(length) as usize;
        if length == 0 || length > MAX_MESSAGE_BYTES {
            return Err("invalid module message length".to_string());
        }
        let mut payload = vec![0_u8; length];
        read_exact(self.raw(), &mut payload)?;
        serde_json::from_slice(&payload)
            .map_err(|error| format!("failed to decode module message: {error}"))
    }
}

impl Drop for PipeHandle {
    fn drop(&mut self) {
        unsafe {
            CloseHandle(self.raw());
        }
    }
}

pub(crate) fn pipe_path(session: &str) -> String {
    format!(r"\\.\pipe\myvault-{session}")
}

pub(crate) fn create_server(path: &str) -> Result<PipeHandle, String> {
    let path = wide(path);
    let raw = unsafe {
        CreateNamedPipeW(
            path.as_ptr(),
            PIPE_ACCESS_DUPLEX,
            PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_NOWAIT | PIPE_REJECT_REMOTE_CLIENTS,
            PIPE_UNLIMITED_INSTANCES,
            64 * 1024,
            64 * 1024,
            10_000,
            null(),
        )
    };
    if raw == INVALID_HANDLE_VALUE {
        return Err(last_error("failed to create module pipe"));
    }
    Ok(PipeHandle::new(raw))
}

pub(crate) fn accept_server(pipe: &PipeHandle, timeout: Duration) -> Result<(), String> {
    let deadline = Instant::now() + timeout;
    loop {
        let connected = unsafe { ConnectNamedPipe(pipe.raw(), null_mut()) } != 0;
        if connected {
            break;
        }
        let error = unsafe { GetLastError() };
        if error == ERROR_PIPE_CONNECTED {
            break;
        }
        if error != ERROR_PIPE_LISTENING {
            return Err(format!(
                "failed to accept module pipe: Windows error {error}"
            ));
        }
        if Instant::now() >= deadline {
            return Err("module did not connect within 10 seconds".to_string());
        }
        thread::sleep(Duration::from_millis(50));
    }

    let mode = PIPE_READMODE_BYTE | PIPE_WAIT;
    let changed = unsafe { SetNamedPipeHandleState(pipe.raw(), &mode, null(), null()) } != 0;
    if !changed {
        return Err(last_error("failed to switch module pipe to blocking mode"));
    }
    Ok(())
}

#[allow(dead_code)]
pub(crate) fn connect_client(path: &str, timeout: Duration) -> Result<PipeHandle, String> {
    let path = wide(path);
    let timeout_ms = timeout.as_millis().min(u32::MAX as u128) as u32;
    let available = unsafe { WaitNamedPipeW(path.as_ptr(), timeout_ms) } != 0;
    if !available {
        return Err(last_error("module pipe was not available"));
    }
    let raw = unsafe {
        CreateFileW(
            path.as_ptr(),
            GENERIC_READ | GENERIC_WRITE,
            0,
            null(),
            OPEN_EXISTING,
            FILE_ATTRIBUTE_NORMAL,
            null_mut(),
        )
    };
    if raw == INVALID_HANDLE_VALUE {
        return Err(last_error("failed to connect to module pipe"));
    }
    Ok(PipeHandle::new(raw))
}

pub(crate) fn base_message(session: &str, message_type: &str) -> Value {
    serde_json::json!({
        "version": PROTOCOL_VERSION,
        "session": session,
        "type": message_type,
        "requestId": uuid::Uuid::new_v4().to_string(),
    })
}

pub(crate) fn validate_message(
    message: &Value,
    session: &str,
    expected_type: &str,
) -> Result<(), String> {
    if message.get("version").and_then(Value::as_u64) != Some(PROTOCOL_VERSION) {
        return Err("module protocol version mismatch".to_string());
    }
    if message.get("session").and_then(Value::as_str) != Some(session) {
        return Err("module session mismatch".to_string());
    }
    if message.get("type").and_then(Value::as_str) != Some(expected_type) {
        return Err(format!("expected module message type {expected_type}"));
    }
    Ok(())
}

fn wide(value: &str) -> Vec<u16> {
    value.encode_utf16().chain(std::iter::once(0)).collect()
}

fn last_error(context: &str) -> String {
    let error = io::Error::last_os_error();
    format!("{context}: {error}")
}

fn write_all(handle: HANDLE, mut bytes: &[u8]) -> Result<(), String> {
    while !bytes.is_empty() {
        let mut written = 0_u32;
        let ok = unsafe {
            WriteFile(
                handle,
                bytes.as_ptr(),
                bytes.len().min(u32::MAX as usize) as u32,
                &mut written,
                null_mut(),
            )
        } != 0;
        if !ok || written == 0 {
            return Err(last_error("failed to write module pipe"));
        }
        bytes = &bytes[written as usize..];
    }
    Ok(())
}

fn read_exact(handle: HANDLE, bytes: &mut [u8]) -> Result<(), String> {
    let mut offset = 0;
    while offset < bytes.len() {
        let mut available = 0_u32;
        let peeked = unsafe {
            PeekNamedPipe(
                handle,
                null_mut(),
                0,
                null_mut(),
                &mut available,
                null_mut(),
            )
        } != 0;
        if !peeked {
            return Err(last_error("failed to inspect module pipe"));
        }
        if available == 0 {
            thread::sleep(Duration::from_millis(10));
            continue;
        }

        let mut read = 0_u32;
        let requested = (bytes.len() - offset)
            .min(available as usize)
            .min(u32::MAX as usize) as u32;
        let ok = unsafe {
            ReadFile(
                handle,
                bytes[offset..].as_mut_ptr(),
                requested,
                &mut read,
                null_mut(),
            )
        } != 0;
        if !ok || read == 0 {
            return Err(last_error("failed to read module pipe"));
        }
        offset += read as usize;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{mpsc, Arc};

    #[test]
    fn named_pipe_round_trip_uses_framed_json() {
        let session = uuid::Uuid::new_v4().to_string();
        let path = pipe_path(&session);
        let server = Arc::new(create_server(&path).expect("create server pipe"));
        let client_path = path.clone();
        let client_session = session.clone();
        let client = thread::spawn(move || {
            let pipe =
                connect_client(&client_path, Duration::from_secs(2)).expect("connect client");
            let hello = base_message(&client_session, "hello");
            pipe.send(&hello).expect("send hello");
            let focus = pipe.receive().expect("receive focus");
            validate_message(&focus, &client_session, "focus").expect("validate focus");
        });

        accept_server(&server, Duration::from_secs(2)).expect("accept client");
        let hello = server.receive().expect("receive hello");
        validate_message(&hello, &session, "hello").expect("validate hello");
        server
            .send(&base_message(&session, "focus"))
            .expect("send focus");
        client.join().expect("join client");
    }

    #[test]
    fn rejects_a_stale_session() {
        let message = base_message("old-session", "hello");
        let error = validate_message(&message, "current-session", "hello")
            .expect_err("stale session must fail");
        assert!(error.contains("session mismatch"));
    }

    #[test]
    fn full_duplex_send_is_not_blocked_by_an_idle_receiver() {
        let session = uuid::Uuid::new_v4().to_string();
        let path = pipe_path(&session);
        let server = Arc::new(create_server(&path).expect("create server pipe"));
        let client_path = path.clone();
        let client_thread = thread::spawn(move || {
            Arc::new(connect_client(&client_path, Duration::from_secs(2)).expect("connect client"))
        });
        accept_server(&server, Duration::from_secs(2)).expect("accept client");
        let client = client_thread.join().expect("join client connector");

        let (result_tx, result_rx) = mpsc::channel();
        for (pipe, expected_type) in [(server.clone(), "state"), (client.clone(), "focus")] {
            let expected_session = session.clone();
            let result_tx = result_tx.clone();
            thread::spawn(move || {
                let result = pipe.receive().and_then(|message| {
                    validate_message(&message, &expected_session, expected_type)
                });
                let _ = result_tx.send(result);
            });
        }

        thread::sleep(Duration::from_millis(50));
        let server_sender = server.clone();
        let server_session = session.clone();
        let result_tx_server = result_tx.clone();
        thread::spawn(move || {
            let _ =
                result_tx_server.send(server_sender.send(&base_message(&server_session, "focus")));
        });
        let client_sender = client.clone();
        let client_session = session.clone();
        thread::spawn(move || {
            let _ = result_tx.send(client_sender.send(&base_message(&client_session, "state")));
        });

        for _ in 0..4 {
            result_rx
                .recv_timeout(Duration::from_secs(2))
                .expect("full-duplex pipe operation timed out")
                .expect("full-duplex pipe operation failed");
        }
    }
}
