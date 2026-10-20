mod results;

use dax_workbench_engine::{error, protocol, store};
use error::EngineError;
use protocol::Request;
use results::Results;
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    io::{BufReader, Read, Write},
    path::PathBuf,
    process::{Child, Command, Stdio},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
        mpsc::{self, Receiver, SyncSender, TrySendError},
    },
    thread,
    time::{Duration, Instant},
};

const MAX_PENDING: usize = 64;
const CANCEL_RESERVE: usize = 16;
const STARTUP_TIMEOUT: Duration = Duration::from_secs(15);
const SHUTDOWN_TIMEOUT: Duration = Duration::from_secs(8);
const HEALTH_ID: &str = "@engine:startup-health";

struct Pending {
    token: u64,
    method: String,
    run_id: Option<String>,
    forwarded: bool,
    cancelled: bool,
    finishing: bool,
    cache_started: bool,
    cache_params: Option<Value>,
}

#[derive(Default)]
struct Admissions {
    next: u64,
    requests: HashMap<String, Pending>,
}

struct Frame {
    bytes: Vec<u8>,
    completion: Option<u64>,
}

enum Control {
    Health(u64),
    Eof,
    Failed,
}

struct Work {
    token: u64,
    method: String,
    params: Value,
}

struct Shared {
    results: Arc<Results>,
    pending: Mutex<Admissions>,
    output: SyncSender<Frame>,
    provider: SyncSender<Vec<u8>>,
    control: SyncSender<Control>,
    failed: AtomicBool,
    closing: AtomicBool,
}

fn busy() -> EngineError {
    EngineError::new("HOST_BUSY", "Too many concurrent requests.")
}

impl Shared {
    fn fail(&self) {
        if !self.failed.swap(true, Ordering::AcqRel) {
            let _ = self.control.try_send(Control::Failed);
        }
    }

    fn emit(&self, message: Value, completion: Option<u64>) {
        self.emit_until(message, completion, Instant::now() + Duration::from_secs(2));
    }

    fn emit_until(&self, message: Value, completion: Option<u64>, deadline: Instant) {
        let bytes = match protocol::encode(&message) {
            Ok(bytes) => bytes,
            Err(error) if completion.is_some() => {
                let id = message.get("id").and_then(Value::as_str).unwrap_or("");
                match protocol::encode(&json!({"id": id, "error": error})) {
                    Ok(bytes) => bytes,
                    Err(_) => {
                        self.fail();
                        return;
                    }
                }
            }
            Err(_) => {
                self.fail();
                return;
            }
        };
        let mut frame = Frame { bytes, completion };
        loop {
            match self.output.try_send(frame) {
                Ok(()) => return,
                Err(TrySendError::Full(value)) if Instant::now() < deadline => {
                    frame = value;
                    thread::sleep(Duration::from_millis(2));
                }
                _ => {
                    self.fail();
                    return;
                }
            }
        }
    }

    fn error(&self, id: &str, error: EngineError) {
        self.emit(json!({"id": id, "error": error}), None);
    }

    fn reserve(&self, request: &Request) -> Result<u64, EngineError> {
        if self.failed.load(Ordering::Acquire) {
            return Err(EngineError::unavailable());
        }
        let mut pending = self
            .pending
            .lock()
            .map_err(|_| EngineError::unavailable())?;
        if pending.requests.contains_key(&request.id) {
            return Err(EngineError::new(
                "DUPLICATE_REQUEST",
                "This request ID is already active.",
            ));
        }
        let cancellation = request.method == "query.cancel";
        let count = pending
            .requests
            .values()
            .filter(|p| (p.method == "query.cancel") == cancellation)
            .count();
        if count
            >= if cancellation {
                CANCEL_RESERVE
            } else {
                MAX_PENDING
            }
        {
            return Err(busy());
        }
        pending.next = pending
            .next
            .checked_add(1)
            .ok_or_else(EngineError::unavailable)?;
        let token = pending.next;
        pending.requests.insert(
            request.id.clone(),
            Pending {
                token,
                method: request.method.clone(),
                run_id: request
                    .params
                    .get("runId")
                    .and_then(Value::as_str)
                    .map(str::to_owned),
                forwarded: false,
                cancelled: false,
                finishing: false,
                cache_started: false,
                cache_params: (request.method == "query.execute"
                    && request.params.get("cacheResults") == Some(&Value::Bool(true)))
                .then(|| {
                    json!({
                        "cacheResults": true, "workbenchId": request.params.get("workbenchId"),
                        "runId": request.params.get("runId")
                    })
                }),
            },
        );
        Ok(token)
    }

