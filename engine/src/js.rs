use serde::Serialize;
use serde_json::{Map, Value};
use std::collections::HashMap;

#[derive(Clone, Debug)]
pub enum Js {
    Undefined,
    Null,
    Bool(bool),
    Number(f64),
    String(String),
    Array(Vec<Js>),
    OversizeArray(usize),
    Object(HashMap<String, Js>, bool),
    Other(String),
}
pub static UNDEFINED: Js = Js::Undefined;
impl Js {
    pub fn get(&self, key: &str) -> &Js {
        match self {
            Self::Object(v, _) => v.get(key).unwrap_or(&UNDEFINED),
            _ => &UNDEFINED,
        }
    }
    pub fn owns_table(&self) -> bool {
        matches!(self, Self::Object(_, true))
    }
    pub fn defined(&self) -> bool {
        !matches!(self, Self::Undefined)
    }
    pub fn nullish(&self) -> bool {
        matches!(self, Self::Undefined | Self::Null)
    }
    pub fn string(&self) -> Option<&str> {
        if let Self::String(s) = self {
            Some(s)
        } else {
            None
        }
    }
    pub fn truthy(&self) -> bool {
        match self {
            Self::Undefined | Self::Null => false,
            Self::Bool(b) => *b,
            Self::Number(n) => *n != 0.0 && !n.is_nan(),
            Self::String(s) => !s.is_empty(),
            _ => true,
        }
    }
    pub fn display(&self) -> String {
        match self {
            Self::Undefined => "undefined".into(),
            Self::Null => "null".into(),
            Self::Bool(b) => b.to_string(),
            Self::Number(n) => {
                if n.is_nan() {
                    "NaN".into()
                } else if *n == f64::INFINITY {
                    "Infinity".into()
                } else if *n == f64::NEG_INFINITY {
                    "-Infinity".into()
                } else {
                    n.to_string()
                }
            }
            Self::String(s) | Self::Other(s) => s.clone(),
            Self::Array(a) => a
                .iter()
                .map(|v| {
                    if v.nullish() {
                        String::new()
                    } else {
                        v.display()
                    }
                })
                .collect::<Vec<_>>()
                .join(","),
            Self::Object(_, _) => "[object Object]".into(),
            Self::OversizeArray(n) => format!("[Array({n})]"),
        }
    }
    pub fn wire(v: &Value) -> Result<Self> {
        let a = v
            .as_array()
            .ok_or_else(|| Error::engine("Malformed engine value."))?;
        let tag = a.first().and_then(Value::as_str).unwrap_or("");
        let value = a.get(1).unwrap_or(&Value::Null);
        Ok(match tag {
            "u" => Self::Undefined,
            "z" => Self::Null,
            "b" => Self::Bool(value.as_bool().unwrap_or(false)),
            "n" => Self::Number(value.as_f64().unwrap_or_else(|| match value.as_str() {
                Some("Infinity") => f64::INFINITY,
                Some("-Infinity") => f64::NEG_INFINITY,
                _ => f64::NAN,
            })),
            "s" => Self::String(value.as_str().unwrap_or("").into()),
            "a" => Self::Array(
                value
                    .as_array()
                    .ok_or_else(|| Error::engine("Malformed engine array."))?
                    .iter()
                    .map(Self::wire)
                    .collect::<Result<_>>()?,
            ),
            "l" => Self::OversizeArray(value.as_u64().unwrap_or(100001) as usize),
            "o" => Self::Object(
                value
                    .as_object()
                    .ok_or_else(|| Error::engine("Malformed engine object."))?
                    .iter()
                    .map(|(k, v)| Ok((k.clone(), Self::wire(v)?)))
                    .collect::<Result<_>>()?,
                a.get(2).and_then(Value::as_bool).unwrap_or(false),
            ),
            "x" => Self::Other(value.as_str().unwrap_or("").into()),
            _ => return Err(Error::engine("Unknown engine value.")),
        })
    }
    pub fn from_json(value: Value) -> Self {
        match value {
            Value::Null => Self::Null,
            Value::Bool(v) => Self::Bool(v),
            Value::Number(v) => Self::Number(v.as_f64().unwrap_or(f64::NAN)),
            Value::String(v) => Self::String(v),
            Value::Array(v) => Self::Array(v.into_iter().map(Self::from_json).collect()),
            Value::Object(v) => {
                let owns_table = v.contains_key("table");
                Self::Object(
                    v.into_iter()
                        .map(|(k, v)| (k, Self::from_json(v)))
                        .collect(),
                    owns_table,
                )
            }
        }
    }
}

