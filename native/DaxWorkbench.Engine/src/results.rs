use crate::error::EngineError;
use indexmap::IndexMap;
use regex::Regex;
use serde::Deserialize;
use serde_json::{Value, json, value::RawValue};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    fs::{self, File, OpenOptions},
    io::{self, BufReader, BufWriter, Read, Write},
    os::windows::fs::OpenOptionsExt,
    path::PathBuf,
    sync::{
        Arc, Mutex, OnceLock, RwLock,
        atomic::{AtomicU64, Ordering},
    },
};
use windows_sys::Win32::Storage::FileSystem::{
    DELETE, FILE_FLAG_DELETE_ON_CLOSE, FILE_GENERIC_WRITE, FILE_SHARE_DELETE, FILE_SHARE_READ,
    FILE_SHARE_WRITE,
};

type Result<T> = std::result::Result<T, EngineError>;
const MAX_FILE: usize = 150 * 1024 * 1024;
const MAX_ROWS: usize = 100_000;
const MAX_CACHE: u64 = 512 * 1024 * 1024;
static TICKET: AtomicU64 = AtomicU64::new(1);

#[derive(Default)]
struct Set {
    columns: Value,
    rows: Vec<Box<[u8]>>,
}
struct Run {
    owner: String,
    active: bool,
    failed: bool,
    bytes: u64,
    row_count: usize,
    sets: IndexMap<String, Set>,
}
pub struct Results {
    root: PathBuf,
    runs: RwLock<HashMap<String, Arc<RwLock<Run>>>>,
    bytes: AtomicU64,
    exports: Mutex<HashMap<String, (String, File)>>,
}

fn error(code: &str, message: &str) -> EngineError {
    EngineError::new(code, message)
}
fn corrupt() -> EngineError {
    error(
        "RESULT_CORRUPT",
        "The retained result is invalid or incomplete.",
    )
}
fn unavailable() -> EngineError {
    error(
        "RESULT_NOT_RETAINED",
        "These results were not retained. Explicitly rerun the query to fetch current data.",
    )
}
fn poisoned() -> EngineError {
    error(
        "RESULT_ENGINE_FAILED",
        "The result engine must be restarted. Reopen the workbench.",
    )
}
fn io_error(_: io::Error) -> EngineError {
    error(
        "RESULT_IO",
        "The local result file could not be read or written.",
    )
}
fn id<'a>(value: &'a Value, key: &str) -> Result<&'a str> {
    let s = value
        .get(key)
        .and_then(Value::as_str)
        .ok_or_else(|| error("INVALID_ID", "Invalid result identifier."))?;
    if s.is_empty()
        || s.len() > 128
        || !s.as_bytes()[0].is_ascii_alphanumeric()
        || !s
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || b"._-".contains(&c))
    {
        return Err(error("INVALID_ID", "Invalid result identifier."));
    }
    Ok(s)
}
fn cell(value: &Value) -> bool {
    value.is_null() || value.is_string() || value.is_boolean() || value.is_number()
}
fn indices(keys: impl Iterator<Item = String>) -> Vec<String> {
    let mut keys: Vec<_> = keys.collect();
    keys.sort_by_key(|s| {
        let n = s
            .parse::<u32>()
            .ok()
            .filter(|n| *n != u32::MAX && n.to_string() == *s);
        (n.is_none(), n.unwrap_or(0))
    });
    keys
}
fn encoded_row(row: &Value, width: usize) -> Result<Box<[u8]>> {
    let values = row.as_array().ok_or_else(corrupt)?;
    if values.len() != width || !values.iter().all(cell) {
        return Err(corrupt());
    }
    let mut bytes = Vec::new();
    write_js(&mut bytes, row).map_err(io_error)?;
    Ok(bytes.into_boxed_slice())
}

// Pin checksums predate Rust and are defined by ECMAScript JSON.stringify.
fn write_js(out: &mut impl Write, value: &Value) -> io::Result<()> {
    match value {
        Value::Number(number) => {
            let number = number
                .as_f64()
                .ok_or_else(|| io::Error::other("Non-finite JSON number"))?;
            out.write_all(ryu_js::Buffer::new().format(number).as_bytes())
        }
        Value::Array(values) => {
            out.write_all(b"[")?;
            for (i, value) in values.iter().enumerate() {
                if i != 0 {
                    out.write_all(b",")?;
                }
                write_js(out, value)?;
            }
            out.write_all(b"]")
        }
        Value::Object(values) => {
            out.write_all(b"{")?;
            for (i, key) in indices(values.keys().cloned()).iter().enumerate() {
                if i != 0 {
                    out.write_all(b",")?;
                }
                serde_json::to_writer(&mut *out, key)?;
                out.write_all(b":")?;
                write_js(out, &values[key])?;
            }
            out.write_all(b"}")
        }
        _ => serde_json::to_writer(out, value).map_err(io::Error::other),
    }
}
struct HashWriter(Sha256);
impl Write for HashWriter {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        self.0.update(bytes);
        Ok(bytes.len())
    }
    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}
