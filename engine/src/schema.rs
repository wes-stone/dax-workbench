use crate::compiler::*;
use crate::js::*;
use serde_json::Value;
use std::collections::HashMap;

struct NativeField {
    id: Js,
    kind: Js,
    name: Js,
    table: Js,
    data_type: Js,
}
pub struct Schema {
    objects: Vec<NativeField>,
    by_id: HashMap<String, usize>,
    by_name: HashMap<(String, String), Vec<usize>>,
    by_reference: HashMap<Identity, Vec<usize>>,
    tables: HashMap<String, usize>,
    measures: HashMap<String, usize>,
    search: Vec<String>,
    invalid_names: HashMap<String, (usize, Js)>,
    invalid_tables: HashMap<(String, String), (usize, Js)>,
}
fn property_error(v: &Js, property: &str) -> Error {
    Error::type_error(format!(
        "Cannot read properties of {} (reading '{property}')",
        v.display()
    ))
}
fn lower(v: &Js, expression: &str) -> Result<String> {
    if let Some(s) = v.string() {
        Ok(s.to_lowercase())
    } else if v.nullish() {
        Err(property_error(v, "toLowerCase"))
    } else {
        Err(Error::type_error(format!(
            "{expression}.toLowerCase is not a function"
        )))
    }
}
fn id_key(v: &Js) -> String {
    // Model identities are normally strings; preserve primitive Map-key distinctions.
    match v {
        Js::String(s) => format!("s:{s}"),
        Js::Number(n) => format!("n:{n}"),
        Js::Bool(b) => format!("b:{b}"),
        Js::Null => "null".into(),
        Js::Undefined => "undefined".into(),
        _ => "object".into(),
    }
}
impl Schema {
    pub fn new(objects: &Js) -> Result<Self> {
        let Js::Array(raw) = objects else {
            return Err(Error::schema("Loaded model schema is required."));
        };
        if raw.len() > 100000 {
            return Err(Error::schema("Loaded model schema is required."));
        }
        let mut fields = Vec::with_capacity(raw.len());
        for item in raw {
            if item.nullish() {
                return Err(property_error(item, "id"));
            }
            fields.push(NativeField {
                id: item.get("id").clone(),
                kind: item.get("kind").clone(),
                name: item.get("name").clone(),
                table: item.get("table").clone(),
                data_type: item.get("dataType").clone(),
            });
        }
        Ok(Self::from_fields(fields))
    }
    pub fn from_wire(rows: &Value) -> Result<Self> {
        let rows = rows
            .as_array()
            .filter(|r| r.len() <= 100000)
            .ok_or_else(|| Error::schema("Loaded model schema is required."))?;
        let mut fields = Vec::with_capacity(rows.len());
        for row in rows {
            let parts = row
                .as_array()
                .ok_or_else(|| Error::engine("Malformed schema row."))?;
            if parts.len() != 5 {
                let item = Js::wire(row)?;
                if item.nullish() {
                    return Err(property_error(&item, "id"));
                }
                return Err(Error::engine("Malformed schema row."));
            }
            let cell = |value: &Value| match value {
                Value::String(s) => Ok(Js::String(s.clone())),
                _ => Js::wire(value),
            };
            fields.push(NativeField {
                id: cell(&parts[0])?,
                kind: cell(&parts[1])?,
                name: cell(&parts[2])?,
                table: cell(&parts[3])?,
                data_type: cell(&parts[4])?,
            });
        }
        Ok(Self::from_fields(fields))
    }
    fn from_fields(fields: Vec<NativeField>) -> Self {
        let mut result = Self {
            objects: Vec::with_capacity(fields.len()),
            by_id: HashMap::with_capacity(fields.len()),
            by_name: HashMap::with_capacity(fields.len()),
            by_reference: HashMap::with_capacity(fields.len()),
            tables: HashMap::new(),
            measures: HashMap::new(),
            search: Vec::with_capacity(fields.len()),
            invalid_names: HashMap::new(),
            invalid_tables: HashMap::new(),
        };
        for (i, f) in fields.into_iter().enumerate() {
            result.by_id.insert(id_key(&f.id), i);
            result.search.push(
                format!(
                    "{} {}",
                    f.name.display(),
                    if f.table.nullish() {
                        String::new()
                    } else {
                        f.table.display()
                    }
                )
                .to_lowercase(),
            );
            if let Some(kind) = f.kind.string() {
                if let Some(name) = f.name.string() {
                    let name = name.to_lowercase();
                    result
                        .by_name
                        .entry((kind.into(), name.clone()))
                        .or_default()
                        .push(i);
                    if let Some(table) = f.table.string() {
                        result
                            .by_reference
                            .entry((kind.into(), table.to_lowercase(), name.clone()))
                            .or_default()
                            .push(i);
                    } else if !f.table.nullish() {
                        result
                            .invalid_tables
                            .entry((kind.into(), name.clone()))
                            .or_insert((i, f.table.clone()));
                    }
                    if kind == "table" {
                        result.tables.entry(name.clone()).or_insert(i);
                    }
                    if kind == "measure" {
                        result.measures.entry(name).or_insert(i);
                    }
                } else {
                    result
                        .invalid_names
                        .entry(kind.into())
                        .or_insert((i, f.name.clone()));
                }
            }
            result.objects.push(f);
        }
        result
    }
    pub fn search(&self, term: &Js, limit: usize) -> Result<Vec<usize>> {
        let Some(term) = term.string().filter(|s| units(s) <= 200) else {
            return Err(Error::coded(
                "Schema search is limited to 200 characters.",
                "INVALID_SEARCH",
            ));
        };
        let needle = term.to_lowercase();
        Ok(self
            .search
            .iter()
            .enumerate()
            .filter_map(|(i, s)| s.contains(&needle).then_some(i))
            .take(limit)
            .collect())
    }
    pub fn validate(&self, builder: Builder) -> Result<Builder> {
        let fields = all_fields(&builder)?;
        let mut resolved = HashMap::new();
        for field in fields {
            if field.custom() {
                if self
                    .by_id
                    .contains_key(&id_key(&Js::String(field.id.clone())))
                {
                    return Err(Error::schema(
                        "A custom measure cannot reuse an existing model object id.",
                    ));
                }
                let table = field
                    .table
                    .as_ref()
                    .and_then(|t| self.tables.get(&t.to_lowercase()));
                if field.table.is_some()
                    && let Some((position, bad)) = self.invalid_names.get("table")
                    && table.is_none_or(|found| position < found)
                {
                    lower(bad, "item.name")?;
                }
                if table.is_none() {
                    return Err(Error::schema(format!(
                        "Custom measure table is not in the loaded model: {}.",
                        field.table.as_deref().unwrap_or(&field.name)
                    )));
                }
                let measure = self.measures.get(&field.name.to_lowercase());
                if let Some((position, bad)) = self.invalid_names.get("measure")
                    && measure.is_none_or(|found| position < found)
                {
                    lower(bad, "item.name")?;
                }
                if measure.is_some() {
                    return Err(Error::schema(
                        "A new custom measure duplicates a model measure; use a measure override.",
                    ));
                }
                resolved.insert(field.identity(), field);
                continue;
            }
            let invalid_name = self
                .invalid_names
                .get(&field.kind)
                .map(|(i, v)| (*i, v, "item.name"));
            let invalid_table = field
                .table
                .as_ref()
                .and_then(|_| {
                    self.invalid_tables
                        .get(&(field.kind.clone(), field.name.to_lowercase()))
                })
                .map(|(i, v)| (*i, v, "item.table?"));
            if let Some((_, value, expression)) = invalid_name
                .into_iter()
                .chain(invalid_table)
                .min_by_key(|(i, _, _)| *i)
            {
                lower(value, expression)?;
            }
            let matches = if field.table.is_some() {
                self.by_reference.get(&field.identity())
            } else {
                self.by_name
                    .get(&(field.kind.clone(), field.name.to_lowercase()))
            };
            let found = self
                .by_id
                .get(&id_key(&Js::String(field.id.clone())))
                .copied()
                .or_else(|| matches.filter(|m| m.len() == 1).map(|m| m[0]));
            let matched = found.map(|i| &self.objects[i]);
            let valid = if let Some(m) = matched {
                m.kind.string() == Some(field.kind.as_str())
                    && lower(&m.name, "match.name")? == field.name.to_lowercase()
                    && (field.table.is_none()
                        || (!m.table.nullish()
                            && lower(&m.table, "match.table")?
                                == field.table.as_deref().unwrap().to_lowercase()))
            } else {
                false
            };
            if !valid {
                return Err(Error::schema(format!(
                    "Builder field is absent or ambiguous in the loaded model: {}.",
                    field.name
                )));
            }
            let matched = matched.unwrap();
            if matched.data_type.truthy() && field.expression.is_none() {
                let literal_use = |f: &Filter| {
                    !blank(&f.operator)
                        && (!f.is_parameter.unwrap_or(false)
                            || (f.operator == "Between" && !f.is_parameter2.unwrap_or(false)))
                };
                let selected = builder
                    .fields
                    .iter()
                    .any(|f| f.identity() == field.identity());
                let first_uses_literal = !selected
                    && builder
                        .filters
                        .iter()
                        .find(|f| f.enabled && f.field.identity() == field.identity())
                        .is_some_and(literal_use);
                let references = std::iter::once((&field, first_uses_literal)).chain(
                    builder
                        .filters
                        .iter()
                        .filter(|f| f.enabled && f.field.identity() == field.identity())
                        .map(|f| (&f.field, literal_use(f))),
                );
                for (reference, uses_literal) in references {
                    let Some(declared) = &reference.data_type else {
                        continue;
                    };
                    let native = matched
                        .data_type
                        .string()
                        .map(|ty| data_type_parts(Some(ty), &field.kind))
                        .unwrap_or_else(|| Err(Error::new("Unsupported native type.")));
                    match (native, reference.data_type()) {
                        (Ok(native), Ok(declared)) if native != declared => {
                            return Err(Error::schema(format!(
                                "Builder field data type does not match the loaded model: {}. Refresh its field metadata before generating.",
                                field.name
                            )));
                        }
                        (Ok(_), Ok(_)) => {}
                        _ => {
                            if uses_literal
                                || declared.to_lowercase()
                                    != lower(&matched.data_type, "match.dataType")?
                            {
                                return Err(Error::schema(format!(
                                    "Builder field has an unsupported or conflicting data type: {}.",
                                    field.name
                                )));
                            }
                        }
                    }
                }
            }
            let mut rebound = field.clone();
            rebound.id = identifier(&matched.id, "Field id", 1024)?;
            if matched.table.truthy() {
                rebound.table = Some(identifier(&matched.table, "Table name", 256)?);
            }
            if matched.data_type.truthy()
                && !(field.expression.is_some() && field.data_type.is_some())
            {
                rebound.data_type = Some(identifier(&matched.data_type, "Data type", 80)?);
            }
            resolved.insert(field.identity(), rebound);
        }
        let updated = |f: &Field| {
            resolved
                .get(&f.identity())
                .cloned()
                .unwrap_or_else(|| f.clone())
        };
        let mut result = builder.clone();
        result.fields = builder.fields.iter().map(updated).collect();
        result.filters = builder
            .filters
            .iter()
            .map(|f| Filter {
                field: updated(&f.field),
                ..f.clone()
            })
            .collect();
        result.order_by = builder
            .order_by
            .iter()
            .map(|o| Order {
                field_id: updated(builder.fields.iter().find(|f| f.id == o.field_id).unwrap()).id,
                direction: o.direction.clone(),
            })
            .collect();
        normalize(&Js::from_json(json(result)))
    }
}