    fn finish(&self, token: u64, result: Result<Value, EngineError>) {
        self.finish_until(token, result, Instant::now() + Duration::from_secs(2));
    }

    fn finish_until(&self, token: u64, result: Result<Value, EngineError>, deadline: Instant) {
        let (id, cache_params) = {
            let Ok(mut pending) = self.pending.lock() else {
                self.fail();
                return;
            };
            let Some((id, entry)) = pending.requests.iter_mut().find(|(_, p)| p.token == token)
            else {
                return;
            };
            if entry.finishing {
                return;
            }
            entry.finishing = true;
            (
                id.clone(),
                entry.cache_params.clone().filter(|_| entry.cache_started),
            )
        };
        if let Some(params) = cache_params
            && let Err(error) = self.results.finish(&params)
        {
            self.emit_until(
                json!({"event": "query.cacheError", "runId": params["runId"], "error": error}),
                None,
                deadline,
            );
        }
        let response = match result {
            Ok(result) => json!({"id": id, "result": result}),
            Err(error) => json!({"id": id, "error": error}),
        };
        self.emit_until(response, Some(token), deadline);
    }

    fn acknowledge(&self, token: u64) {
        if let Ok(mut pending) = self.pending.lock() {
            pending.requests.retain(|_, p| p.token != token);
        }
    }

