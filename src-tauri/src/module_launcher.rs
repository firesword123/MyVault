use crate::{core, module_protocol, player};
use std::{
    mem::{size_of, zeroed},
    process::{Child, Command, Stdio},
    ptr::null,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    thread,
    time::{Duration, Instant},
};
use tauri::AppHandle;
use uuid::Uuid;
use windows_sys::Win32::{
    Foundation::{CloseHandle, HANDLE},
    System::{
        JobObjects::{
            AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
            SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
            JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
        },
        Threading::{OpenProcess, PROCESS_SET_QUOTA, PROCESS_TERMINATE},
    },
};

#[derive(Clone)]
pub(crate) struct ModuleManager {
    inner: Arc<ModuleManagerInner>,
}

struct ModuleManagerInner {
    asmr: Mutex<Option<ModuleProcess>>,
    gallery: Mutex<Option<ModuleProcess>>,
    job: JobHandle,
}

struct ModuleProcess {
    child: Child,
    session: String,
    pipe: Arc<module_protocol::PipeHandle>,
    ready: Arc<AtomicBool>,
    started_at: Instant,
}

#[derive(Clone, Copy)]
enum ModuleKind {
    Asmr,
    Gallery,
}

impl ModuleKind {
    fn id(self) -> &'static str {
        match self {
            Self::Asmr => module_protocol::MODULE_ID,
            Self::Gallery => "gallery",
        }
    }

    fn display_name(self) -> &'static str {
        match self {
            Self::Asmr => "DL_ASMR",
            Self::Gallery => "Gallery",
        }
    }

    fn executable_name(self) -> &'static str {
        match self {
            Self::Asmr => "myvault-dl-asmr.exe",
            Self::Gallery => "myvault-gallery.exe",
        }
    }
}

struct JobHandle(usize);

unsafe impl Send for JobHandle {}
unsafe impl Sync for JobHandle {}

impl Drop for JobHandle {
    fn drop(&mut self) {
        unsafe {
            CloseHandle(self.0 as HANDLE);
        }
    }
}

impl ModuleManager {
    pub(crate) fn new() -> Result<Self, String> {
        Ok(Self {
            inner: Arc::new(ModuleManagerInner {
                asmr: Mutex::new(None),
                gallery: Mutex::new(None),
                job: JobHandle(create_module_job()?),
            }),
        })
    }

    pub(crate) fn launch_asmr(&self, app: &AppHandle) -> Result<String, String> {
        self.launch(app, ModuleKind::Asmr)
    }

    pub(crate) fn launch_gallery(&self, app: &AppHandle) -> Result<String, String> {
        self.launch(app, ModuleKind::Gallery)
    }

    fn launch(&self, app: &AppHandle, kind: ModuleKind) -> Result<String, String> {
        let registry = match kind {
            ModuleKind::Asmr => &self.inner.asmr,
            ModuleKind::Gallery => &self.inner.gallery,
        };
        let mut slot = registry
            .lock()
            .map_err(|_| format!("{} module registry is poisoned", kind.display_name()))?;

        if let Some(process) = slot.as_mut() {
            match process.child.try_wait() {
                Ok(None) if process.ready.load(Ordering::Acquire) => {
                    send_open_and_focus(process)?;
                    return Ok("focused".to_string());
                }
                Ok(None) if process.started_at.elapsed() < Duration::from_secs(10) => {
                    return Ok("starting".to_string());
                }
                Ok(None) => {
                    let _ = process.child.kill();
                    let _ = process.child.wait();
                }
                Ok(Some(_)) => {}
                Err(error) => {
                    return Err(format!(
                        "failed to inspect {} module: {error}",
                        kind.display_name()
                    ))
                }
            }
            *slot = None;
        }

        core::ensure_vault_layout(app)?;
        let data_root = core::data_root_dir(app)?
            .canonicalize()
            .map_err(|error| format!("failed to resolve data root: {error}"))?;
        let session = Uuid::new_v4().to_string();
        let pipe_name = module_protocol::pipe_path(&session);
        let pipe = Arc::new(module_protocol::create_server(&pipe_name)?);
        let executable = resolve_module_executable(kind)?;

        let mut child = Command::new(&executable)
            .arg("--data-root")
            .arg(&data_root)
            .arg("--module")
            .arg(kind.id())
            .arg("--session")
            .arg(&session)
            .arg("--parent-pid")
            .arg(std::process::id().to_string())
            .arg("--pipe")
            .arg(&pipe_name)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|error| {
                format!(
                    "failed to start {} module at {}: {error}",
                    kind.display_name(),
                    executable.display()
                )
            })?;

        if let Err(error) = assign_to_job(self.inner.job.0, child.id()) {
            let _ = child.kill();
            let _ = child.wait();
            return Err(error);
        }

