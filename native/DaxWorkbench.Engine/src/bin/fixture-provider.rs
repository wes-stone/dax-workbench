//! Synthetic protocol fixture. This executable is never included in installed releases.
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    io::{self, BufRead, Write},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    thread,
    time::Duration,
};
fn send(out: &Mutex<io::Stdout>, value: Value) -> io::Result<()> {
    let mut out = out
        .lock()
        .map_err(|_| io::Error::other("Fixture output poisoned"))?;
    serde_json::to_writer(&mut *out, &value)?;
    out.write_all(b"\n")?;
    out.flush()
}
fn columns() -> Value {
    json!([
        {"id":"c0","name":"Row","dataType":"Int64"},
        {"id":"c1","name":"Region","dataType":"String"},
        {"id":"c2","name":"Exact decimal","dataType":"Decimal"},
        {"id":"c3","name":"Blank or empty","dataType":"String"},
        {"id":"c4","name":"Enabled","dataType":"Boolean"},
        {"id":"c5","name":"Ratio","dataType":"Double"},
        {"id":"c6","name":"Text","dataType":"Variant"}
    ])
}
fn row(index: usize, width: usize) -> Value {
    json!([
        index,
        format!("Synthetic region {}", index % 100),
        format!(
            "{}.1234567890123456789",
            9_007_199_254_740_991u64 + index as u64
        ),
        if index.is_multiple_of(2) {
            Value::Null
        } else {
            json!("")
        },
        index.is_multiple_of(3),
        index as f64 / 7.0,
        if width > 0 {
            "X".repeat(width)
        } else if index == 0 {
            "=1+1".to_owned()
        } else {
            format!("Fixture row {index}: escaped \"quotes\" and \u{03b1}\u{03b2}")
        }
    ])
}
fn main() -> io::Result<()> {
    let output = Arc::new(Mutex::new(io::stdout()));
    let running: Arc<Mutex<HashMap<String, Arc<AtomicBool>>>> =
        Arc::new(Mutex::new(HashMap::new()));
    for line in io::stdin().lock().lines() {
        let line = line?;
        let request: Value = serde_json::from_str(&line)?;
        let id = request["id"].clone();
        let p = request.get("params").cloned().unwrap_or_else(|| json!({}));
        match request["method"].as_str().unwrap_or("") {
            "health" => send(
                &output,
                json!({"id":id,"result":{"protocolVersion":1,"version":"synthetic-fixture"}}),
            )?,
            "connections.list" => send(
                &output,
                json!({"id":id,"result":{"connections":[{"id":"fixture","name":"Synthetic Rust fixture","kind":"synthetic","model":"No semantic model is queried"}]}}),
            )?,
            "schema.get" => {
                let mut objects = vec![json!({"id":"table-Sales","kind":"table","name":"Sales"})];
                for i in 0..1053 {
                    objects.push(json!({"id":format!("column-{i}"),"kind":"column","name":format!("Field {i}"),"table":"Sales","dataType":"String"}));
                }
                for i in 0..500 {
                    objects.push(json!({"id":format!("measure-{i}"),"kind":"measure","name":format!("Measure {i}"),"table":"Sales","dataType":"Decimal"}));
                }
                send(
                    &output,
                    json!({"id":id,"result":{"connectionId":p["connectionId"],"objects":objects,"fetchedAt":"2026-09-01T00:00:00Z","warnings":["Synthetic metadata only."]}}),
                )?;
            }
            "query.execute" => {
                let run_id = p["runId"].as_str().unwrap_or("").to_owned();
                let cancelled = Arc::new(AtomicBool::new(false));
                running
                    .lock()
                    .map_err(|_| io::Error::other("Fixture lock poisoned"))?
                    .insert(run_id.clone(), cancelled.clone());
                let out = output.clone();
                let active = running.clone();
                thread::spawn(move || -> io::Result<()> {
                    let count = p["parameters"]["rows"]
                        .as_u64()
                        .unwrap_or(50_000)
                        .min(100_000) as usize;
                    let cap = p["maxRows"].as_u64().unwrap_or(100_000) as usize;
                    let count_read = count.min(cap);
                    let slow = p["parameters"]["slow"] == true;
                    let width = p["parameters"]["width"].as_u64().unwrap_or(0).min(3000) as usize;
                    let columns = columns();
                    send(
                        &out,
                        json!({"event":"query.progress","runId":run_id,"status":"streaming"}),
                    )?;
                    send(
                        &out,
                        json!({"event":"query.resultset","runId":run_id,"resultSetId":"r0","columns":columns}),
                    )?;
                    let mut read = 0;
                    while read < count_read && !cancelled.load(Ordering::Acquire) {
                        let end = (read + 500).min(count_read);
                        let rows: Vec<_> = (read..end).map(|i| row(i, width)).collect();
                        send(
                            &out,
                            json!({"event":"query.rows","runId":run_id,"resultSetId":"r0","offset":read,"rows":rows}),
                        )?;
                        read = end;
                        if slow {
                            thread::sleep(Duration::from_millis(5));
                        }
                    }
                    let status = if cancelled.load(Ordering::Acquire) {
                        "cancelled"
                    } else {
                        "completed"
                    };
                    send(
                        &out,
                        json!({"id":id,"result":{"status":status,"rowCount":read,"durationMs":1,"truncated":count>cap,
                        "resultSets":[{"id":"r0","columns":columns,"rowCount":read,"truncated":count>cap}],
                        "warnings":["Synthetic fixture: DAX captured, not evaluated."]}}),
                    )?;
                    active
                        .lock()
                        .map_err(|_| io::Error::other("Fixture lock poisoned"))?
                        .remove(&run_id);
                    Ok(())
                });
            }
            "query.cancel" => {
                let runs = running
                    .lock()
                    .map_err(|_| io::Error::other("Fixture lock poisoned"))?;
                let requested =
                    if let Some(cancel) = p["runId"].as_str().and_then(|id| runs.get(id)) {
                        cancel.store(true, Ordering::Release);
                        true
                    } else {
                        false
                    };
                send(&output, json!({"id":id,"result":{"requested":requested}}))?;
            }
            _ => send(
                &output,
                json!({"id":id,"error":{"code":"METHOD_NOT_FOUND","message":"Unsupported synthetic fixture operation."}}),
            )?,
        }
    }
    Ok(())
}