    fn fail_pending(&self) {
        let tokens = self
            .pending
            .lock()
            .map(|p| {
                p.requests
                    .values()
                    .filter(|p| !p.finishing)
                    .map(|p| p.token)
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        let deadline = Instant::now() + Duration::from_secs(2);
        for token in tokens {
            self.finish_until(token, Err(EngineError::unavailable()), deadline);
        }
    }

    fn forward(&self, work: Work) -> Result<(), EngineError> {
        if self.failed.load(Ordering::Acquire) {
            return Err(EngineError::unavailable());
        }
        let bytes = protocol::encode(&json!({
            "id": format!("@engine:request:{}", work.token),
            "method": work.method,
            "params": work.params,
        }))?;
        let mut pending = self
            .pending
            .lock()
            .map_err(|_| EngineError::unavailable())?;
        // Enqueue execution and cancellation while holding the same short gate.
        // A cancellation cannot race ahead of an execution being forwarded.
        if work.method == "query.cancel" {
            let run_id = protocol::required(&work.params, "runId", 128)?;
            for entry in pending.requests.values_mut() {
                if entry.method == "query.execute"
                    && entry.run_id.as_deref() == Some(run_id)
                    && !entry.forwarded
                {
                    entry.cancelled = true;
                }
            }
        }
        let Some(entry) = pending
            .requests
            .values_mut()
            .find(|p| p.token == work.token)
        else {
            return Err(EngineError::unavailable());
        };
        if entry.finishing {
            return Ok(());
        }
        if entry.cancelled {
            drop(pending);
            self.finish(
                work.token,
                Ok(json!({
                    "runId": work.params.get("runId"),
                    "status": "cancelled", "resultSets": [], "rowCount": 0, "durationMs": 0,
                    "truncated": false, "unreadResultSets": true, "warnings": [],
                    "error": {"code": "CANCELLED", "message": "The query was cancelled."}
                })),
            );
            return Ok(());
        }
        self.provider.try_send(bytes).map_err(|error| match error {
            TrySendError::Full(_) => busy(),
            TrySendError::Disconnected(_) => {
                self.fail();
                EngineError::unavailable()
            }
        })?;
        entry.forwarded = true;
        Ok(())
    }
}

fn spawn_output(shared: Arc<Shared>, receiver: Receiver<Frame>) {
    thread::spawn(move || {
        let stdout = std::io::stdout();
        let mut output = stdout.lock();
        while let Ok(frame) = receiver.recv() {
            if output
                .write_all(&frame.bytes)
                .and_then(|_| output.flush())
                .is_err()
            {
                shared.fail();
                return;
            }
            if let Some(token) = frame.completion {
                shared.acknowledge(token);
            }
        }
    });
}

fn queue(shared: &Shared, sender: &SyncSender<Work>, work: Work) {
    let token = work.token;
    if let Err(error) = sender.try_send(work) {
        shared.finish(
            token,
            Err(match error {
                TrySendError::Full(_) => busy(),
                TrySendError::Disconnected(_) => {
                    shared.fail();
                    EngineError::unavailable()
                }
            }),
        );
    }
}

fn spawn_input(
    shared: Arc<Shared>,
    store: SyncSender<Work>,
    results: SyncSender<Work>,
    queries: SyncSender<Work>,
) {
    thread::spawn(move || {
        let stdin = std::io::stdin();
        let mut reader = BufReader::new(stdin.lock());
        loop {
            let bytes = match protocol::read_line(&mut reader) {
                Ok(Some(Ok(bytes))) if bytes.is_empty() => continue,
                Ok(Some(Ok(bytes))) => bytes,
                Ok(Some(Err(error))) => {
                    shared.error("", error);
                    continue;
                }
                Ok(None) => {
                    let _ = shared.control.send(Control::Eof);
                    return;
                }
                Err(_) => {
                    shared.fail();
                    return;
                }
            };
            let value = match protocol::parse(&bytes) {
                Ok(value) => value,
                Err(error) => {
                    shared.error("", error);
                    continue;
                }
            };
            let id = protocol::required(&value, "id", 128)
                .unwrap_or("")
                .to_owned();
            let request = match Request::parse(value) {
                Ok(request) => request,
                Err(error) => {
                    shared.error(&id, error);
                    continue;
                }
            };
            let token = match shared.reserve(&request) {
                Ok(token) => token,
                Err(error) => {
                    shared.error(&request.id, error);
                    continue;
                }
            };
            let work = Work {
                token,
                method: request.method,
                params: request.params,
            };
            match work.method.as_str() {
                "health" => {
                    if shared.control.try_send(Control::Health(token)).is_err() {
                        shared.finish(token, Err(busy()));
                    }
                }
                "store.read" | "store.write" => queue(&shared, &store, work),
                "query.execute" => queue(&shared, &queries, work),
                method if method.starts_with("results.") => queue(&shared, &results, work),
                "connections.list"
                | "connections.import"
                | "connections.discover"
                | "connection.add"
                | "connection.details"
                | "schema.get"
                | "query.cancel" => {
                    if let Err(error) = shared.forward(work) {
                        shared.finish(token, Err(error));
                    }
                }
                _ => shared.finish(
                    token,
                    Err(EngineError::new(
                        "METHOD_NOT_FOUND",
                        "This native protocol method is not supported.",
                    )),
                ),
            }
        }
    });
}

fn spawn_store(shared: Arc<Shared>, receiver: Receiver<Work>, mut store: store::Store) {
    thread::spawn(move || {
        while let Ok(work) = receiver.recv() {
            if shared.failed.load(Ordering::Acquire) {
                break;
            }
            let response = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                store.dispatch(&work.method, &work.params)
            }));
            match response {
                Ok(result) => shared.finish(work.token, result),
                Err(_) => {
                    shared.fail();
                    break;
                }
            }
        }
    });
}