        let ready = Arc::new(AtomicBool::new(false));
        spawn_handshake_worker(
            app.clone(),
            kind,
            pipe.clone(),
            ready.clone(),
            session.clone(),
            child.id(),
        );
        *slot = Some(ModuleProcess {
            child,
            session,
            pipe,
            ready,
            started_at: Instant::now(),
        });
        Ok("started".to_string())
    }

    pub(crate) fn shutdown_all(&self) {
        self.shutdown(ModuleKind::Asmr);
        self.shutdown(ModuleKind::Gallery);
    }

    fn shutdown(&self, kind: ModuleKind) {
        let registry = match kind {
            ModuleKind::Asmr => &self.inner.asmr,
            ModuleKind::Gallery => &self.inner.gallery,
        };
        let Ok(mut slot) = registry.lock() else {
            return;
        };
        let Some(process) = slot.as_mut() else {
            return;
        };

        let mut shutdown = module_protocol::base_message(&process.session, "shutdown");
        shutdown["reason"] = "main-process-exit".into();
        let _ = process.pipe.send(&shutdown);

        let deadline = Instant::now() + Duration::from_secs(5);
        while Instant::now() < deadline {
            match process.child.try_wait() {
                Ok(Some(_)) => {
                    *slot = None;
                    return;
                }
                Ok(None) => thread::sleep(Duration::from_millis(50)),
                Err(_) => break,
            }
        }
        let _ = process.child.kill();
        let _ = process.child.wait();
        *slot = None;
    }
}

#[tauri::command]
pub(crate) fn launch_asmr_module(
    app: AppHandle,
    manager: tauri::State<'_, ModuleManager>,
) -> Result<String, String> {
    manager.launch_asmr(&app)
}

#[tauri::command]
pub(crate) fn launch_gallery_module(
    app: AppHandle,
    manager: tauri::State<'_, ModuleManager>,
) -> Result<String, String> {
    manager.launch_gallery(&app)
}

fn send_open_and_focus(process: &ModuleProcess) -> Result<(), String> {
    let mut open = module_protocol::base_message(&process.session, "open");
    open["target"] = serde_json::Value::Null;
    process.pipe.send(&open)?;
    process
        .pipe
        .send(&module_protocol::base_message(&process.session, "focus"))
}

fn spawn_handshake_worker(
    app: AppHandle,
    kind: ModuleKind,
    pipe: Arc<module_protocol::PipeHandle>,
    ready: Arc<AtomicBool>,
    session: String,
    expected_pid: u32,
) {
    thread::spawn(move || {
        let result = (|| -> Result<(), String> {
            module_protocol::accept_server(&pipe, Duration::from_secs(10))?;
            let hello = pipe.receive()?;
            module_protocol::validate_message(&hello, &session, "hello")?;
            if hello.get("module").and_then(serde_json::Value::as_str) != Some(kind.id()) {
                return Err(format!("{} module identity mismatch", kind.display_name()));
            }
            if hello.get("pid").and_then(serde_json::Value::as_u64) != Some(expected_pid as u64) {
                return Err(format!("{} module process mismatch", kind.display_name()));
            }
            if hello
                .get("moduleVersion")
                .and_then(serde_json::Value::as_str)
                != Some(env!("CARGO_PKG_VERSION"))
            {
                return Err(format!("{} module version mismatch", kind.display_name()));
            }

            let ready_message = pipe.receive()?;
            module_protocol::validate_message(&ready_message, &session, "ready")?;
            ready.store(true, Ordering::Release);
            let mut open = module_protocol::base_message(&session, "open");
            open["target"] = serde_json::Value::Null;
            pipe.send(&open)?;

            loop {
                let message = pipe.receive()?;
                validate_module_message(&message, &session)?;
                match message.get("type").and_then(serde_json::Value::as_str) {
                    Some("player.replace_queue") => {
                        if !matches!(kind, ModuleKind::Asmr) {
                            return Err(
                                "Gallery module cannot replace the player queue".to_string()
                            );
                        }
                        let payload = message
                            .get("payload")
                            .cloned()
                            .ok_or_else(|| "player queue payload is missing".to_string())?;
                        validate_player_queue(&app, &payload)?;
                        player::replace_queue(&app, payload)?;
                    }
                    Some("state") => {}
                    Some("error") => {
                        return Err(message
                            .get("message")
                            .and_then(serde_json::Value::as_str)
                            .unwrap_or("module reported an error")
                            .to_string())
                    }
                    Some(message_type) => {
                        return Err(format!(
                            "unsupported {} message type: {message_type}",
                            kind.display_name()
                        ))
                    }
                    None => return Err("DL_ASMR message type is missing".to_string()),
                }
            }
        })();

        if let Err(error) = result {
            let mut message = module_protocol::base_message(&session, "error");
            message["code"] = "handshake_failed".into();
            message["message"] = error.into();
            let _ = pipe.send(&message);
            let mut shutdown = module_protocol::base_message(&session, "shutdown");
            shutdown["reason"] = "handshake-failed".into();
            let _ = pipe.send(&shutdown);
        }
    });
}