#[derive(Debug, Serialize)]
pub struct Error {
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub code: Option<&'static str>,
    pub name: &'static str,
}
impl Error {
    pub fn new(message: impl Into<String>) -> Self {
        Self::coded(message, "INVALID_BUILDER")
    }
    pub fn coded(message: impl Into<String>, code: &'static str) -> Self {
        Self {
            message: message.into(),
            code: Some(code),
            name: "Error",
        }
    }
    pub fn schema(message: impl Into<String>) -> Self {
        Self::coded(message, "BUILDER_SCHEMA_MISMATCH")
    }
    pub fn engine(message: impl Into<String>) -> Self {
        Self::coded(message, "ENGINE_PROTOCOL_ERROR")
    }
    pub fn type_error(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            code: None,
            name: "TypeError",
        }
    }
}
pub type Result<T> = std::result::Result<T, Error>;
pub fn bad_key(k: &str) -> bool {
    matches!(k, "__proto__" | "prototype" | "constructor")
}
pub fn object<'a>(value: &'a Js, label: &str) -> Result<&'a HashMap<String, Js>> {
    if let Js::Object(o, _) = value {
        if o.keys().any(|k| bad_key(k)) {
            return Err(Error::new("Unsafe builder property."));
        }
        Ok(o)
    } else {
        Err(Error::new(format!("{label} must be an object.")))
    }
}
pub fn array<'a>(value: &'a Js, label: &str) -> Result<&'a [Js]> {
    if let Js::Array(a) = value
        && a.len() <= 200
    {
        return Ok(a);
    }
    Err(Error::new(format!(
        "{label} must be an array of at most 200 items."
    )))
}
// The wire codec maps lone UTF-16 surrogates into an escaped private-use range.
// Actual characters from that range are prefixed, so the mapping is lossless.
pub fn units(s: &str) -> usize {
    let mut chars = s.chars();
    let mut len = 0;
    while let Some(c) = chars.next() {
        len += if c == '\u{f0800}' {
            chars.next().map_or(0, char::len_utf16)
        } else if ('\u{f0000}'..='\u{f07ff}').contains(&c) {
            1
        } else {
            c.len_utf16()
        };
    }
    len
}
pub fn utf8_bytes(s: &str) -> usize {
    let mut chars = s.chars();
    let mut len = 0;
    while let Some(c) = chars.next() {
        len += if c == '\u{f0800}' {
            chars.next().map_or(0, char::len_utf8)
        } else if ('\u{f0000}'..='\u{f07ff}').contains(&c) {
            3
        } else {
            c.len_utf8()
        };
    }
    len
}
pub fn space(c: char) -> bool {
    matches!(c, '\u{0009}'..='\u{000d}' | '\u{0020}' | '\u{00a0}' | '\u{1680}' |
        '\u{2000}'..='\u{200a}' | '\u{2028}' | '\u{2029}' | '\u{202f}' | '\u{205f}' | '\u{3000}' | '\u{feff}')
}
pub fn trim(s: &str) -> &str {
    s.trim_matches(space)
}
pub fn text<'a>(value: &'a Js, label: &str, max: usize, empty: bool) -> Result<&'a str> {
    if let Some(s) = value.string()
        && units(s) <= max
        && !s.contains('\0')
        && (empty || !trim(s).is_empty())
    {
        return Ok(s);
    }
    Err(Error::new(format!(
        "{label} must be a {}bounded string.",
        if empty { "" } else { "non-empty " }
    )))
}
pub fn identifier(value: &Js, label: &str, max: usize) -> Result<String> {
    let s = text(value, label, max, false)?;
    if s.chars().any(|c| c <= '\u{1f}' || c == '\u{7f}') {
        return Err(Error::new(format!(
            "{label} cannot contain control characters."
        )));
    }
    Ok(s.into())
}
pub fn json<T: Serialize>(value: T) -> Value {
    serde_json::to_value(value).expect("serializable engine result")
}
pub fn json_object() -> Map<String, Value> {
    Map::new()
}
pub fn legacy_id(parts: &[&str]) -> String {
    let serialized = serde_json::to_string(parts).expect("serializable identity");
    let mut chars = serialized.chars();
    let mut output = String::new();
    while let Some(c) = chars.next() {
        if c == '\u{f0800}' {
            output.push(c);
            if let Some(next) = chars.next() {
                output.push(next);
            }
        } else if ('\u{f0000}'..='\u{f07ff}').contains(&c) {
            output.push_str(&format!("\\u{:04x}", 0xd800 + c as u32 - 0xf0000));
        } else {
            output.push(c);
        }
    }
    output
}