fn spawn_queries(shared: Arc<Shared>, receiver: Receiver<Work>) {
    thread::spawn(move || {
        while let Ok(work) = receiver.recv() {
            if shared.failed.load(Ordering::Acquire) {
                break;
            }
            let response = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                shared.results.begin(&work.params)?;
                let admitted = {
                    let mut pending = shared
                        .pending
                        .lock()
                        .map_err(|_| EngineError::unavailable())?;
                    match pending
                        .requests
                        .values_mut()
                        .find(|p| p.token == work.token && !p.finishing)
                    {
                        Some(entry) => {
                            entry.cache_started = true;
                            true
                        }
                        None => false,
                    }
                };
                if !admitted {
                    shared.results.finish(&work.params)?;
                    return Err(EngineError::unavailable());
                }
                Ok(())
            }));
            match response {
                Ok(Ok(())) => {
                    let token = work.token;
                    if let Err(error) = shared.forward(work) {
                        shared.finish(token, Err(error));
                    }
                }
                Ok(Err(error)) => shared.finish(work.token, Err(error)),
                Err(_) => {
                    shared.fail();
                    break;
                }
            }
        }
    });
}

fn spawn_results(shared: Arc<Shared>, receiver: Receiver<Work>) {
    thread::spawn(move || {
        while let Ok(work) = receiver.recv() {
            if shared.failed.load(Ordering::Acquire) {
                break;
            }
            let response = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                shared.results.dispatch(&work.method, &work.params)
            }));
            match response {
                Ok(result) => shared.finish(work.token, result),
                Err(_) => {
                    shared.fail();
                    break;
                }
            }
        }
    });
}

fn provider_reader(
    shared: Arc<Shared>,
    stdout: impl Read + Send + 'static,
    health: SyncSender<Result<Value, EngineError>>,
) {
    thread::spawn(move || {
        let mut reader = BufReader::new(stdout);
        let mut ready = false;
        loop {
            let mut event = match protocol::read_line(&mut reader) {
                Ok(Some(Ok(bytes))) => match protocol::parse(&bytes) {
                    Ok(value) if value.is_object() => value,
                    _ => {
                        shared.fail();
                        break;
                    }
                },
                Ok(None) if shared.closing.load(Ordering::Acquire) => {
                    let unanswered = shared
                        .pending
                        .lock()
                        .map(|pending| {
                            pending
                                .requests
                                .values()
                                .any(|entry| entry.forwarded && !entry.finishing)
                        })
                        .unwrap_or(true);
                    if unanswered {
                        shared.fail();
                    }
                    break;
                }
                _ => {
                    shared.fail();
                    break;
                }
            };
            if !ready {
                if event.get("id").and_then(Value::as_str) != Some(HEALTH_ID) {
                    shared.fail();
                    break;
                }
                let valid = event.get("result").filter(|result| {
                    result.get("protocolVersion").and_then(Value::as_u64) == Some(1)
                        && result
                            .get("version")
                            .and_then(Value::as_str)
                            .is_some_and(|v| !v.is_empty() && v.len() <= 128)
                });
                let Some(result) = valid else {
                    shared.fail();
                    break;
                };
                let _ = health.try_send(Ok(result.clone()));
                ready = true;
                continue;
            }
            if event.get("event").is_some() {
                if event.get("id").is_some() || !event["event"].is_string() {
                    shared.fail();
                    break;
                }
                let run_id = event.get("runId").cloned().unwrap_or(Value::Null);
                let ingested = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    shared.results.ingest(&mut event)
                }));
                match ingested {
                    Ok(Ok(())) => shared.emit(event, None),
                    Ok(Err(error)) => shared.emit(
                        json!({
                            "event": "query.cacheError", "runId": run_id, "error": error
                        }),
                        None,
                    ),
                    Err(_) => {
                        shared.fail();
                        break;
                    }
                }
                continue;
            }
            let token = event
                .get("id")
                .and_then(Value::as_str)
                .and_then(|id| id.strip_prefix("@engine:request:"))
                .and_then(|id| id.parse::<u64>().ok());
            let Some(token) = token else {
                shared.fail();
                break;
            };
            let admitted = shared
                .pending
                .lock()
                .map(|p| {
                    p.requests
                        .values()
                        .any(|p| p.token == token && p.forwarded && !p.finishing)
                })
                .unwrap_or(false);
            if !admitted {
                shared.fail();
                break;
            }
            match (event.get("result"), event.get("error")) {
                (Some(result), None) => shared.finish(token, Ok(result.clone())),
                (None, Some(error)) => {
                    let valid = protocol::required(error, "code", 128).and_then(|code| {
                        protocol::required(error, "message", 4096).map(|message| (code, message))
                    });
                    match valid {
                        Ok((code, message)) => {
                            shared.finish(token, Err(EngineError::new(code, message)))
                        }
                        Err(_) => {
                            shared.fail();
                            break;
                        }
                    }
                }
                _ => {
                    shared.fail();
                    break;
                }
            }
        }
        if !ready {
            let _ = health.try_send(Err(EngineError::unavailable()));
        }
    });
}

