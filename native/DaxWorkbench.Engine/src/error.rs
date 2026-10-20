use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
pub struct EngineError {
    pub code: String,
    pub message: String,
}

impl EngineError {
    pub fn new(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
        }
    }

    pub fn unavailable() -> Self {
        Self::new(
            "ENGINE_UNAVAILABLE",
            "The Microsoft provider adapter is unavailable. Restart the native companion.",
        )
    }
}

impl std::fmt::Display for EngineError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.code, self.message)
    }
}

impl std::error::Error for EngineError {}

impl From<rusqlite::Error> for EngineError {
    fn from(error: rusqlite::Error) -> Self {
        if matches!(&error, rusqlite::Error::SqliteFailure(code, _)
            if matches!(code.code, rusqlite::ErrorCode::DatabaseBusy | rusqlite::ErrorCode::DatabaseLocked))
        {
            Self::new(
                "STORE_BUSY",
                "The local store is busy. Retry the operation.",
            )
        } else {
            Self::new("STORE_FAILED", "The local store operation failed.")
        }
    }
}
