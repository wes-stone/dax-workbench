use crate::error::EngineError;
use serde::de::{self, MapAccess, SeqAccess, Visitor};
use serde::{Deserialize, Deserializer};
use serde_json::{Map, Value};
use std::io::{self, BufRead};

pub const MAX_LINE_BYTES: usize = 2 * 1024 * 1024;
pub const MAX_DEPTH: usize = 64;

pub fn too_large() -> EngineError {
    EngineError::new("MESSAGE_TOO_LARGE", "The protocol message exceeds 2 MiB.")
}

pub fn invalid_json() -> EngineError {
    EngineError::new("INVALID_JSON", "The request is not valid protocol JSON.")
}

pub fn required<'a>(value: &'a Value, name: &str, max: usize) -> Result<&'a str, EngineError> {
    value
        .get(name)
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty() && s.encode_utf16().count() <= max)
        .ok_or_else(|| EngineError::new("INVALID_PARAMS", format!("A valid {name} is required.")))
}

// Keep draining after the bound, including invalid UTF-8, to preserve framing.
pub fn read_line(reader: &mut impl BufRead) -> io::Result<Option<Result<Vec<u8>, EngineError>>> {
    let mut line = Vec::new();
    let mut oversized = false;
    loop {
        let bytes = reader.fill_buf()?;
        if bytes.is_empty() {
            return Ok(if oversized {
                Some(Err(too_large()))
            } else if line.is_empty() {
                None
            } else {
                Some(Ok(line))
            });
        }
        let newline = bytes.iter().position(|b| *b == b'\n');
        let count = newline.unwrap_or(bytes.len());
        if !oversized {
            if count > MAX_LINE_BYTES - line.len() {
                oversized = true;
                line.clear();
            } else {
                line.extend_from_slice(&bytes[..count]);
            }
        }
        reader.consume(count + usize::from(newline.is_some()));
        if newline.is_some() {
            if oversized {
                return Ok(Some(Err(too_large())));
            }
            if line.last() == Some(&b'\r') {
                line.pop();
            }
            return Ok(Some(Ok(line)));
        }
    }
}

fn check_depth(bytes: &[u8]) -> Result<(), EngineError> {
    let (mut depth, mut quoted, mut escaped) = (0usize, false, false);
    for byte in bytes {
        if quoted {
            if escaped {
                escaped = false;
            } else if *byte == b'\\' {
                escaped = true;
            } else if *byte == b'"' {
                quoted = false;
            }
        } else {
            match byte {
                b'"' => quoted = true,
                b'{' | b'[' => {
                    depth += 1;
                    if depth > MAX_DEPTH {
                        return Err(invalid_json());
                    }
                }
                b'}' | b']' => depth = depth.saturating_sub(1),
                _ => {}
            }
        }
    }
    Ok(())
}

// Reject duplicate fields before a provider-specific validator can lose them.
struct StrictValue(Value);
impl<'de> Deserialize<'de> for StrictValue {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct StrictVisitor;
        impl<'de> Visitor<'de> for StrictVisitor {
            type Value = StrictValue;
            fn expecting(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
                f.write_str("JSON with unique object keys")
            }
            fn visit_bool<E: de::Error>(self, v: bool) -> Result<Self::Value, E> {
                Ok(StrictValue(v.into()))
            }
            fn visit_i64<E: de::Error>(self, v: i64) -> Result<Self::Value, E> {
                Ok(StrictValue(v.into()))
            }
            fn visit_u64<E: de::Error>(self, v: u64) -> Result<Self::Value, E> {
                Ok(StrictValue(v.into()))
            }
            fn visit_f64<E: de::Error>(self, v: f64) -> Result<Self::Value, E> {
                serde_json::Number::from_f64(v)
                    .map(|n| StrictValue(Value::Number(n)))
                    .ok_or_else(|| E::custom("Invalid number"))
            }
            fn visit_str<E: de::Error>(self, v: &str) -> Result<Self::Value, E> {
                Ok(StrictValue(v.into()))
            }
            fn visit_string<E: de::Error>(self, v: String) -> Result<Self::Value, E> {
                Ok(StrictValue(v.into()))
            }
            fn visit_unit<E: de::Error>(self) -> Result<Self::Value, E> {
                Ok(StrictValue(Value::Null))
            }
            fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<Self::Value, A::Error> {
                let mut array = Vec::new();
                while let Some(StrictValue(value)) = seq.next_element()? {
                    array.push(value);
                }
                Ok(StrictValue(Value::Array(array)))
            }
            fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Self::Value, A::Error> {
                let mut object = Map::new();
                while let Some(key) = map.next_key::<String>()? {
                    if object.contains_key(&key) {
                        return Err(de::Error::custom("Duplicate field"));
                    }
                    object.insert(key, map.next_value::<StrictValue>()?.0);
                }
                Ok(StrictValue(Value::Object(object)))
            }
        }
        deserializer.deserialize_any(StrictVisitor)
    }
}