#[cfg(windows)]
struct ProviderJob(windows_sys::Win32::Foundation::HANDLE);

#[cfg(windows)]
impl ProviderJob {
    fn new(child: &Child) -> Result<Self, EngineError> {
        use std::{
            mem::{size_of, zeroed},
            os::windows::io::AsRawHandle,
            ptr::null,
        };
        use windows_sys::Win32::System::JobObjects::*;
        unsafe {
            let job = Self(CreateJobObjectW(null(), null()));
            if job.0.is_null() {
                return Err(EngineError::unavailable());
            }
            let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = zeroed();
            info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            if SetInformationJobObject(
                job.0,
                JobObjectExtendedLimitInformation,
                (&info as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),
                size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            ) == 0
                || AssignProcessToJobObject(job.0, child.as_raw_handle()) == 0
            {
                return Err(EngineError::unavailable());
            }
            Ok(job)
        }
    }

    fn terminate(&self) {
        unsafe {
            windows_sys::Win32::System::JobObjects::TerminateJobObject(self.0, 1);
        }
    }
}

#[cfg(windows)]
impl Drop for ProviderJob {
    fn drop(&mut self) {
        if !self.0.is_null() {
            unsafe {
                windows_sys::Win32::Foundation::CloseHandle(self.0);
            }
        }
    }
}

#[cfg(not(windows))]
struct ProviderJob;
#[cfg(not(windows))]
impl ProviderJob {
    fn new(_: &Child) -> Result<Self, EngineError> {
        Err(EngineError::new(
            "PLATFORM_UNSUPPORTED",
            "The native engine requires Windows.",
        ))
    }
    fn terminate(&self) {}
}

fn arguments() -> Result<(PathBuf, PathBuf), EngineError> {
    let mut args = std::env::args_os().skip(1);
    let mut artifacts = None;
    let mut provider = None;
    while let Some(arg) = args.next() {
        let target = if arg == "--artifacts" && artifacts.is_none() {
            &mut artifacts
        } else if arg == "--provider" && provider.is_none() {
            &mut provider
        } else {
            return Err(EngineError::new(
                "INVALID_ARGUMENTS",
                "Use --artifacts <absolute-directory> [--provider <absolute-executable>].",
            ));
        };
        let path = args
            .next()
            .map(PathBuf::from)
            .filter(|path| path.is_absolute())
            .ok_or_else(|| {
                EngineError::new("INVALID_ARGUMENTS", "Native paths must be absolute.")
            })?;
        *target = Some(path);
    }
    let artifacts = artifacts.ok_or_else(|| {
        EngineError::new(
            "INVALID_ARTIFACTS",
            "--artifacts requires an absolute directory.",
        )
    })?;
    let provider = provider
        .or_else(|| {
            std::env::current_exe()
                .ok()
                .and_then(|path| path.parent().map(|dir| dir.join("DaxWorkbench.Host.exe")))
        })
        .ok_or_else(EngineError::unavailable)?;
    Ok((artifacts, provider))
}

