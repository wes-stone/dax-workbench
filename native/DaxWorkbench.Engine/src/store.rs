use crate::{error::EngineError, protocol};
use rusqlite::{Connection, OptionalExtension, TransactionBehavior, params};
use serde_json::{Value, json};
use std::{path::Path, time::Duration};
use zeroize::Zeroizing;

const MAX_REVISION: i64 = 9_007_199_254_740_991;
const MAX_PLAINTEXT: usize = 1_500_000;

pub struct Store {
    db: Connection,
}

impl Store {
    pub fn open(artifacts: &Path) -> Result<Self, EngineError> {
        if !artifacts.is_absolute() {
            return Err(EngineError::new(
                "INVALID_ARTIFACTS",
                "--artifacts requires an absolute directory.",
            ));
        }
        std::fs::create_dir_all(artifacts).map_err(|_| {
            EngineError::new("STORE_FAILED", "The local store directory is unavailable.")
        })?;
        let db = Connection::open(artifacts.join("workbench.sqlite3"))?;
        db.busy_timeout(Duration::from_secs(5))?;
        db.execute_batch(
            "PRAGMA journal_mode=WAL;
             CREATE TABLE IF NOT EXISTS records (
               key TEXT PRIMARY KEY, revision INTEGER NOT NULL, payload BLOB NOT NULL
             );
             CREATE TABLE IF NOT EXISTS connections (
               id TEXT PRIMARY KEY, name TEXT NOT NULL, kind TEXT NOT NULL,
               model TEXT, secret BLOB NOT NULL
             );",
        )?;
        Ok(Self { db })
    }

    pub fn dispatch(&mut self, method: &str, parameters: &Value) -> Result<Value, EngineError> {
        let key = protocol::required(parameters, "key", 256)?;
        if key.chars().any(char::is_control) {
            return Err(EngineError::new("INVALID_PARAMS", "Invalid store key."));
        }
        match method {
            "store.read" => self.read(key),
            "store.write" => {
                let expected = parameters
                    .get("expectedRevision")
                    .and_then(Value::as_i64)
                    .filter(|n| (0..MAX_REVISION).contains(n))
                    .ok_or_else(|| {
                        EngineError::new("INVALID_PARAMS", "Invalid expectedRevision.")
                    })?;
                let value = parameters.get("value").ok_or_else(|| {
                    EngineError::new(
                        "INVALID_PARAMS",
                        "store.write requires expectedRevision and value.",
                    )
                })?;
                self.write(key, expected, value)
            }
            _ => Err(EngineError::new(
                "METHOD_NOT_FOUND",
                "This native protocol method is not supported.",
            )),
        }
    }

    fn read(&self, key: &str) -> Result<Value, EngineError> {
        let record = self
            .db
            .query_row(
                "SELECT revision,payload FROM records WHERE key=?1",
                [key],
                |row| Ok((row.get::<_, i64>(0)?, row.get::<_, Vec<u8>>(1)?)),
            )
            .optional()?;
        let Some((revision, payload)) = record else {
            return Ok(json!({"value": null, "revision": 0}));
        };
        if !(1..=MAX_REVISION).contains(&revision) || payload.len() > MAX_PLAINTEXT + 65_536 {
            return Err(corrupt());
        }
        let plaintext = unprotect(&payload)?;
        if plaintext.len() > MAX_PLAINTEXT {
            return Err(corrupt());
        }
        let value = protocol::parse(&plaintext).map_err(|_| corrupt())?;
        if !value.is_object() && !value.is_null() {
            return Err(corrupt());
        }
        Ok(json!({"value": value, "revision": revision}))
    }