pub fn parse(bytes: &[u8]) -> Result<Value, EngineError> {
    if bytes.len() > MAX_LINE_BYTES {
        return Err(too_large());
    }
    check_depth(bytes)?;
    serde_json::from_slice::<StrictValue>(bytes)
        .map(|v| v.0)
        .map_err(|_| invalid_json())
}

pub fn validate_value_depth(value: &Value, depth: usize) -> Result<(), EngineError> {
    match value {
        Value::Object(map) => {
            if depth >= MAX_DEPTH {
                return Err(invalid_json());
            }
            for value in map.values() {
                validate_value_depth(value, depth + 1)?;
            }
        }
        Value::Array(array) => {
            if depth >= MAX_DEPTH {
                return Err(invalid_json());
            }
            for value in array {
                validate_value_depth(value, depth + 1)?;
            }
        }
        _ => {}
    }
    Ok(())
}

pub fn encode(value: &Value) -> Result<Vec<u8>, EngineError> {
    struct Bounded(Vec<u8>);
    impl io::Write for Bounded {
        fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
            if bytes.len() > MAX_LINE_BYTES - self.0.len() {
                return Err(io::Error::other("Protocol limit"));
            }
            self.0.extend_from_slice(bytes);
            Ok(bytes.len())
        }
        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }
    validate_value_depth(value, 0)?;
    let mut output = Bounded(Vec::new());
    serde_json::to_writer(&mut output, value).map_err(|_| too_large())?;
    output.0.push(b'\n');
    Ok(output.0)
}

pub struct Request {
    pub id: String,
    pub method: String,
    pub params: Value,
}

impl Request {
    pub fn parse(value: Value) -> Result<Self, EngineError> {
        let id = required(&value, "id", 128)?.to_owned();
        let method = required(&value, "method", 128)?.to_owned();
        if value
            .get("protocolVersion")
            .is_some_and(|v| v.as_u64() != Some(1))
        {
            return Err(EngineError::new(
                "PROTOCOL_MISMATCH",
                "Only native protocol version 1 is supported.",
            ));
        }
        let params = value
            .get("params")
            .cloned()
            .unwrap_or_else(|| Value::Object(Map::new()));
        if !params.is_object() {
            return Err(EngineError::new(
                "INVALID_PARAMS",
                "params must be an object.",
            ));
        }
        Ok(Self { id, method, params })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    #[test]
    fn decimal_numbers_round_to_the_nearest_binary64() {
        for (text, expected) in [
            ("0.84551240822557006", 0.8455124082255701_f64),
            ("9007199254740993.0", 9007199254740992.0_f64),
            ("2.2250738585072012e-308", f64::MIN_POSITIVE),
        ] {
            let actual = parse(text.as_bytes()).unwrap().as_f64().unwrap();
            assert_eq!(actual.to_bits(), expected.to_bits(), "{text}");
        }
    }

    #[test]
    fn framing_drains_and_recovers() {
        let mut bytes = vec![b'x'; MAX_LINE_BYTES + 19];
        bytes.extend_from_slice(b"\n{\"id\":\"ok\"}\r\nlast");
        let mut reader = Cursor::new(bytes);
        assert_eq!(
            read_line(&mut reader).unwrap().unwrap().unwrap_err().code,
            "MESSAGE_TOO_LARGE"
        );
        assert_eq!(
            read_line(&mut reader).unwrap().unwrap().unwrap(),
            br#"{"id":"ok"}"#
        );
        assert_eq!(read_line(&mut reader).unwrap().unwrap().unwrap(), b"last");
        assert!(read_line(&mut reader).unwrap().is_none());
    }

    #[test]
    fn strict_json_depth_and_utf8() {
        assert!(parse(&[b'"', 0xff, b'"']).is_err());
        assert!(parse(br#"{"id":"a","id":"b"}"#).is_err());
        assert!(parse(format!("{}0{}", "[".repeat(64), "]".repeat(64)).as_bytes()).is_ok());
        assert!(parse(format!("{}0{}", "[".repeat(65), "]".repeat(65)).as_bytes()).is_err());
        assert!(parse(br#"{"escaped":"[\"{"}"#).is_ok());
    }

    #[test]
    fn keys_use_utf16_bounds() {
        let value = serde_json::json!({"key": "😀".repeat(128)});
        assert!(required(&value, "key", 256).is_ok());
        assert!(required(&value, "key", 255).is_err());
    }
}