fn write_sets(out: &mut impl Write, sets: &IndexMap<String, Set>) -> io::Result<()> {
    out.write_all(b"{")?;
    for (i, name) in indices(sets.keys().cloned()).iter().enumerate() {
        if i != 0 {
            out.write_all(b",")?;
        }
        serde_json::to_writer(&mut *out, name)?;
        out.write_all(b":[")?;
        for (j, row) in sets[name].rows.iter().enumerate() {
            if j != 0 {
                out.write_all(b",")?;
            }
            out.write_all(row)?;
        }
        out.write_all(b"]")?;
    }
    out.write_all(b"}")
}
fn checksum(sets: &IndexMap<String, Set>) -> Result<String> {
    let mut hash = HashWriter(Sha256::new());
    write_sets(&mut hash, sets).map_err(io_error)?;
    Ok(format!("{:x}", hash.0.finalize()))
}

impl Results {
    pub fn new(root: PathBuf) -> Self {
        Self {
            root,
            runs: RwLock::new(HashMap::new()),
            bytes: AtomicU64::new(0),
            exports: Mutex::new(HashMap::new()),
        }
    }
    fn get(&self, p: &Value) -> Result<Arc<RwLock<Run>>> {
        let owner = id(p, "workbenchId")?;
        let run = self
            .runs
            .read()
            .map_err(|_| poisoned())?
            .get(id(p, "runId")?)
            .cloned()
            .ok_or_else(unavailable)?;
        if run.read().map_err(|_| poisoned())?.owner != owner {
            return Err(unavailable());
        }
        Ok(run)
    }
    fn reserve(&self, bytes: u64) -> Result<()> {
        self.bytes.fetch_update(Ordering::AcqRel, Ordering::Acquire, |current|
            current.checked_add(bytes).filter(|total| *total <= MAX_CACHE))
            .map_err(|_| error("RESULT_CACHE_LIMIT", "The result cache reached its memory limit. Close unneeded workbenches before running more previews."))?;
        Ok(())
    }
    pub fn begin(&self, p: &Value) -> Result<()> {
        if p.get("cacheResults") != Some(&Value::Bool(true)) {
            return Ok(());
        }
        let owner = id(p, "workbenchId")?.to_owned();
        let run_id = id(p, "runId")?.to_owned();
        let mut runs = self.runs.write().map_err(|_| poisoned())?;
        if runs.contains_key(&run_id) {
            return Err(error("DUPLICATE_RUN", "This result run already exists."));
        }
        runs.insert(
            run_id,
            Arc::new(RwLock::new(Run {
                owner,
                active: true,
                failed: false,
                bytes: 0,
                row_count: 0,
                sets: IndexMap::new(),
            })),
        );
        Ok(())
    }
    pub fn finish(&self, p: &Value) -> Result<()> {
        if p.get("cacheResults") != Some(&Value::Bool(true)) {
            return Ok(());
        }
        self.get(p)?.write().map_err(|_| poisoned())?.active = false;
        Ok(())
    }
    pub fn ingest(&self, event: &mut Value) -> Result<()> {
        let Some(run_id) = event
            .get("runId")
            .and_then(Value::as_str)
            .map(str::to_owned)
        else {
            return Ok(());
        };
        let Some(entry) = self
            .runs
            .read()
            .map_err(|_| poisoned())?
            .get(&run_id)
            .cloned()
        else {
            return Ok(());
        };
        let kind = event
            .get("event")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_owned();
        if !matches!(kind.as_str(), "query.rows" | "query.resultset") {
            return Ok(());
        }
        let mut run = entry.write().map_err(|_| poisoned())?;
        if run.failed {
            return Err(corrupt());
        }
        let outcome = (|| {
            if !run.active {
                return Err(corrupt());
            }
            let set_id = id(event, "resultSetId")?.to_owned();
            if kind == "query.resultset" {
                let columns = event
                    .get("columns")
                    .filter(|c| c.is_array())
                    .ok_or_else(corrupt)?
                    .clone();
                if !columns.as_array().ok_or_else(corrupt)?.iter().all(|c| {
                    ["id", "name", "dataType"]
                        .iter()
                        .all(|key| c.get(*key).is_some_and(Value::is_string))
                }) {
                    return Err(corrupt());
                }
                if run.sets.contains_key(&set_id) {
                    return Err(corrupt());
                }
                let bytes = serde_json::to_vec(&columns).map_err(|_| corrupt())?.len() as u64;
                if run.bytes + bytes > MAX_FILE as u64 {
                    return Err(error(
                        "RESULT_TOO_LARGE",
                        "This result exceeds the supported snapshot size.",
                    ));
                }
                self.reserve(bytes)?;
                run.bytes += bytes;
                run.sets.insert(
                    set_id,
                    Set {
                        columns,
                        rows: Vec::new(),
                    },
                );
            } else {
                let set = run.sets.get(&set_id).ok_or_else(corrupt)?;
                let rows = event
                    .get("rows")
                    .and_then(Value::as_array)
                    .ok_or_else(corrupt)?;
                let offset = event
                    .get("offset")
                    .and_then(Value::as_u64)
                    .ok_or_else(corrupt)?;
                if offset != set.rows.len() as u64 || run.row_count + rows.len() > MAX_ROWS {
                    return Err(corrupt());
                }
                let width = set.columns.as_array().ok_or_else(corrupt)?.len();
                let encoded = rows
                    .iter()
                    .map(|row| encoded_row(row, width))
                    .collect::<Result<Vec<_>>>()?;
                let bytes = encoded.iter().map(|r| r.len() as u64 + 1).sum::<u64>();
                if run.bytes + bytes > MAX_FILE as u64 {
                    return Err(error(
                        "RESULT_TOO_LARGE",
                        "This result exceeds the supported snapshot size.",
                    ));
                }
                self.reserve(bytes)?;
                run.bytes += bytes;
                run.row_count += rows.len();
                let set = run.sets.get_mut(&set_id).ok_or_else(corrupt)?;
                set.rows.extend(encoded);
                *event = json!({ "event": "query.rows.cached", "runId": run_id,
                    "resultSetId": set_id, "offset": offset, "count": rows.len(), "total": set.rows.len() });
            }
            Ok(())
        })();
        if outcome.is_err() {
            run.failed = true;
            self.bytes.fetch_sub(run.bytes, Ordering::AcqRel);
            run.bytes = 0;
            run.row_count = 0;
            run.sets.clear();
        }
        outcome
    }
    pub fn dispatch(&self, method: &str, p: &Value) -> Result<Value> {
        match method {
            "results.page" => self.page(p),
            "results.select" => self.select(p),
            "results.pin" => self.pin(p),
            "results.restore" => self.restore(p),
            "results.compare" => self.compare(p),
            "results.export" => self.export(p),
            "results.export.release" => self.release_export(p),
            "results.trim" => self.trim(p),
            "results.stats" => {
                let owner = id(p, "workbenchId")?;
                let runs = self.runs.read().map_err(|_| poisoned())?;
                let mut cached = Vec::new();
                for (id, entry) in runs.iter() {
                    let run = entry.read().map_err(|_| poisoned())?;
                    if run.owner == owner {
                        cached.push(
                            json!({ "runId": id, "rowCount": run.row_count, "bytes": run.bytes }),
                        );
                    }
                }
                Ok(json!({ "engine": "rust", "cached": cached }))
            }
            _ => Err(error(
                "METHOD_NOT_FOUND",
                "This result operation is not supported.",
            )),
        }
    }
    fn page(&self, p: &Value) -> Result<Value> {
        let offset = p
            .get("offset")
            .and_then(Value::as_u64)
            .ok_or_else(|| error("INVALID_PAGE", "Invalid result page offset."))?;
        let limit = p
            .get("limit")
            .and_then(Value::as_u64)
            .filter(|n| (1..=1000).contains(n))
            .ok_or_else(|| error("INVALID_PAGE", "Result pages contain 1 to 1,000 rows."))?;
        let entry = self.get(p)?;
        let run = entry.read().map_err(|_| poisoned())?;
        if run.failed {
            return Err(corrupt());
        }
        let set = run
            .sets
            .get(id(p, "resultSetId")?)
            .ok_or_else(unavailable)?;
        let mut rows = Vec::new();
        let mut bytes = 1024;
        for row in set
            .rows
            .iter()
            .skip(usize::try_from(offset).unwrap_or(usize::MAX))
            .take(limit as usize)
        {
            if bytes + row.len() + 1 > 2 * 1024 * 1024 - 1024 {
                if rows.is_empty() {
                    return Err(error(
                        "PAGE_TOO_LARGE",
                        "This row exceeds the result-page transport limit.",
                    ));
                }
                break;
            }
            bytes += row.len() + 1;
            rows.push(serde_json::from_slice::<Value>(row).map_err(|_| corrupt())?);
        }
        let result = json!({ "rows": rows, "offset": offset, "total": set.rows.len() });
        // Wide results return fewer complete rows, never truncated cell contents.
        if serde_json::to_vec(&result).map_err(|_| corrupt())?.len() > 2 * 1024 * 1024 - 1024 {
            return Err(error(
                "PAGE_TOO_LARGE",
                "This page exceeds the protocol limit. Request fewer rows.",
            ));
        }
        Ok(result)
    }
    fn select(&self, p: &Value) -> Result<Value> {
        let owner = id(p, "workbenchId")?;
        let cells = p
            .get("cells")
            .and_then(Value::as_array)
            .filter(|c| c.len() <= 100)
            .ok_or_else(|| error("INVALID_SELECTION", "Share at most 100 cells at a time."))?;
        let mut values = Vec::new();
        for c in cells {
            let entry = self.get(&json!({ "workbenchId": owner, "runId": id(c, "runId")? }))?;
            let run = entry.read().map_err(|_| poisoned())?;
            if run.failed {
                return Err(corrupt());
            }
            let set_id = id(c, "resultSetId")?;
            let set = run.sets.get(set_id).ok_or_else(unavailable)?;
            let row = c
                .get("row")
                .and_then(Value::as_u64)
                .and_then(|n| usize::try_from(n).ok())
                .ok_or_else(corrupt)?;
            let column = c
                .get("column")
                .and_then(Value::as_u64)
                .and_then(|n| usize::try_from(n).ok())
                .ok_or_else(corrupt)?;
            let values_row: Value = serde_json::from_slice(set.rows.get(row).ok_or_else(corrupt)?)
                .map_err(|_| corrupt())?;
            values.push(values_row.get(column).ok_or_else(corrupt)?.clone());
        }
        let result = json!({ "values": values });
        if serde_json::to_vec(&result).map_err(|_| corrupt())?.len() > 16_384 {
            return Err(error(
                "CONTEXT_TOO_LARGE",
                "Selected values exceed the 16 KiB sharing limit.",
            ));
        }
        Ok(result)
    }
    fn validate_sets(run: &Run, p: &Value) -> Result<()> {
        let expected = p
            .get("sets")
            .and_then(Value::as_array)
            .ok_or_else(corrupt)?;
        if expected.len() != run.sets.len() {
            return Err(corrupt());
        }
        for set in expected {
            let stored = run.sets.get(id(set, "id")?).ok_or_else(corrupt)?;
            if set.get("rowCount").and_then(Value::as_u64) != Some(stored.rows.len() as u64) {
                return Err(corrupt());
            }
        }
        if run.failed {
            return Err(corrupt());
        }
        Ok(())
    }
    fn result_path(&self, p: &Value) -> Result<PathBuf> {
        Ok(self
            .root
            .join("results")
            .join(id(p, "workbenchId")?)
            .join(format!("{}.json", id(p, "runId")?)))
    }
    fn pin(&self, p: &Value) -> Result<Value> {
        let entry = self.get(p)?;
        let run = entry.read().map_err(|_| poisoned())?;
        if run.active {
            return Err(error(
                "RUNNING",
                "Wait for this run to finish before pinning it.",
            ));
        }
        if run.sets.is_empty() {
            return Err(error("NO_RESULTS", "This run has no results to pin."));
        }
        Self::validate_sets(&run, p)?;
        let path = self.result_path(p)?;
        fs::create_dir_all(path.parent().ok_or_else(corrupt)?).map_err(io_error)?;
        let temp = path.with_extension(format!(
            "{}.{}.tmp",
            std::process::id(),
            TICKET.fetch_add(1, Ordering::Relaxed)
        ));
        let result = (|| {
            let mut out = BufWriter::new(
                OpenOptions::new()
                    .write(true)
                    .create_new(true)
                    .open(&temp)
                    .map_err(io_error)?,
            );
            out.write_all(b"{\"schemaVersion\":1,\"runId\":")
                .map_err(io_error)?;
            serde_json::to_writer(&mut out, id(p, "runId")?).map_err(|_| corrupt())?;
            out.write_all(b",\"resultSets\":").map_err(io_error)?;
            write_sets(&mut out, &run.sets).map_err(io_error)?;
            out.write_all(b",\"checksum\":").map_err(io_error)?;
            serde_json::to_writer(&mut out, &checksum(&run.sets)?).map_err(|_| corrupt())?;
            out.write_all(b"}").map_err(io_error)?;
            out.flush().map_err(io_error)?;
            if out.get_ref().metadata().map_err(io_error)?.len() > MAX_FILE as u64 {
                return Err(error(
                    "RESULT_TOO_LARGE",
                    "This pinned result exceeds the supported snapshot size.",
                ));
            }
            out.get_ref().sync_all().map_err(io_error)?;
            drop(out);
            fs::rename(&temp, path).map_err(io_error)?;
            Ok(json!({ "pinned": true }))
        })();
        if result.is_err() && temp.exists() {
            fs::remove_file(temp).map_err(io_error)?;
        }
        result
    }
    fn restore(&self, p: &Value) -> Result<Value> {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct Pin {
            schema_version: u32,
            run_id: String,
            result_sets: IndexMap<String, Vec<Box<RawValue>>>,
            checksum: String,
        }
        let owner = id(p, "workbenchId")?;
        let run_id = id(p, "runId")?;
        let file = File::open(self.result_path(p)?).map_err(io_error)?;
        if file.metadata().map_err(io_error)?.len() > MAX_FILE as u64 {
            return Err(error(
                "RESULT_TOO_LARGE",
                "This pinned result exceeds the supported snapshot size.",
            ));
        }
        let mut reader = BufReader::new(file).take(MAX_FILE as u64 + 1);
        let pin: Pin = serde_json::from_reader(&mut reader).map_err(|_| corrupt())?;
        if reader.limit() == 0 || pin.schema_version != 1 || pin.run_id != run_id {
            return Err(corrupt());
        }
        let expected = p
            .get("sets")
            .and_then(Value::as_array)
            .ok_or_else(corrupt)?;
        if pin.result_sets.len() != expected.len() {
            return Err(corrupt());
        }
        let mut run = Run {
            owner: owner.into(),
            active: false,
            failed: false,
            row_count: 0,
            bytes: 0,
            sets: IndexMap::new(),
        };
        for (name, rows) in pin.result_sets {
            let set = expected
                .iter()
                .find(|set| set.get("id").and_then(Value::as_str) == Some(name.as_str()))
                .ok_or_else(corrupt)?;
            let columns = set
                .get("columns")
                .filter(|v| v.is_array())
                .ok_or_else(corrupt)?
                .clone();
            if set.get("rowCount").and_then(Value::as_u64) != Some(rows.len() as u64)
                || run.row_count + rows.len() > MAX_ROWS
            {
                return Err(corrupt());
            }
            let width = columns.as_array().ok_or_else(corrupt)?.len();
            let encoded = rows
                .iter()
                .map(|raw| {
                    let row = serde_json::from_str(raw.get()).map_err(|_| corrupt())?;
                    encoded_row(&row, width)
                })
                .collect::<Result<Vec<_>>>()?;
            run.row_count += encoded.len();
            run.bytes += encoded.iter().map(|row| row.len() as u64 + 1).sum::<u64>();
            run.bytes += serde_json::to_vec(&columns).map_err(|_| corrupt())?.len() as u64;
            run.sets.insert(
                name,
                Set {
                    columns,
                    rows: encoded,
                },
            );
        }
        if checksum(&run.sets)? != pin.checksum {
            return Err(error(
                "RESULT_CORRUPT",
                "Pinned result checksum does not match its saved contents.",
            ));
        }
        let mut runs = self.runs.write().map_err(|_| poisoned())?;
        let old_bytes = if let Some(old) = runs.get(run_id) {
            let old = old.read().map_err(|_| poisoned())?;
            if old.owner != owner || old.active {
                return Err(error("RUNNING", "Cannot restore over an active result."));
            }
            old.bytes
        } else {
            0
        };
        self.reserve(run.bytes.saturating_sub(old_bytes))?;
        if old_bytes > run.bytes {
            self.bytes
                .fetch_sub(old_bytes - run.bytes, Ordering::AcqRel);
        }
        let count = run.row_count;
        runs.insert(run_id.to_owned(), Arc::new(RwLock::new(run)));
        Ok(json!({ "restored": true, "rowCount": count }))
    }
    fn compare(&self, p: &Value) -> Result<Value> {
        let owner = id(p, "workbenchId")?;
        let a = p.get("left").ok_or_else(corrupt)?;
        let b = p.get("right").ok_or_else(corrupt)?;
        let left = self.get(&json!({ "workbenchId": owner, "runId": id(a, "runId")? }))?;
        let right = self.get(&json!({ "workbenchId": owner, "runId": id(b, "runId")? }))?;
        if Arc::ptr_eq(&left, &right) {
            let run = left.read().map_err(|_| poisoned())?;
            if run.active {
                return Err(error("RUNNING", "Wait for this run to finish."));
            }
            Self::validate_sets(&run, a)?;
            Self::validate_sets(&run, b)?;
            return Ok(json!({ "equal": a["sets"] == b["sets"] }));
        }
        let left = left.read().map_err(|_| poisoned())?;
        let right = right.read().map_err(|_| poisoned())?;
        if left.active || right.active {
            return Err(error("RUNNING", "Wait for both runs to finish."));
        }
        Self::validate_sets(&left, a)?;
        Self::validate_sets(&right, b)?;
        let aa = a["sets"].as_array().ok_or_else(corrupt)?;
        let bb = b["sets"].as_array().ok_or_else(corrupt)?;
        let mut equal = aa.len() == bb.len();
        for (x, y) in aa.iter().zip(bb) {
            let signature = |set: &Value| -> Result<Value> {
                Ok(Value::Array(
                    set["columns"]
                        .as_array()
                        .ok_or_else(corrupt)?
                        .iter()
                        .map(|c| json!([c.get("name"), c.get("dataType")]))
                        .collect(),
                ))
            };
            if signature(x)? != signature(y)?
                || left.sets[id(x, "id")?].rows != right.sets[id(y, "id")?].rows
            {
                equal = false;
                break;
            }
        }
        Ok(json!({ "equal": equal }))
    }
    fn trim(&self, p: &Value) -> Result<Value> {
        let owner = id(p, "workbenchId")?;
        let keep = p
            .get("keep")
            .and_then(Value::as_array)
            .filter(|v| v.len() <= 100)
            .ok_or_else(corrupt)?;
        let mut runs = self.runs.write().map_err(|_| poisoned())?;
        let mut remove = Vec::new();
        for (key, entry) in runs.iter() {
            let run = entry.read().map_err(|_| poisoned())?;
            if run.owner == owner && !run.active && !keep.iter().any(|v| v.as_str() == Some(key)) {
                remove.push((key.clone(), run.bytes));
            }
        }
        for (key, bytes) in &remove {
            runs.remove(key);
            self.bytes.fetch_sub(*bytes, Ordering::AcqRel);
        }
        Ok(json!({ "evicted": remove.into_iter().map(|(key, _)| key).collect::<Vec<_>>() }))
    }
    fn export(&self, p: &Value) -> Result<Value> {
        let owner = id(p, "workbenchId")?;
        let format = p
            .get("format")
            .and_then(Value::as_str)
            .filter(|s| matches!(*s, "csv" | "json"))
            .ok_or_else(|| error("INVALID_EXPORT", "Choose CSV or JSON."))?;
        let entry = self.get(p)?;
        let run = entry.read().map_err(|_| poisoned())?;
        if run.active {
            return Err(error(
                "RUNNING",
                "Wait for this run to finish before exporting.",
            ));
        }
        if run.failed {
            return Err(corrupt());
        }
        let set = run
            .sets
            .get(id(p, "resultSetId")?)
            .ok_or_else(unavailable)?;
        let metadata = p
            .get("metadata")
            .filter(|v| v.is_object())
            .ok_or_else(corrupt)?;
        let columns = metadata
            .get("columns")
            .and_then(Value::as_array)
            .ok_or_else(corrupt)?;
        if columns.len() != set.columns.as_array().ok_or_else(corrupt)?.len() {
            return Err(corrupt());
        }
        let ticket = format!(
            "{}-{}",
            std::process::id(),
            TICKET.fetch_add(1, Ordering::Relaxed)
        );
        let directory = self.root.join("exports").join(owner);
        fs::create_dir_all(&directory).map_err(io_error)?;
        let path = directory.join(format!("{ticket}.{format}"));
        let result = (|| {
            let mut out = BufWriter::new(
                OpenOptions::new()
                    .write(true)
                    .access_mode(FILE_GENERIC_WRITE | DELETE)
                    .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE)
                    .custom_flags(FILE_FLAG_DELETE_ON_CLOSE)
                    .create_new(true)
                    .open(&path)
                    .map_err(io_error)?,
            );
            if format == "csv" {
                out.write_all("\u{feff}".as_bytes()).map_err(io_error)?;
                for (i, column) in columns.iter().enumerate() {
                    if i != 0 {
                        out.write_all(b",").map_err(io_error)?;
                    }
                    csv_cell(&mut out, column.get("name").ok_or_else(corrupt)?, false)
                        .map_err(io_error)?;
                }
                let numeric: Vec<_> = columns
                    .iter()
                    .map(|c| numeric_type(c.get("dataType").and_then(Value::as_str).unwrap_or("")))
                    .collect();
                for row in &set.rows {
                    out.write_all(b"\r\n").map_err(io_error)?;
                    let row: Vec<Value> = serde_json::from_slice(row).map_err(|_| corrupt())?;
                    for (i, value) in row.iter().enumerate() {
                        if i != 0 {
                            out.write_all(b",").map_err(io_error)?;
                        }
                        csv_cell(&mut out, value, numeric[i]).map_err(io_error)?;
                    }
                }
            } else {
                out.write_all(b"{\n").map_err(io_error)?;
                let mut first = true;
                for key in [
                    "runId",
                    "connectionKind",
                    "query",
                    "status",
                    "truncated",
                    "warnings",
                    "columns",
                ] {
                    if let Some(value) = metadata.get(key) {
                        if !first {
                            out.write_all(b",\n").map_err(io_error)?;
                        }
                        first = false;
                        write!(out, "  \"{key}\": ").map_err(io_error)?;
                        write_js(&mut out, value).map_err(io_error)?;
                    }
                }
                if !first {
                    out.write_all(b",\n").map_err(io_error)?;
                }
                out.write_all(b"  \"rows\": [").map_err(io_error)?;
                for (i, row) in set.rows.iter().enumerate() {
                    if i != 0 {
                        out.write_all(b",").map_err(io_error)?;
                    }
                    out.write_all(b"\n    ").map_err(io_error)?;
                    out.write_all(row).map_err(io_error)?;
                }
                out.write_all(b"\n  ]\n}").map_err(io_error)?;
            }
            out.flush().map_err(io_error)?;
            let length = out.get_ref().metadata().map_err(io_error)?.len();
            let file = out.into_inner().map_err(|e| io_error(e.into_error()))?;
            Ok((length, file))
        })();
        match result {
            Ok((length, file)) => {
                self.exports
                    .lock()
                    .map_err(|_| poisoned())?
                    .insert(ticket.clone(), (owner.into(), file));
                Ok(json!({ "ticket": ticket, "file": path, "length": length,
                    "contentType": if format == "csv" { "text/csv; charset=utf-8" } else { "application/json; charset=utf-8" } }))
            }
            Err(e) => {
                if path.exists() {
                    fs::remove_file(path).map_err(io_error)?;
                }
                Err(e)
            }
        }
    }
    fn release_export(&self, p: &Value) -> Result<Value> {
        let owner = id(p, "workbenchId")?;
        let ticket = id(p, "ticket")?;
        let mut exports = self.exports.lock().map_err(|_| poisoned())?;
        let (stored_owner, _) = exports.get(ticket).ok_or_else(unavailable)?;
        if stored_owner != owner {
            return Err(unavailable());
        }
        // Closing the lease deletes the file even if the process exits unexpectedly.
        exports.remove(ticket);
        Ok(json!({ "released": true }))
    }
}
fn numeric_type(s: &str) -> bool {
    [
        "int", "decimal", "currency", "double", "float", "numeric", "number",
    ]
    .iter()
    .any(|t| s.to_ascii_lowercase().contains(t))
}
fn csv_cell(out: &mut impl Write, value: &Value, numeric: bool) -> io::Result<()> {
    static NUMBER: OnceLock<Regex> = OnceLock::new();
    let mut text = match value {
        Value::Null => String::new(),
        Value::String(s) => s.clone(),
        Value::Number(n) => ryu_js::Buffer::new()
            .format(
                n.as_f64()
                    .ok_or_else(|| io::Error::other("Invalid number"))?,
            )
            .to_owned(),
        Value::Bool(b) => b.to_string(),
        _ => return Err(io::Error::other("Invalid result cell")),
    };
    let is_number = numeric
        && NUMBER
            .get_or_init(|| {
                Regex::new(r"^[+-]?[0-9]+(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?$")
                    .expect("constant regex")
            })
            .is_match(&text);
    let trimmed =
        text.trim_start_matches(|c: char| c.is_whitespace() && c != '\u{85}' || c == '\u{feff}');
    if !is_number && trimmed.starts_with(['=', '+', '-', '@']) {
        text.insert(0, '\'');
    }
    write!(out, "\"{}\"", text.replace('"', "\"\""))
}