fn validate_module_message(message: &serde_json::Value, session: &str) -> Result<(), String> {
    if message.get("version").and_then(serde_json::Value::as_u64)
        != Some(module_protocol::PROTOCOL_VERSION)
    {
        return Err("module protocol version mismatch".to_string());
    }
    if message.get("session").and_then(serde_json::Value::as_str) != Some(session) {
        return Err("module session mismatch".to_string());
    }
    if message
        .get("requestId")
        .and_then(serde_json::Value::as_str)
        .is_none()
    {
        return Err("module request id is missing".to_string());
    }
    Ok(())
}

fn validate_player_queue(app: &AppHandle, payload: &serde_json::Value) -> Result<(), String> {
    let tracks = payload
        .get("tracks")
        .and_then(serde_json::Value::as_array)
        .ok_or_else(|| "player queue tracks are missing".to_string())?;
    if tracks.is_empty() || tracks.len() > 2_000 {
        return Err("player queue must contain between 1 and 2000 tracks".to_string());
    }
    let start_index = payload
        .get("startIndex")
        .and_then(serde_json::Value::as_u64)
        .ok_or_else(|| "player queue start index is missing".to_string())?
        as usize;
    if start_index >= tracks.len() {
        return Err("player queue start index is out of range".to_string());
    }
    let vault = core::vault_dir(app)?
        .canonicalize()
        .map_err(|error| format!("failed to resolve Vault path: {error}"))?;
    for track in tracks {
        for field in [
            "id",
            "title",
            "workId",
            "workTitle",
            "absolutePath",
            "relativePath",
        ] {
            if track
                .get(field)
                .and_then(serde_json::Value::as_str)
                .filter(|value| !value.is_empty())
                .is_none()
            {
                return Err(format!("player queue track field {field} is missing"));
            }
        }
        let absolute_path = std::path::PathBuf::from(
            track
                .get("absolutePath")
                .and_then(serde_json::Value::as_str)
                .expect("absolutePath was validated"),
        )
        .canonicalize()
        .map_err(|error| format!("failed to resolve playback file: {error}"))?;
        if !absolute_path.starts_with(&vault) || !absolute_path.is_file() {
            return Err("player queue track is outside the active Vault".to_string());
        }
        if let Some(subtitle_path) = track
            .get("subtitlePath")
            .and_then(serde_json::Value::as_str)
        {
            let normalized = subtitle_path.replace('\\', "/");
            let path = std::path::Path::new(&normalized);
            if normalized.is_empty()
                || path.is_absolute()
                || normalized
                    .split('/')
                    .any(|segment| segment.is_empty() || segment == "." || segment == "..")
            {
                return Err("player queue subtitle path is invalid".to_string());
            }
        }
    }
    Ok(())
}

fn resolve_module_executable(kind: ModuleKind) -> Result<std::path::PathBuf, String> {
    let current = std::env::current_exe()
        .map_err(|error| format!("failed to locate MyVault executable: {error}"))?;
    let directory = current
        .parent()
        .ok_or_else(|| "failed to locate MyVault executable directory".to_string())?;
    let executable = directory.join(kind.executable_name());
    if !executable.is_file() {
        return Err(format!(
            "{} module executable is missing: {}",
            kind.display_name(),
            executable.display()
        ));
    }
    Ok(executable)
}

fn create_module_job() -> Result<usize, String> {
    let job = unsafe { CreateJobObjectW(null(), null()) };
    if job.is_null() {
        return Err(format!(
            "failed to create module Job Object: {}",
            std::io::Error::last_os_error()
        ));
    }

    let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { zeroed() };
    limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    let configured = unsafe {
        SetInformationJobObject(
            job,
            JobObjectExtendedLimitInformation,
            &limits as *const _ as *const _,
            size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
        )
    } != 0;
    if !configured {
        unsafe {
            CloseHandle(job);
        }
        return Err(format!(
            "failed to configure module Job Object: {}",
            std::io::Error::last_os_error()
        ));
    }
    Ok(job as usize)
}

fn assign_to_job(job: usize, pid: u32) -> Result<(), String> {
    let process = unsafe { OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE, 0, pid) };
    if process.is_null() {
        return Err(format!(
            "failed to open DL_ASMR process for Job Object assignment: {}",
            std::io::Error::last_os_error()
        ));
    }
    let assigned = unsafe { AssignProcessToJobObject(job as HANDLE, process) } != 0;
    unsafe {
        CloseHandle(process);
    }
    if !assigned {
        return Err(format!(
            "failed to assign DL_ASMR process to Job Object: {}",
            std::io::Error::last_os_error()
        ));
    }
    Ok(())
}
