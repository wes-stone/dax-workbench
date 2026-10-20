use crate::js::{Error, Js, Result, space, trim, units};

fn word_start(c: char) -> bool {
    c.is_ascii_alphabetic() || matches!(c, '_' | '$')
}

pub fn validate(query: &Js) -> Result<String> {
    let Some(query) = query
        .string()
        .filter(|s| !trim(s).is_empty() && units(s) <= 100_000)
    else {
        return Err(Error::coded(
            "DAX must contain 1 to 100,000 characters.",
            "INVALID_QUERY",
        ));
    };
    let chars: Vec<char> = query.chars().collect();
    let mut i = 0;
    let mut first_is_read = None;
    let mut evaluate = false;
    let mut administrative = false;
    while i < chars.len() {
        let c = chars[i];
        let next = chars.get(i + 1).copied();
        if space(c) {
            i += 1;
            continue;
        }
        if (c == '-' && next == Some('-')) || (c == '/' && next == Some('/')) {
            i += 2;
            while i < chars.len() && chars[i] != '\n' {
                i += 1;
            }
            continue;
        }
        if c == '/' && next == Some('*') {
            i += 2;
            while i + 1 < chars.len() && !(chars[i] == '*' && chars[i + 1] == '/') {
                i += 1;
            }
            if i + 1 >= chars.len() {
                return Err(Error::coded("Unterminated DAX comment.", "INVALID_QUERY"));
            }
            i += 2;
            continue;
        }
        if matches!(c, '"' | '\'' | '[') {
            let closing = if c == '[' { ']' } else { c };
            i += 1;
            let mut closed = false;
            while i < chars.len() {
                if chars[i] == closing {
                    if chars.get(i + 1) == Some(&closing) {
                        i += 2;
                        continue;
                    }
                    i += 1;
                    closed = true;
                    break;
                }
                i += 1;
            }
            if !closed {
                return Err(Error::coded(
                    "Unterminated DAX string or identifier.",
                    "INVALID_QUERY",
                ));
            }
            first_is_read.get_or_insert(false);
            continue;
        }
        if word_start(c) {
            let start = i;
            i += 1;
            while i < chars.len() && (word_start(chars[i]) || chars[i].is_ascii_digit()) {
                i += 1;
            }
            let word: String = chars[start..i]
                .iter()
                .map(char::to_ascii_uppercase)
                .collect();
            first_is_read.get_or_insert(matches!(word.as_str(), "EVALUATE" | "DEFINE"));
            evaluate |= word == "EVALUATE";
            administrative |= matches!(
                word.as_str(),
                "ALTER"
                    | "CREATE"
                    | "DELETE"
                    | "DROP"
                    | "INSERT"
                    | "UPDATE"
                    | "REFRESH"
                    | "DBCC"
                    | "CALL"
                    | "EXEC"
                    | "EXECUTE"
                    | "$SYSTEM"
                    | "INFO"
            );
        } else {
            first_is_read.get_or_insert(false);
            i += 1;
        }
    }
    // Preserve the original error precedence: lexing finishes before read-only
    // admission, and the query's first token is checked before blocked words.
    if first_is_read != Some(true) || !evaluate {
        return Err(Error::coded(
            "Only DAX EVALUATE queries with optional query-local DEFINE declarations are supported.",
            "READ_QUERY_REQUIRED",
        ));
    }
    if administrative {
        return Err(Error::coded(
            "Administrative commands and INFO queries are unavailable in the query editor. Use the model explorer.",
            "READ_QUERY_REQUIRED",
        ));
    }
    Ok(query.into())
}