#[cfg(test)]
mod tests {
    use super::*;
    fn params() -> Value {
        json!({ "workbenchId": "fixture", "runId": "run1", "cacheResults": true })
    }
    #[test]
    fn canonical_numbers_and_integer_property_order() {
        let mut out = Vec::new();
        write_js(
            &mut out,
            &serde_json::from_str::<Value>(r#"{"10":1.0,"2":-0.0,"z":[1e-7,1e21,0.000001]}"#)
                .unwrap(),
        )
        .unwrap();
        assert_eq!(
            String::from_utf8(out).unwrap(),
            r#"{"2":0,"10":1,"z":[1e-7,1e+21,0.000001]}"#
        );
    }
    #[test]
    fn rows_stay_native_and_scopes_are_isolated() {
        let engine = Results::new(std::env::temp_dir());
        engine.begin(&params()).unwrap();
        engine.ingest(&mut json!({"event":"query.resultset","runId":"run1","resultSetId":"r0","columns":[{"id":"c0","name":"Value","dataType":"Variant"}]})).unwrap();
        let mut message = json!({"event":"query.rows","runId":"run1","resultSetId":"r0","offset":0,"rows":[[null],[""],[-0.0]]});
        engine.ingest(&mut message).unwrap();
        assert_eq!(message["event"], "query.rows.cached");
        assert!(message.get("rows").is_none());
        let page = engine.dispatch("results.page", &json!({"workbenchId":"fixture","runId":"run1","resultSetId":"r0","offset":0,"limit":10})).unwrap();
        assert_eq!(page["rows"], json!([[null], [""], [0]]));
        assert!(engine.dispatch("results.page", &json!({"workbenchId":"other","runId":"run1","resultSetId":"r0","offset":0,"limit":10})).is_err());
        engine.finish(&params()).unwrap();
        engine
            .dispatch("results.trim", &json!({"workbenchId":"other","keep":[]}))
            .unwrap();
        assert_eq!(
            engine
                .dispatch("results.stats", &json!({"workbenchId":"fixture"}))
                .unwrap()["cached"]
                .as_array()
                .unwrap()
                .len(),
            1
        );
    }
    #[test]
    fn invalid_chunks_poison_cache_without_publishing_values() {
        let engine = Results::new(std::env::temp_dir());
        engine.begin(&params()).unwrap();
        engine.ingest(&mut json!({"event":"query.resultset","runId":"run1","resultSetId":"r0","columns":[]})).unwrap();
        assert!(engine.ingest(&mut json!({"event":"query.rows","runId":"run1","resultSetId":"r0","offset":1,"rows":[[]]})).is_err());
        assert!(engine.dispatch("results.page", &json!({"workbenchId":"fixture","runId":"run1","resultSetId":"r0","offset":0,"limit":10})).is_err());
    }
    #[test]
    fn csv_preserves_numbers_and_protects_formula_text() {
        for (value, numeric, expected) in [
            (json!("-1.25"), true, "\"-1.25\""),
            (json!("-1+2"), true, "\"'-1+2\""),
            (json!("\u{feff}=1"), false, "\"'\u{feff}=1\""),
            (Value::Null, false, "\"\""),
            (json!("\"quoted\""), false, "\"\"\"quoted\"\"\""),
        ] {
            let mut bytes = Vec::new();
            csv_cell(&mut bytes, &value, numeric).unwrap();
            assert_eq!(String::from_utf8(bytes).unwrap(), expected);
        }
    }
}