    fn write(&mut self, key: &str, expected: i64, value: &Value) -> Result<Value, EngineError> {
        if !value.is_object() && !value.is_null() {
            return Err(EngineError::new(
                "INVALID_PARAMS",
                "Stored value must be an object or null.",
            ));
        }
        protocol::validate_value_depth(value, 0)?;
        let mut plaintext = Zeroizing::new(Vec::new());
        serde_json::to_writer(&mut *plaintext, value).map_err(|_| corrupt())?;
        if plaintext.len() > MAX_PLAINTEXT {
            return Err(EngineError::new(
                "STORE_TOO_LARGE",
                "Stored value exceeds the 1.5 MB limit.",
            ));
        }
        let payload = protect(&plaintext)?;
        drop(plaintext);
        let transaction = self
            .db
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let changed = if expected == 0 {
            transaction.execute(
                "INSERT INTO records(key,revision,payload) VALUES(?1,1,?2) ON CONFLICT(key) DO NOTHING",
                params![key, payload]
            )?
        } else {
            transaction.execute(
                "UPDATE records SET revision=revision+1,payload=?2 WHERE key=?1 AND revision=?3",
                params![key, payload, expected],
            )?
        };
        if changed != 1 {
            return Err(EngineError::new(
                "STORE_CONFLICT",
                "The saved state changed. Read the latest revision and retry.",
            ));
        }
        transaction.commit()?;
        Ok(json!({"revision": expected + 1}))
    }
}

fn corrupt() -> EngineError {
    EngineError::new("STORE_FAILED", "The local store operation failed.")
}

#[cfg(windows)]
fn crypt(value: &[u8], encrypt: bool) -> Result<Zeroizing<Vec<u8>>, EngineError> {
    use std::ptr::{null, null_mut};
    use windows_sys::Win32::{
        Foundation::LocalFree,
        Security::Cryptography::{
            CRYPT_INTEGER_BLOB, CRYPTPROTECT_UI_FORBIDDEN, CryptProtectData, CryptUnprotectData,
        },
    };
    use zeroize::Zeroize;

    struct Output(CRYPT_INTEGER_BLOB);
    impl Drop for Output {
        fn drop(&mut self) {
            if !self.0.pbData.is_null() {
                unsafe {
                    std::slice::from_raw_parts_mut(self.0.pbData, self.0.cbData as usize).zeroize();
                    LocalFree(self.0.pbData.cast());
                }
            }
        }
    }
    let entropy = b"DaxWorkbench.Native.Store.v1";
    let input = CRYPT_INTEGER_BLOB {
        cbData: value.len().try_into().map_err(|_| corrupt())?,
        pbData: value.as_ptr().cast_mut(),
    };
    let entropy = CRYPT_INTEGER_BLOB {
        cbData: entropy.len() as u32,
        pbData: entropy.as_ptr().cast_mut(),
    };
    let mut output = Output(CRYPT_INTEGER_BLOB {
        cbData: 0,
        pbData: null_mut(),
    });
    let success = unsafe {
        if encrypt {
            CryptProtectData(
                &input,
                null(),
                &entropy,
                null(),
                null(),
                CRYPTPROTECT_UI_FORBIDDEN,
                &mut output.0,
            )
        } else {
            CryptUnprotectData(
                &input,
                null_mut(),
                &entropy,
                null(),
                null(),
                CRYPTPROTECT_UI_FORBIDDEN,
                &mut output.0,
            )
        }
    };
    if success == 0 || output.0.pbData.is_null() {
        return Err(corrupt());
    }
    Ok(Zeroizing::new(unsafe {
        std::slice::from_raw_parts(output.0.pbData, output.0.cbData as usize).to_vec()
    }))
}

#[cfg(not(windows))]
fn crypt(_: &[u8], _: bool) -> Result<Zeroizing<Vec<u8>>, EngineError> {
    Err(EngineError::new(
        "PLATFORM_UNSUPPORTED",
        "The native store requires Windows CurrentUser DPAPI.",
    ))
}

fn protect(value: &[u8]) -> Result<Vec<u8>, EngineError> {
    Ok(crypt(value, true)?.to_vec())
}

fn unprotect(value: &[u8]) -> Result<Zeroizing<Vec<u8>>, EngineError> {
    crypt(value, false)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    #[cfg(windows)]
    fn dpapi_roundtrip_and_tampering() {
        let secret = b"{\"synthetic\":\"only\"}";
        let mut ciphertext = protect(secret).unwrap();
        assert_ne!(&ciphertext, secret);
        assert_eq!(&*unprotect(&ciphertext).unwrap(), secret);
        ciphertext[0] ^= 1;
        assert_eq!(unprotect(&ciphertext).unwrap_err().code, "STORE_FAILED");
    }
}
