use crate::js::*;
use regex::Regex;
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::sync::LazyLock;

pub const START: &str = "/* START QUERY BUILDER */";
pub const END: &str = "/* END QUERY BUILDER */";
pub const OPERATORS: [&str; 15] = [
    "Is",
    "IsNot",
    "StartsWith",
    "DoesNotStartWith",
    "Contains",
    "DoesNotContain",
    "GreaterThan",
    "GreaterThanOrEqual",
    "LessThan",
    "LessThanOrEqual",
    "IsBlank",
    "IsNotBlank",
    "Between",
    "In",
    "NotIn",
];
fn regex(s: &str) -> Regex {
    Regex::new(s).expect("static engine regex")
}
pub fn blank(op: &str) -> bool {
    matches!(op, "IsBlank" | "IsNotBlank")
}
pub fn operator(value: &Js) -> Result<String> {
    let Some(s) = value.string() else {
        return Err(Error::new("Filter operator must be a string."));
    };
    let lower = s.to_lowercase();
    let alias = match lower.as_str() {
        "=" | "==" => Some("Is"),
        "!=" | "<>" | "is_not" => Some("IsNot"),
        ">" => Some("GreaterThan"),
        ">=" => Some("GreaterThanOrEqual"),
        "<" => Some("LessThan"),
        "<=" => Some("LessThanOrEqual"),
        "starts_with" => Some("StartsWith"),
        "does_not_start_with" => Some("DoesNotStartWith"),
        "does_not_contain" => Some("DoesNotContain"),
        "not_in" => Some("NotIn"),
        "is_blank" => Some("IsBlank"),
        "is_not_blank" => Some("IsNotBlank"),
        _ => OPERATORS
            .iter()
            .copied()
            .find(|op| op.to_lowercase() == lower),
    };
    alias
        .map(String::from)
        .ok_or_else(|| Error::new(format!("Unsupported builder filter operator: {s}.")))
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Field {
    pub id: String,
    pub kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub table: Option<String>,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub caption: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub is_custom: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expression: Option<String>,
}
impl Field {
    pub fn identity(&self) -> (String, String, String) {
        (
            self.kind.clone(),
            self.table.as_deref().unwrap_or("").to_lowercase(),
            self.name.to_lowercase(),
        )
    }
    pub fn same(&self, other: &Self) -> bool {
        self.identity() == other.identity()
            && self.expression == other.expression
            && self.custom() == other.custom()
    }
    pub fn custom(&self) -> bool {
        self.is_custom.unwrap_or(false)
    }
    pub fn is_column(&self) -> bool {
        self.kind == "column"
    }
    pub fn reference(&self) -> String {
        format!(
            "{}{}",
            self.table
                .as_deref()
                .filter(|s| self.is_column() || !s.is_empty())
                .map(quote_table)
                .unwrap_or_default(),
            quote_object(&self.name)
        )
    }
    pub fn data_type(&self) -> Result<&'static str> {
        data_type_parts(self.data_type.as_deref(), &self.kind)
    }
}
pub type Identity = (String, String, String);
fn optional_identifier(raw: &Js, key: &str, label: &str, max: usize) -> Result<Option<String>> {
    if raw.get(key).defined() {
        Ok(Some(identifier(raw.get(key), label, max)?))
    } else {
        Ok(None)
    }
}
fn optional_bool(raw: &Js, key: &str) -> Result<Option<bool>> {
    match raw.get(key) {
        Js::Undefined => Ok(None),
        Js::Bool(v) => Ok(Some(*v)),
        _ => Err(Error::new(format!("{key} must be boolean."))),
    }
}
pub fn normalize_field(raw: &Js) -> Result<Field> {
    object(raw, "Builder field")?;
    let id = identifier(raw.get("id"), "Field id", 1024)?;
    let kind = raw.get("kind").string().unwrap_or("");
    if !matches!(kind, "column" | "measure") {
        return Err(Error::new("Builder fields must be columns or measures."));
    }
    let table = optional_identifier(raw, "table", "Table name", 256)?;
    if kind == "column" && table.is_none() {
        return Err(Error::new("Columns require a table."));
    }
    let name = identifier(raw.get("name"), "Field name", 256)?;
    let data_type = optional_identifier(raw, "dataType", "Data type", 80)?;
    let caption = optional_identifier(raw, "caption", "Field caption", 256)?;
    let is_custom = optional_bool(raw, "isCustom")?;
    let expression = if raw.get("expression").defined() {
        if kind != "measure" || table.is_none() {
            return Err(Error::new(
                "Only measures with a table can define an expression.",
            ));
        }
        Some(text(raw.get("expression"), "Measure expression", 16384, true)?.into())
    } else {
        None
    };
    if is_custom == Some(true) && kind != "measure" {
        return Err(Error::new("Only measures can be custom fields."));
    }
    Ok(Field {
        id,
        kind: kind.into(),
        table,
        name,
        data_type,
        caption,
        is_custom,
        expression,
    })
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Filter {
    pub id: String,
    pub field: Field,
    pub operator: String,
    pub value: String,
    pub enabled: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub value2: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub is_parameter: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub is_parameter2: Option<bool>,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Order {
    pub field_id: String,
    pub direction: String,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Builder {
    pub version: u8,
    pub fields: Vec<Field>,
    pub filters: Vec<Filter>,
    pub order_by: Vec<Order>,
}
pub fn normalize(input: &Js) -> Result<Builder> {
    object(input, "Builder")?;
    if !matches!(input.get("version"), Js::Number(v) if *v == 2.0) {
        if input.get("version").defined() || !input.owns_table() {
            return Err(Error::coded(
                "Only canonical query builder version 2 is supported.",
                "UNSUPPORTED_VERSION",
            ));
        }
        let table = identifier(input.get("table"), "Table name", 256)?;
        let mut fields = Vec::new();
        for value in array(input.get("columns"), "Columns")? {
            let name = identifier(value, "Column name", 256)?;
            fields.push(Field {
                id: legacy_id(&["column", &table, &name]),
                kind: "column".into(),
                table: Some(table.clone()),
                name,
                data_type: None,
                caption: None,
                is_custom: None,
                expression: None,
            });
        }
        if input.get("measure").defined() && input.get("measure").string() != Some("") {
            let name = identifier(input.get("measure"), "Measure name", 256)?;
            fields.push(Field {
                id: legacy_id(&["measure", "", &name]),
                kind: "measure".into(),
                table: None,
                name,
                data_type: None,
                caption: None,
                is_custom: None,
                expression: None,
            });
        }
        return normalize(&Js::from_json(json(Builder {
            version: 2,
            fields,
            filters: vec![],
            order_by: vec![],
        })));
    }
    let fields = array(input.get("fields"), "Fields")?
        .iter()
        .map(normalize_field)
        .collect::<Result<Vec<_>>>()?;
    let mut ids = HashMap::new();
    let mut refs = HashSet::new();
    for field in &fields {
        if ids.contains_key(&field.id) || !refs.insert(field.identity()) {
            return Err(Error::new("Duplicate builder fields are not allowed."));
        }
        ids.insert(field.id.clone(), field);
    }
    let empty = Js::Array(vec![]);
    let raw_filters = if input.get("filters").nullish() {
        &empty
    } else {
        input.get("filters")
    };
    let mut filter_ids = HashSet::new();
    let mut filters = Vec::new();
    for raw in array(raw_filters, "Filters")? {
        object(raw, "Builder filter")?;
        let id = identifier(raw.get("id"), "Filter id", 1024)?;
        if !filter_ids.insert(id.clone()) {
            return Err(Error::new("Duplicate filter ids are not allowed."));
        }
        let field = normalize_field(raw.get("field"))?;
        if ids.get(&field.id).is_some_and(|prior| !prior.same(&field)) {
            return Err(Error::new(
                "A filter field conflicts with its selected field.",
            ));
        }
        let Js::Bool(enabled) = raw.get("enabled") else {
            return Err(Error::new("Filter enabled must be boolean."));
        };
        let operator = operator(raw.get("operator"))?;
        let value = if raw.get("value").nullish() {
            String::new()
        } else {
            text(raw.get("value"), "Filter value", 16384, true)?.into()
        };
        let value2 = if raw.get("value2").defined() {
            Some(text(raw.get("value2"), "Second filter value", 16384, true)?.into())
        } else {
            None
        };
        let is_parameter = optional_bool(raw, "isParameter")?;
        let is_parameter2 = optional_bool(raw, "isParameter2")?;
        filters.push(Filter {
            id,
            field,
            operator,
            value,
            enabled: *enabled,
            value2,
            is_parameter,
            is_parameter2,
        });
    }
    let mut order_by = Vec::new();
    if input.get("orderBy").nullish() {
        order_by.extend(fields.iter().filter(|f| f.is_column()).map(|f| Order {
            field_id: f.id.clone(),
            direction: "ASC".into(),
        }));
    } else {
        let mut order_ids = HashSet::new();
        for raw in array(input.get("orderBy"), "Order by")? {
            object(raw, "Builder ordering")?;
            let field_id = identifier(raw.get("fieldId"), "Sort field id", 1024)?;
            if !ids.contains_key(&field_id) {
                return Err(Error::new("Sort fields must be in the output selection."));
            }
            if order_ids.contains(&field_id) {
                return Err(Error::new("Duplicate sort fields are not allowed."));
            }
            let direction = raw.get("direction").string().unwrap_or("");
            if !matches!(direction, "ASC" | "DESC") {
                return Err(Error::new("Sort direction must be ASC or DESC."));
            }
            order_ids.insert(field_id.clone());
            order_by.push(Order {
                field_id,
                direction: direction.into(),
            });
        }
    }
    Ok(Builder {
        version: 2,
        fields,
        filters,
        order_by,
    })
}
pub fn quote_table(s: &str) -> String {
    format!("'{}'", s.replace('\'', "''"))
}
pub fn quote_object(s: &str) -> String {
    format!("[{}]", s.replace(']', "]]"))
}
pub fn quote_string(s: &str) -> String {
    format!("\"{}\"", s.replace('"', "\"\""))
}
pub fn parse_reference(value: &Js, column: bool) -> Result<serde_json::Value> {
    let s = text(value, "Schema reference", 768, false)?;
    static REF: LazyLock<Regex> =
        LazyLock::new(|| regex(r"^(?:'((?:[^']|'')+)')?\[((?:[^\]]|\]\])+)\]$"));
    let matched = REF
        .captures(s)
        .filter(|c| !column || c.get(1).is_some())
        .ok_or_else(|| {
            Error::new("Builder references must be quoted schema references, not arbitrary DAX.")
        })?;
    let name = matched[2].replace("]]", "]");
    identifier(&Js::String(name.clone()), "Object name", 256)?;
    let mut result = json_object();
    if let Some(table) = matched.get(1) {
        let table = table.as_str().replace("''", "'");
        identifier(&Js::String(table.clone()), "Table name", 256)?;
        result.insert("table".into(), json(table));
    }
    result.insert("name".into(), json(name));
    Ok(result.into())
}
pub fn expression(value: &Js) -> Result<String> {
    let s = text(value, "Measure expression", 16384, false)?;
    let chars: Vec<char> = s.chars().collect();
    let mut code = String::new();
    let mut stack = Vec::new();
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        let next = chars.get(i + 1).copied().unwrap_or('\0');
        if (c == '/' && next == '/') || (c == '-' && next == '-') {
            i += 2;
            while i < chars.len() && chars[i] != '\n' {
                i += 1;
            }
            if i < chars.len() {
                i += 1;
            }
            code.push(' ');
        } else if c == '/' && next == '*' {
            let start = i;
            i += 2;
            while i + 1 < chars.len() && !(chars[i] == '*' && chars[i + 1] == '/') {
                i += 1;
            }
            if i + 1 >= chars.len() {
                return Err(Error::new("Unterminated measure expression comment."));
            }
            i += 2;
            let comment: String = chars[start..i].iter().collect();
            if comment == START || comment == END {
                return Err(Error::new(
                    "Builder block markers are not allowed inside measure expressions.",
                ));
            }
            code.push(' ');
        } else if matches!(c, '"' | '\'' | '[') {
            let close = if c == '[' { ']' } else { c };
            i += 1;
            let mut ended = false;
            while i < chars.len() {
                if chars[i] != close {
                    i += 1;
                    continue;
                }
                if chars.get(i + 1) == Some(&close) {
                    i += 2;
                    continue;
                }
                i += 1;
                ended = true;
                break;
            }
            if !ended {
                return Err(Error::new(
                    "Unterminated measure expression string or identifier.",
                ));
            }
            code.push(' ');
        } else {
            if matches!(c, '(' | '{') {
                stack.push(c);
            }
            if matches!(c, ')' | '}') && stack.pop() != Some(if c == ')' { '(' } else { '{' }) {
                return Err(Error::new("Unbalanced measure expression delimiters."));
            }
            if matches!(c, ';' | '@' | '$' | '\\') {
                return Err(Error::new(
                    "Query statements and parameters are not allowed in a measure expression.",
                ));
            }
            code.push(c);
            i += 1;
        }
    }
    if !stack.is_empty() {
        return Err(Error::new("Unbalanced measure expression delimiters."));
    }
    // JavaScript's non-u word boundaries and case-insensitivity are ASCII, while \s includes BOM.
    static WORDS: LazyLock<Regex> = LazyLock::new(|| {
        regex(
            r"(?i-u:\b(?:DEFINE|EVALUATE|MEASURE|COLUMN|TABLE|FUNCTION|MPARAMETER|CREATE|ALTER|DROP|DELETE|INSERT|UPDATE|EXEC|EXECUTE|DBCC|PROCESS|REFRESH|DISCOVER)\b)",
        )
    });
    static CLAUSES: LazyLock<Regex> = LazyLock::new(|| {
        regex(
            r"(?i-u:\bORDER)[\t-\r \x{a0}\x{1680}\x{2000}-\x{200a}\x{2028}\x{2029}\x{202f}\x{205f}\x{3000}\x{feff}]+(?i-u:BY\b)|(?i-u:\bSTART)[\t-\r \x{a0}\x{1680}\x{2000}-\x{200a}\x{2028}\x{2029}\x{202f}\x{205f}\x{3000}\x{feff}]+(?i-u:AT\b)|(?i-u:\bINFO)[\t-\r \x{a0}\x{1680}\x{2000}-\x{200a}\x{2028}\x{2029}\x{202f}\x{205f}\x{3000}\x{feff}]*\.",
        )
    });
    if WORDS.is_match(&code) || CLAUSES.is_match(&code) {
        return Err(Error::new(
            "Only a scalar measure expression is allowed; query, declaration and administrative statements are blocked.",
        ));
    }
    static COMMENTS: LazyLock<Regex> = LazyLock::new(|| regex(r"/\*(?s:.*?)\*/|(?://|--)[^\r\n]*"));
    if trim(&COMMENTS.replace_all(s, "")).is_empty() {
        return Err(Error::new(
            "Measure expression cannot contain only comments.",
        ));
    }
    Ok(s.into())
}
pub fn data_type_parts(value: Option<&str>, kind: &str) -> Result<&'static str> {
    let lower = value
        .unwrap_or(if kind == "measure" { "number" } else { "text" })
        .to_lowercase();
    let raw = trim(
        lower
            .strip_prefix("system.")
            .unwrap_or(&lower)
            .split(',')
            .next()
            .unwrap_or(""),
    );
    match raw {
        "text" | "string" | "2" | "130" | "129" | "wchar" | "char" => Ok("text"),
        "int64" | "integer" | "int" | "long" | "whole number" | "6" | "bigint" => Ok("integer"),
        "number"
        | "numeric"
        | "double"
        | "decimal"
        | "currency"
        | "single"
        | "float"
        | "real"
        | "decimal number"
        | "fixed decimal number"
        | "8"
        | "10"
        | "5"
        | "14" => Ok("number"),
        "boolean" | "bool" | "11" => Ok("boolean"),
        "date" => Ok("date"),
        "datetime" | "date/time" | "9" | "7" | "datetime2" | "dbtimestamp" | "135" => {
            Ok("datetime")
        }
        _ => Err(Error::new(format!(
            "Unsupported filter data type: {}.",
            value.unwrap_or("undefined")
        ))),
    }
}
pub fn data_type(field: &Js) -> Result<&'static str> {
    if field.nullish() {
        return Err(Error::type_error(format!(
            "Cannot read properties of {} (reading 'dataType')",
            field.display()
        )));
    }
    let raw = field.get("dataType");
    if !raw.nullish() && raw.string().is_none() {
        return Err(Error::type_error(
            "(field.dataType ?? (intermediate value)(intermediate value)(intermediate value)).toLowerCase is not a function",
        ));
    }
    data_type_parts(raw.string(), field.get("kind").string().unwrap_or(""))
}
pub fn parameter(value: &Js) -> Result<String> {
    let s = trim(text(value, "Parameter name", 129, false)?);
    let name = s.strip_prefix('@').unwrap_or(s);
    static NAME: LazyLock<Regex> = LazyLock::new(|| regex(r"^[A-Za-z_][A-Za-z0-9_]{0,127}$"));
    if !NAME.is_match(name) || bad_key(name) {
        return Err(Error::new(
            "Parameter references require a single safe name, optionally prefixed with @.",
        ));
    }
    Ok(name.into())
}
pub fn has_parameters(builder: &Builder) -> bool {
    builder.filters.iter().any(|f| {
        f.enabled
            && !blank(&f.operator)
            && (f.is_parameter.unwrap_or(false)
                || (f.operator == "Between" && f.is_parameter2.unwrap_or(false)))
    })
}
pub fn collect_parameters(builder: &Builder) -> Result<Vec<String>> {
    let mut names = Vec::new();
    let mut seen = HashSet::new();
    for f in builder
        .filters
        .iter()
        .filter(|f| f.enabled && !blank(&f.operator))
    {
        if matches!(f.operator.as_str(), "In" | "NotIn")
            && (f.is_parameter.unwrap_or(false) || f.is_parameter2.unwrap_or(false))
        {
            return Err(Error::new(
                "In and NotIn filters do not support parameter mode.",
            ));
        }
        for (enabled, value) in [
            (f.is_parameter.unwrap_or(false), Some(&f.value)),
            (
                f.operator == "Between" && f.is_parameter2.unwrap_or(false),
                f.value2.as_ref(),
            ),
        ] {
            if enabled {
                let name = parameter(
                    &value
                        .map(|v| Js::String(v.clone()))
                        .unwrap_or(Js::Undefined),
                )?;
                if seen.insert(name.clone()) {
                    names.push(name);
                }
            }
        }
    }
    Ok(names)
}
pub fn literal(value: &Js, field: &Js) -> Result<String> {
    let s = text(value, "Filter value", 16384, true)?;
    literal_typed(s, data_type(field)?)
}
fn literal_typed(s: &str, ty: &str) -> Result<String> {
    if ty == "text" {
        return Ok(quote_string(s));
    }
    let s = trim(s);
    if ty == "integer" || ty == "number" {
        static INTEGER: LazyLock<Regex> = LazyLock::new(|| regex(r"^[+-]?[0-9]+$"));
        static NUMBER: LazyLock<Regex> = LazyLock::new(|| {
            regex(r"(?i-u:^[+-]?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:e[+-]?[0-9]+)?$)")
        });
        if !(if ty == "integer" {
            INTEGER.is_match(s)
        } else {
            NUMBER.is_match(s)
        }) || !s.parse::<f64>().is_ok_and(f64::is_finite)
        {
            return Err(Error::new(format!(
                "Filter requires a valid finite {ty} literal."
            )));
        }
        if ty == "integer" {
            let negative = s.starts_with('-');
            let digits = s.trim_start_matches(['+', '-']).trim_start_matches('0');
            let limit = if negative {
                "9223372036854775808"
            } else {
                "9223372036854775807"
            };
            if digits.len() > limit.len() || (digits.len() == limit.len() && digits > limit) {
                return Err(Error::new(
                    "Integer filter is outside the signed 64-bit range.",
                ));
            }
        }
        return Ok(s.into());
    }
    if ty == "boolean" {
        return match s.to_ascii_lowercase().as_str() {
            "true" | "1" => Ok("TRUE()".into()),
            "false" | "0" => Ok("FALSE()".into()),
            _ => Err(Error::new("Boolean filters require true, false, 1 or 0.")),
        };
    }
    static DATE: LazyLock<Regex> = LazyLock::new(|| {
        regex(
            r"^([0-9]{4})-([0-9]{2})-([0-9]{2})(?:[T ]([0-9]{2}):([0-9]{2}):([0-9]{2})(\.[0-9]{1,7})?)?$",
        )
    });
    let m = DATE.captures(s).filter(|m| ty != "date" || m.get(4).is_none())
        .ok_or_else(|| Error::new("Date filters require ISO YYYY-MM-DD; datetime may add HH:mm:ss without a timezone."))?;
    let n = |i| {
        m.get(i)
            .map(|v| v.as_str().parse::<u32>().unwrap())
            .unwrap_or(0)
    };
    let (year, month, day, hour, minute, second) = (n(1), n(2), n(3), n(4), n(5), n(6));
    let leap = year % 4 == 0 && (year % 100 != 0 || year % 400 == 0);
    let max_day = match month {
        4 | 6 | 9 | 11 => 30,
        2 => {
            if leap {
                29
            } else {
                28
            }
        }
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        _ => 0,
    };
    if !(1900..=9999).contains(&year)
        || day == 0
        || day > max_day
        || hour > 23
        || minute > 59
        || second > 59
    {
        return Err(Error::new("Invalid DAX date or datetime literal."));
    }
    let date = format!("DATE({year}, {month}, {day})");
    if m.get(4).is_none() {
        return Ok(date);
    }
    let fraction = m
        .get(7)
        .map(|v| format!(" + 0{} / 86400", v.as_str()))
        .unwrap_or_default();
    Ok(format!(
        "({date} + TIME({hour}, {minute}, {second}){fraction})"
    ))
}
fn list_literals(f: &Filter) -> Result<Vec<String>> {
    let value = f.value.replace('\r', "");
    let values: Vec<_> = value.split('\n').collect();
    if values.len() > 200 {
        return Err(Error::new(
            "A list filter supports at most 200 newline-separated values.",
        ));
    }
    values
        .into_iter()
        .map(|s| literal_typed(s, f.field.data_type()?))
        .collect()
}
fn filter_literal(f: &Filter, second: bool) -> Result<String> {
    let value = if second {
        f.value2.as_ref()
    } else {
        Some(&f.value)
    };
    let js = value
        .map(|v| Js::String(v.clone()))
        .unwrap_or(Js::Undefined);
    if (if second {
        f.is_parameter2
    } else {
        f.is_parameter
    })
    .unwrap_or(false)
    {
        Ok(format!("@{}", parameter(&js)?))
    } else {
        literal_typed(
            text(&js, "Filter value", 16384, true)?,
            f.field.data_type()?,
        )
    }
}
fn validate_filter(f: &Filter) -> Result<()> {
    let op = f.operator.as_str();
    if blank(op) {
        return Ok(());
    }
    if matches!(
        op,
        "StartsWith" | "DoesNotStartWith" | "Contains" | "DoesNotContain"
    ) && f.field.data_type()? != "text"
    {
        return Err(Error::new(format!("{op} requires a text field.")));
    }
    if matches!(
        op,
        "GreaterThan" | "GreaterThanOrEqual" | "LessThan" | "LessThanOrEqual" | "Between"
    ) && f.field.data_type()? == "text"
    {
        return Err(Error::new(format!(
            "{op} is not supported for text fields."
        )));
    }
    if matches!(op, "In" | "NotIn") {
        if !f.field.is_column() {
            return Err(Error::new(
                "In and NotIn filters are supported only for columns, not measures.",
            ));
        }
        if f.is_parameter.unwrap_or(false) || f.is_parameter2.unwrap_or(false) {
            return Err(Error::new(
                "In and NotIn filters do not support parameter mode.",
            ));
        }
    }
    Ok(())
}
fn predicate(f: &Filter, reference: &str) -> Result<String> {
    let op = f.operator.as_str();
    if op == "IsBlank" {
        return Ok(format!("ISBLANK({reference})"));
    }
    if op == "IsNotBlank" {
        return Ok(format!("NOT(ISBLANK({reference}))"));
    }
    if matches!(op, "In" | "NotIn") {
        let result = format!("{reference} IN {{{}}}", list_literals(f)?.join(", "));
        return Ok(if op == "NotIn" {
            format!("NOT({result})")
        } else {
            result
        });
    }
    let literal = filter_literal(f, false)?;
    let comparison = match op {
        "Is" => "=",
        "IsNot" => "<>",
        "GreaterThan" => ">",
        "GreaterThanOrEqual" => ">=",
        "LessThan" => "<",
        "LessThanOrEqual" => "<=",
        _ => "",
    };
    if !comparison.is_empty() {
        return Ok(format!("{reference} {comparison} {literal}"));
    }
    if op == "Between" {
        if f.value2.is_none() {
            return Err(Error::new("Between requires a second value."));
        }
        return Ok(format!(
            "{reference} >= {literal} && {reference} <= {}",
            filter_literal(f, true)?
        ));
    }
    let cmp = if matches!(op, "StartsWith" | "DoesNotStartWith") {
        "="
    } else {
        ">="
    };
    let result = format!("SEARCH({literal}, {reference}, 1, 0) {cmp} 1");
    Ok(if op.starts_with("DoesNot") {
        format!("NOT({result})")
    } else {
        result
    })
}
fn column_filter(f: &Filter) -> Result<String> {
    let reference = f.field.reference();
    if matches!(f.operator.as_str(), "Is" | "In") {
        let values = if f.operator == "In" {
            list_literals(f)?
        } else {
            vec![filter_literal(f, false)?]
        };
        return Ok(format!(
            "KEEPFILTERS(TREATAS({{{}}}, {reference}))",
            values.join(", ")
        ));
    }
    Ok(format!(
        "KEEPFILTERS(FILTER(ALL({reference}), {}))",
        predicate(f, &reference)?
    ))
}
pub fn all_fields(builder: &Builder) -> Result<Vec<Field>> {
    let mut result = builder.fields.clone();
    let mut refs: HashMap<_, _> = result
        .iter()
        .enumerate()
        .map(|(i, f)| (f.identity(), i))
        .collect();
    let mut ids: HashMap<_, _> = result.iter().map(|f| (f.id.clone(), f.clone())).collect();
    for f in builder
        .filters
        .iter()
        .filter(|f| f.enabled)
        .map(|f| &f.field)
    {
        let prior = refs
            .get(&f.identity())
            .map(|i| &result[*i])
            .or_else(|| ids.get(&f.id));
        if prior.is_some_and(|p| !p.same(f)) {
            return Err(Error::new("Conflicting field or measure definitions."));
        }
        let selected = prior.unwrap_or(f).clone();
        if let Some(i) = refs.get(&f.identity()) {
            result[*i] = selected;
        } else {
            refs.insert(f.identity(), result.len());
            result.push(selected);
        }
        ids.insert(f.id.clone(), f.clone());
    }
    Ok(result)
}
pub fn generate(input: &Js) -> Result<serde_json::Value> {
    let builder = normalize(input)?;
    if builder.fields.is_empty() {
        return Err(Error::new(
            "Select at least one column or measure before generating.",
        ));
    }
    let fields = all_fields(&builder)?;
    for f in &fields {
        if f.custom()
            && (f.table.is_none() || f.expression.as_deref().is_none_or(|s| trim(s).is_empty()))
        {
            return Err(Error::new(
                "Custom measures require a table and expression.",
            ));
        }
        if let Some(e) = &f.expression {
            expression(&Js::String(e.clone()))?;
        }
    }
    let definitions: Vec<_> = fields.iter().filter(|f| f.expression.is_some()).collect();
    let mut definition_names = HashSet::new();
    for f in &definitions {
        if !definition_names.insert(f.name.to_lowercase()) {
            return Err(Error::new("Duplicate query-scoped measure definitions."));
        }
    }
    let enabled: Vec<_> = builder.filters.iter().filter(|f| f.enabled).collect();
    for f in &enabled {
        validate_filter(f)?;
    }
    let columns: Vec<_> = builder.fields.iter().filter(|f| f.is_column()).collect();
    let measures: Vec<_> = fields.iter().filter(|f| !f.is_column()).collect();
    let mut output_names = HashMap::new();
    let mut used_names = HashSet::new();
    for f in &builder.fields {
        let mut name = f.caption.as_ref().unwrap_or(&f.name).clone();
        let duplicated = builder.fields.iter().any(|other| {
            other.id != f.id
                && other.caption.as_ref().unwrap_or(&other.name).to_lowercase()
                    == name.to_lowercase()
        });
        if duplicated && f.is_column() && f.caption.is_none() {
            name = format!("{}[{}]", f.table.as_deref().unwrap_or(""), f.name);
        }
        if !used_names.insert(name.to_lowercase()) {
            return Err(Error::new("Output captions must be unique."));
        }
        output_names.insert(f.id.clone(), name);
    }
    let mut native = true;
    let mut saw_measure = false;
    let mut owners = HashMap::new();
    for f in &builder.fields {
        if owners.insert(f.name.to_lowercase(), &f.id).is_some() {
            native = false;
        }
        if !f.is_column() {
            saw_measure = true;
        } else if saw_measure || output_names[&f.id] != f.name {
            native = false;
        }
    }
    for f in &builder.fields {
        if owners
            .get(&output_names[&f.id].to_lowercase())
            .is_some_and(|owner| **owner != f.id)
        {
            native = false;
        }
    }
    if measures.iter().any(|f| !output_names.contains_key(&f.id)) {
        native = false;
    }
    let mut reserved: HashSet<_> = fields
        .iter()
        .flat_map(|f| {
            [
                Some(f.name.to_lowercase()),
                f.caption.as_ref().map(|s| s.to_lowercase()),
            ]
        })
        .flatten()
        .collect();
    let mut alias_index = 0;
    let mut measure_names = HashMap::new();
    for f in &measures {
        let name = if native {
            output_names[&f.id].clone()
        } else {
            loop {
                let alias = format!("__qb_measure_{alias_index}");
                alias_index += 1;
                if reserved.insert(alias.clone()) {
                    break alias;
                }
            }
        };
        measure_names.insert(f.identity(), name);
    }
    let column_filters = enabled
        .iter()
        .filter(|f| f.field.is_column())
        .map(|f| column_filter(f))
        .collect::<Result<Vec<_>>>()?;
    let measure_args: Vec<_> = measures
        .iter()
        .map(|f| {
            format!(
                "{}, {}",
                quote_string(&measure_names[&f.identity()]),
                f.reference()
            )
        })
        .collect();
    let mut result = if !columns.is_empty() {
        let args: Vec<_> = columns
            .iter()
            .map(|f| f.reference())
            .chain(column_filters.iter().cloned())
            .chain(measure_args)
            .collect();
        format!("SUMMARIZECOLUMNS(\n    {}\n)", args.join(",\n    "))
    } else {
        let mut row = format!("ROW(\n    {}\n)", measure_args.join(",\n    "));
        if !column_filters.is_empty() {
            row = format!(
                "CALCULATETABLE(\n{row},\n    {}\n)",
                column_filters.join(",\n    ")
            );
        }
        row
    };
    let predicates = enabled
        .iter()
        .filter(|f| !f.field.is_column())
        .map(|f| predicate(f, &quote_object(&measure_names[&f.field.identity()])))
        .collect::<Result<Vec<_>>>()?;
    if !predicates.is_empty() {
        result = format!(
            "FILTER(\n{result},\n    {}\n)",
            predicates
                .iter()
                .map(|s| format!("({s})"))
                .collect::<Vec<_>>()
                .join(" &&\n    ")
        );
    }
    if !native {
        let projection: Vec<_> = builder
            .fields
            .iter()
            .map(|f| {
                format!(
                    "{}, {}",
                    quote_string(&output_names[&f.id]),
                    if f.is_column() {
                        f.reference()
                    } else {
                        quote_object(&measure_names[&f.identity()])
                    }
                )
            })
            .collect();
        result = format!(
            "SELECTCOLUMNS(\n{result},\n    {}\n)",
            projection.join(",\n    ")
        );
    }
    let prefix = if definitions.is_empty() {
        String::new()
    } else {
        format!(
            "DEFINE\n{}\n\n",
            definitions
                .iter()
                .map(|f| format!(
                    "    MEASURE {} = (\n{}\n    )",
                    f.reference(),
                    f.expression.as_deref().unwrap()
                ))
                .collect::<Vec<_>>()
                .join("\n")
        )
    };
    let refs: HashMap<_, _> = builder
        .fields
        .iter()
        .map(|f| {
            (
                &f.id,
                if native && f.is_column() {
                    f.reference()
                } else {
                    quote_object(&output_names[&f.id])
                },
            )
        })
        .collect();
    let order = if builder.order_by.is_empty() {
        String::new()
    } else {
        format!(
            "\nORDER BY\n    {}",
            builder
                .order_by
                .iter()
                .map(|o| format!("{} {}", refs[&o.field_id], o.direction))
                .collect::<Vec<_>>()
                .join(",\n    ")
        )
    };
    let query = format!("{START}\n{prefix}EVALUATE\n{result}{order}\n{END}");
    if utf8_bytes(&query) > 262144 {
        return Err(Error::coded(
            "Generated query exceeds the supported size limit.",
            "ARTIFACT_TOO_LARGE",
        ));
    }
    Ok(serde_json::json!({ "query": query, "builder": builder }))
}
