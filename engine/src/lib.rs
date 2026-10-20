mod compiler;
mod js;
mod read_query;
mod schema;

use js::{Error, Js, Result, json};
use serde_json::{Value, json as json_value};
use std::collections::HashMap;
use std::sync::{LazyLock, Mutex};

const ABI_VERSION: u32 = 1;
const MAX_REQUEST: usize = 128 * 1024 * 1024;
const MAX_SCHEMAS: usize = 6;
struct State {
    next: u32,
    schemas: HashMap<u32, schema::Schema>,
    builds: u64,
    calls: u64,
}
static STATE: LazyLock<Mutex<State>> = LazyLock::new(|| {
    Mutex::new(State {
        next: 1,
        schemas: HashMap::new(),
        builds: 0,
        calls: 0,
    })
});

fn dispatch(request: &Value) -> Result<Value> {
    if request.get("abi").and_then(Value::as_u64) != Some(ABI_VERSION as u64) {
        return Err(Error::engine("Unsupported builder engine ABI."));
    }
    let op = request.get("op").and_then(Value::as_str).unwrap_or("");
    let args = request
        .get("args")
        .and_then(Value::as_array)
        .ok_or_else(|| Error::engine("Engine arguments are required."))?
        .iter()
        .map(Js::wire)
        .collect::<Result<Vec<_>>>()?;
    let arg = |i| args.get(i).unwrap_or(&js::UNDEFINED);
    STATE.lock().unwrap().calls += 1;
    Ok(match op {
        "normalizeBuilder" | "validateBuilderDraft" => json(compiler::normalize(arg(0))?),
        "generateBuilderQuery" => compiler::generate(arg(0))?,
        "normalizeBuilderOperator" => json(compiler::operator(arg(0))?),
        "parseBuilderReference" => compiler::parse_reference(arg(0), arg(1).truthy())?,
        "validateMeasureExpression" => json(compiler::expression(arg(0))?),
        "validateQuery" => json(read_query::validate(arg(0))?),
        "builderDataType" => json(compiler::data_type(arg(0))?),
        "defaultBuilderOperator" => json(if compiler::data_type(arg(0)).ok() == Some("text") {
            "Contains"
        } else {
            "Is"
        }),
        "builderParameterName" => json(compiler::parameter(arg(0))?),
        "builderLiteral" => json(compiler::literal(arg(0), arg(1))?),
        "hasBuilderParameters" => json(compiler::has_parameters(&compiler::normalize(arg(0))?)),
        "collectBuilderParameters" => {
            json(compiler::collect_parameters(&compiler::normalize(arg(0))?)?)
        }
        "schema.create" => {
            let schema = if let Some(rows) = request.get("schemaRows") {
                schema::Schema::from_wire(rows)?
            } else {
                schema::Schema::new(arg(0))?
            };
            let mut state = STATE.lock().unwrap();
            if state.schemas.len() >= MAX_SCHEMAS {
                return Err(Error::coded(
                    "Release an existing schema index before retaining another.",
                    "ENGINE_SCHEMA_LIMIT",
                ));
            }
            let id = state.next;
            state.next = state
                .next
                .checked_add(1)
                .ok_or_else(|| Error::engine("Schema handle limit reached."))?;
            state.schemas.insert(id, schema);
            state.builds += 1;
            json(id)
        }
        "schema.release" => {
            let id = if let Js::Number(n) = arg(0) {
                *n as u32
            } else {
                0
            };
            json(STATE.lock().unwrap().schemas.remove(&id).is_some())
        }
        "schema.validate" => {
            let builder = compiler::normalize(arg(0))?;
            let id = if let Js::Number(n) = arg(1) {
                *n as u32
            } else {
                0
            };
            let state = STATE.lock().unwrap();
            let schema = state.schemas.get(&id).ok_or_else(|| {
                Error::coded(
                    "Native schema index is no longer retained.",
                    "ENGINE_SCHEMA_EXPIRED",
                )
            })?;
            json(schema.validate(builder)?)
        }
        "schema.search" => {
            let id = if let Js::Number(n) = arg(0) {
                *n as u32
            } else {
                0
            };
            let limit = if let Js::Number(n) = arg(2) {
                (*n as usize).min(50)
            } else {
                30
            };
            let state = STATE.lock().unwrap();
            let schema = state.schemas.get(&id).ok_or_else(|| {
                Error::coded(
                    "Native schema index is no longer retained.",
                    "ENGINE_SCHEMA_EXPIRED",
                )
            })?;
            json(schema.search(arg(1), limit)?)
        }
        "health" => {
            let state = STATE.lock().unwrap();
            json_value!({ "runtime": "rust-wasm", "abiVersion": ABI_VERSION, "version": env!("CARGO_PKG_VERSION"),
                "compiler": "dax-workbench-core", "schemaIndexCapacity": MAX_SCHEMAS, "retainedSchemaIndices": state.schemas.len(),
                "schemaIndexBuilds": state.builds, "calls": state.calls })
        }
        _ => return Err(Error::engine("Unknown builder engine operation.")),
    })
}

/// Platform-neutral JSON dispatcher, also usable by native integrations and Rust tests.
pub fn invoke_json(input: &[u8]) -> Vec<u8> {
    let result = if input.len() > MAX_REQUEST {
        Err(Error::engine("Engine request exceeds its byte limit."))
    } else {
        serde_json::from_slice::<Value>(input)
            .map_err(|_| Error::engine("Invalid engine request JSON."))
            .and_then(|v| dispatch(&v))
    };
    serde_json::to_vec(&match result {
        Ok(value) => json_value!({ "ok": true, "value": value }),
        Err(error) => json_value!({ "ok": false, "error": error }),
    })
    .expect("serializable response")
}

// The host owns all ABI buffers. Boxed slices make deallocation independent of
// Vec capacity; lengths must match and memory views must be refreshed after calls.
#[unsafe(no_mangle)]
#[cfg(target_arch = "wasm32")]
pub extern "C" fn alloc(len: u32) -> u32 {
    if len as usize > MAX_REQUEST {
        return 0;
    }
    let buffer = vec![0u8; len as usize].into_boxed_slice();
    Box::into_raw(buffer) as *mut u8 as u32
}
#[unsafe(no_mangle)]
#[cfg(target_arch = "wasm32")]
/// # Safety
/// `ptr` must be a live buffer allocated by this module, with its exact length.
pub unsafe extern "C" fn dealloc(ptr: u32, len: u32) {
    if ptr != 0 {
        unsafe {
            drop(Box::from_raw(std::ptr::slice_from_raw_parts_mut(
                ptr as *mut u8,
                len as usize,
            )));
        }
    }
}
#[unsafe(no_mangle)]
#[cfg(target_arch = "wasm32")]
/// # Safety
/// The input must point to a live `len`-byte allocation in this module's memory.
/// The caller must free the returned response separately from the input.
pub unsafe extern "C" fn invoke(ptr: u32, len: u32) -> u64 {
    let input = unsafe { std::slice::from_raw_parts(ptr as *const u8, len as usize) };
    let output = invoke_json(input).into_boxed_slice();
    let length = output.len() as u32;
    let pointer = Box::into_raw(output) as *mut u8 as u32;
    ((pointer as u64) << 32) | length as u64
}