fn run() -> Result<i32, EngineError> {
    let (artifacts, provider) = arguments()?;
    if std::fs::canonicalize(&provider).ok()
        == std::env::current_exe()
            .ok()
            .and_then(|p| std::fs::canonicalize(p).ok())
    {
        return Err(EngineError::new(
            "INVALID_ARGUMENTS",
            "The provider must be the separate Microsoft host.",
        ));
    }
    let store = store::Store::open(&artifacts)?;
    let results = Arc::new(Results::new(artifacts.clone()));
    let mut command = Command::new(&provider);
    command
        .arg("--artifacts")
        .arg(&artifacts)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if let Some(directory) = provider.parent() {
        command.current_dir(directory);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(windows_sys::Win32::System::Threading::CREATE_NO_WINDOW);
    }
    let mut child = command.spawn().map_err(|_| EngineError::unavailable())?;
    let job = match ProviderJob::new(&child) {
        Ok(job) => job,
        Err(error) => {
            let _ = child.kill();
            let deadline = Instant::now() + Duration::from_secs(2);
            while Instant::now() < deadline {
                match child.try_wait() {
                    Ok(None) => thread::sleep(Duration::from_millis(10)),
                    _ => break,
                }
            }
            return Err(error);
        }
    };
    let (output_tx, output_rx) = mpsc::sync_channel(16);
    let (provider_tx, provider_rx) = mpsc::sync_channel::<Vec<u8>>(MAX_PENDING + CANCEL_RESERVE);
    let (control_tx, control_rx) = mpsc::sync_channel(128);
    let (health_tx, health_rx) = mpsc::sync_channel(1);
    let shared = Arc::new(Shared {
        results,
        pending: Mutex::new(Admissions::default()),
        output: output_tx,
        provider: provider_tx,
        control: control_tx,
        failed: AtomicBool::new(false),
        closing: AtomicBool::new(false),
    });
    spawn_output(shared.clone(), output_rx);
    let stdout = child.stdout.take().ok_or_else(EngineError::unavailable)?;
    provider_reader(shared.clone(), stdout, health_tx);
    let mut stderr = child.stderr.take().ok_or_else(EngineError::unavailable)?;
    let errors = shared.clone();
    thread::spawn(move || {
        let mut buffer = [0u8; 4096];
        loop {
            match stderr.read(&mut buffer) {
                Ok(0) => break,
                Ok(_) => {
                    zeroize::Zeroize::zeroize(&mut buffer);
                    errors.fail();
                }
                Err(_) => {
                    errors.fail();
                    break;
                }
            }
        }
    });
    let mut stdin = child.stdin.take().ok_or_else(EngineError::unavailable)?;
    let writer = shared.clone();
    thread::spawn(move || {
        loop {
            if writer.closing.load(Ordering::Acquire) || writer.failed.load(Ordering::Acquire) {
                break;
            }
            match provider_rx.recv_timeout(Duration::from_millis(20)) {
                Ok(bytes) => {
                    if stdin.write_all(&bytes).and_then(|_| stdin.flush()).is_err() {
                        writer.fail();
                        break;
                    }
                }
                Err(mpsc::RecvTimeoutError::Timeout) => {}
                Err(_) => break,
            }
        }
        // Dropping the sole stdin handle signals EOF to the owned adapter.
    });
    shared
        .provider
        .send(protocol::encode(
            &json!({"id": HEALTH_ID, "method": "health", "params": {}}),
        )?)
        .map_err(|_| EngineError::unavailable())?;
    let startup = Instant::now();
    let provider_health = loop {
        if shared.failed.load(Ordering::Acquire)
            || child
                .try_wait()
                .map_err(|_| EngineError::unavailable())?
                .is_some()
            || startup.elapsed() >= STARTUP_TIMEOUT
        {
            shared.fail();
            job.terminate();
            return Err(EngineError::unavailable());
        }
        match health_rx.recv_timeout(Duration::from_millis(20)) {
            Ok(result) => break result?,
            Err(mpsc::RecvTimeoutError::Timeout) => {}
            Err(_) => {
                job.terminate();
                return Err(EngineError::unavailable());
            }
        }
    };
    let (store_tx, store_rx) = mpsc::sync_channel(MAX_PENDING);
    let (results_tx, results_rx) = mpsc::sync_channel(MAX_PENDING);
    let (queries_tx, queries_rx) = mpsc::sync_channel(MAX_PENDING);
    spawn_store(shared.clone(), store_rx, store);
    spawn_results(shared.clone(), results_rx);
    spawn_queries(shared.clone(), queries_rx);
    spawn_input(shared.clone(), store_tx, results_tx, queries_tx);
    let mut closing_at = None;
    let mut exited = false;
    let mut code = 0;
    loop {
        if !exited {
            let status = child.try_wait().map_err(|_| EngineError::unavailable())?;
            if status.as_ref().is_some_and(|status| !status.success()) {
                shared.fail();
            }
            exited = status.is_some();
        }
        if shared.failed.load(Ordering::Acquire) || (exited && closing_at.is_none()) {
            shared.fail();
            code = 1;
            break;
        }
        if let Some(at) = closing_at {
            let empty = shared
                .pending
                .lock()
                .map(|p| p.requests.is_empty())
                .unwrap_or(false);
            if (exited && empty) || Instant::now().duration_since(at) >= SHUTDOWN_TIMEOUT {
                break;
            }
        }
        match control_rx.recv_timeout(Duration::from_millis(20)) {
            Ok(Control::Health(token)) => {
                if !exited
                    && !shared.failed.load(Ordering::Acquire)
                    && child
                        .try_wait()
                        .map_err(|_| EngineError::unavailable())?
                        .is_none()
                {
                    shared.finish(token, Ok(json!({
                        "protocolVersion": 1, "version": env!("CARGO_PKG_VERSION"),
                        "engine": "rust", "capabilities": {"resultCache": 1},
                        "provider": {"status": "ready", "protocolVersion": 1, "version": provider_health["version"]}
                    })));
                } else {
                    shared.finish(token, Err(EngineError::unavailable()));
                }
            }
            Ok(Control::Eof) => {
                closing_at = Some(Instant::now());
                shared.closing.store(true, Ordering::Release);
            }
            Ok(Control::Failed) => {
                code = 1;
                break;
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {}
            Err(_) => {
                code = 1;
                break;
            }
        }
    }
    shared.closing.store(true, Ordering::Release);
    job.terminate();
    shared.fail_pending();
    let deadline = Instant::now() + Duration::from_secs(2);
    while Instant::now() < deadline {
        let empty = shared
            .pending
            .lock()
            .map(|p| p.requests.is_empty())
            .unwrap_or(true);
        if empty {
            break;
        }
        thread::sleep(Duration::from_millis(5));
    }
    let _ = child.try_wait();
    drop(job);
    Ok(code)
}

fn main() {
    // Provider diagnostics, panic payloads and paths must never enter protocol output.
    std::panic::set_hook(Box::new(|_| {}));
    let code = match std::panic::catch_unwind(run) {
        Ok(Ok(code)) => code,
        _ => {
            eprintln!(
                "Native companion stopped. Check local dependencies and artifact-directory permissions."
            );
            1
        }
    };
    std::process::exit(code);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture() -> (Shared, Receiver<Frame>, Receiver<Vec<u8>>) {
        let (output, frames) = mpsc::sync_channel(16);
        let (provider, forwarded) = mpsc::sync_channel(16);
        let (control, _) = mpsc::sync_channel(16);
        (
            Shared {
                results: Arc::new(Results::new(
                    std::env::current_dir()
                        .unwrap()
                        .join("unused-synthetic-results"),
                )),
                pending: Mutex::new(Admissions::default()),
                output,
                provider,
                control,
                failed: AtomicBool::new(false),
                closing: AtomicBool::new(false),
            },
            frames,
            forwarded,
        )
    }

    fn query(id: &str) -> Request {
        Request {
            id: id.to_owned(),
            method: "query.execute".to_owned(),
            params: json!({"workbenchId": "fixture", "runId": "synthetic-run", "cacheResults": true}),
        }
    }

    fn begin(shared: &Shared, request: &Request) -> u64 {
        let token = shared.reserve(request).unwrap();
        shared.results.begin(&request.params).unwrap();
        shared
            .pending
            .lock()
            .unwrap()
            .requests
            .get_mut(&request.id)
            .unwrap()
            .cache_started = true;
        token
    }

    #[test]
    fn cancellation_before_forward_finalizes_without_forwarding_query() {
        let (shared, frames, forwarded) = fixture();
        let request = query("execute");
        let token = begin(&shared, &request);
        let cancel = Request {
            id: "cancel".to_owned(),
            method: "query.cancel".to_owned(),
            params: json!({"runId": "synthetic-run"}),
        };
        let cancel_token = shared.reserve(&cancel).unwrap();
        shared
            .forward(Work {
                token: cancel_token,
                method: cancel.method,
                params: cancel.params,
            })
            .unwrap();
        shared
            .forward(Work {
                token,
                method: request.method,
                params: request.params.clone(),
            })
            .unwrap();
        let sent = protocol::parse(&forwarded.try_recv().unwrap()).unwrap();
        assert_eq!(sent["method"], "query.cancel");
        assert!(forwarded.try_recv().is_err());
        let reply = protocol::parse(&frames.try_recv().unwrap().bytes).unwrap();
        assert_eq!(reply["result"]["status"], "cancelled");
        assert_eq!(
            shared
                .results
                .dispatch("results.pin", &request.params)
                .unwrap_err()
                .code,
            "NO_RESULTS"
        );
    }

    #[test]
    fn forwarding_failure_finalizes_before_reply() {
        let (shared, frames, forwarded) = fixture();
        let request = query("execute");
        let token = begin(&shared, &request);
        drop(forwarded);
        let error = shared
            .forward(Work {
                token,
                method: request.method,
                params: request.params.clone(),
            })
            .unwrap_err();
        shared.finish(token, Err(error));
        let reply = protocol::parse(&frames.try_recv().unwrap().bytes).unwrap();
        assert_eq!(reply["error"]["code"], "ENGINE_UNAVAILABLE");
        assert_eq!(
            shared
                .results
                .dispatch("results.pin", &request.params)
                .unwrap_err()
                .code,
            "NO_RESULTS"
        );
    }

    #[test]
    fn rejected_duplicate_run_does_not_finalize_original_payload() {
        let (shared, frames, _) = fixture();
        let request = query("original");
        begin(&shared, &request);
        let duplicate = query("duplicate");
        let token = shared.reserve(&duplicate).unwrap();
        let error = shared.results.begin(&duplicate.params).unwrap_err();
        shared.finish(token, Err(error));
        let reply = protocol::parse(&frames.try_recv().unwrap().bytes).unwrap();
        assert_eq!(reply["error"]["code"], "DUPLICATE_RUN");
        assert_eq!(
            shared
                .results
                .dispatch("results.pin", &request.params)
                .unwrap_err()
                .code,
            "RUNNING"
        );
    }
}
