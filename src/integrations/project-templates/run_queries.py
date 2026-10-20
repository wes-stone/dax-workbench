"""Explicit DAX execution; importing this module never queries a model."""
import argparse
import datetime
import decimal
import json
import importlib.util
import os
from pathlib import Path
import re
import sys
import unicodedata
import urllib.request
import urllib.error

ROOT = Path(__file__).resolve().parent


def result_column_labels(columns):
    names = []
    for column in columns:
        match = re.fullmatch(r"(?:'(?:[^']|'')+'|[^\[\]']+)?\[((?:[^\]]|\]\])+)\]", column["name"])
        names.append(match.group(1).replace("]]", "]") if match else column["name"])
    counts = {}
    for name in names:
        counts[name.lower()] = counts.get(name.lower(), 0) + 1
    candidates = [column["name"] if counts[name.lower()] > 1 else name for column, name in zip(columns, names)]
    reserved, used, labels = {name.lower() for name in candidates}, set(), []
    for candidate in candidates:
        base = candidate or "Column"
        label, suffix = base, 2
        while label.lower() in used or label != candidate and label.lower() in reserved:
            label, suffix = f"{base} ({suffix})", suffix + 1
        used.add(label.lower())
        labels.append(label)
    return labels


def _table_cell(value):
    if value is None:
        return "null"
    if value == "":
        return '""'
    text = json.dumps(value) if isinstance(value, bool) else str(value)
    return "".join(
        "\\\\" if char == "\\" else char if char.isprintable() else char.encode("unicode_escape").decode("ascii")
        for char in text
    )


def _table_width(text):
    return sum(0 if unicodedata.combining(char) else 2 if unicodedata.east_asian_width(char) in ("W", "F") else 1
               for char in text)


def format_table(result):
    headers = [_table_cell(name) for name in result_column_labels(result["columns"])]
    rows = [[_table_cell(value) for value in row] for row in result["rows"]]
    if any(len(row) != len(headers) for row in rows):
        raise ValueError("Result row width does not match its columns.")
    lines = [f"{key.capitalize()}: {_table_cell(result[key])}" for key in ("mode", "notice") if result.get(key)]
    if lines:
        lines.append("")
    if headers:
        table = [headers, *rows]
        widths = [max(_table_width(row[index]) for row in table) for index in range(len(headers))]
        def line(row):
            return " | ".join(value + " " * (width - _table_width(value)) for value, width in zip(row, widths))
        lines.extend([line(headers), "-+-".join("-" * width for width in widths)])
        lines.extend(line(row) for row in rows)
    lines.append(f"Rows: {len(rows)}" + (" (truncated)" if result.get("truncated") else ""))
    return "\n".join(lines)


def project():
    return json.loads((ROOT / "project.json").read_text(encoding="utf-8"))

def parameter_values(query_id):
    item = next(entry for entry in project()["queries"] if entry["id"] == query_id)
    defaults = {name: value["default"] for name, value in item["parameters"].items() if "default" in value}
    return {**defaults, **json.loads((ROOT / "parameters.json").read_text(encoding="utf-8")).get(query_id, {})}


def _literal(value, definition):
    kind = definition["type"]
    if kind == "text":
        if value is None:
            value = ""
        elif isinstance(value, bool):
            value = "True" if value else "False"
        elif isinstance(value, (int, float)):
            value = str(value)
        if not isinstance(value, str):
            raise ValueError("Text parameters must be strings.")
        return '"' + value.replace('"', '""') + '"'
    if kind == "list[text]":
        if isinstance(value, str):
            value = [item.strip() for item in value.split(",") if item.strip()]
        if not isinstance(value, list) or len(value) > 1000 or any(not isinstance(item, str) for item in value):
            raise ValueError("List parameters require at most 1000 strings.")
        return "{" + ", ".join(_literal(item, {"type": "text"}) for item in value) + "}"
    if kind == "boolean":
        if isinstance(value, str):
            value = {"true": True, "1": True, "yes": True, "y": True, "false": False, "0": False, "no": False, "n": False}.get(value.strip().lower(), value)
        if not isinstance(value, bool):
            raise ValueError("Boolean parameters must be true or false.")
        return "TRUE()" if value else "FALSE()"
    if kind == "date":
        if not isinstance(value, str) or not re.fullmatch(r"\d{4}-\d{2}-\d{2}", value):
            raise ValueError("Dates must use YYYY-MM-DD.")
        date = datetime.date.fromisoformat(value)
        if not 1900 <= date.year <= 9999:
            raise ValueError("Date is outside the supported range.")
        return f"DATE({date.year}, {date.month}, {date.day})"
    if kind == "number":
        text = str(value).strip()
        if isinstance(value, bool) or not re.fullmatch(r"[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?", text):
            raise ValueError("Number parameters require finite decimal literals.")
        if not decimal.Decimal(text).is_finite():
            raise ValueError("Number parameters must be finite.")
        return text
    raise ValueError("Unsupported parameter type: " + str(kind))


def render_query(query, definitions, values):
    if not isinstance(values, dict) or len(values) > 100:
        raise ValueError("Parameters must be a bounded JSON object.")
    if set(values) - set(definitions):
        raise ValueError("Unknown template parameter.")
    for name, value in values.items():
        _literal(value, definitions[name])
    # Consume quoted identifiers, literals and comments before considering placeholders.
    tokens = re.compile(r'"(?:[^"]|"")*"|\'(?:[^\']|\'\')*\'|\[(?:[^\]]|\]\])*\]|//[^\r\n]*|--[^\r\n]*|/\*[\s\S]*?\*/|\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}')
    unmatched = tokens.sub("", query)
    if "{{" in unmatched or "}}" in unmatched:
        raise ValueError("Malformed or unsupported placeholder.")
    def replace(match):
        name = match.group(1)
        if name is None:
            if "{{" in match.group():
                raise ValueError("Placeholders must be literal tokens, not quoted text or comments.")
            return match.group()
        if (match.start() and re.match(r"[\w@]", query[match.start() - 1])) or (match.end() < len(query) and re.match(r"\w", query[match.end()])):
            raise ValueError("A placeholder must occupy a whole literal token.")
        if name not in definitions:
            raise ValueError("Undefined parameter: " + name)
        definition = definitions[name]
        value = values.get(name, definition.get("default"))
        if value is None and name not in values:
            if definition.get("required"):
                raise ValueError("Missing parameter: " + name)
            if definition["type"] == "text":
                value = ""
            elif definition["type"] == "list[text]":
                value = []
            else:
                raise ValueError("Missing parameter: " + name)
        allowed = definition.get("allowed_values")
        literal = _literal(value, definition)
        if allowed:
            kind = "text" if definition["type"] == "list[text]" else definition["type"]
            selected = (value if isinstance(value, list) else [item.strip() for item in value.split(",") if item.strip()]) if definition["type"] == "list[text]" else [value]
            def key(item):
                rendered = _literal(item, {"type": kind})
                return decimal.Decimal(rendered) if kind == "number" else rendered
            if any(key(item) not in [key(option) for option in allowed] for item in selected):
                raise ValueError("Parameter contains a disallowed value: " + name)
        return "(" + literal + ")" if literal.startswith("-") and match.start() and query[match.start()-1] == "-" else literal
    result = tokens.sub(replace, query)
    if len(result.encode("utf-8")) > 256 * 1024:
        raise ValueError("Rendered DAX exceeds 256 KiB.")
    return result


def _cell(value, kind=None, culture=None):
    if value is None or isinstance(value, (str, bool)):
        return value
    if kind == "System.Decimal":
        if isinstance(value, decimal.Decimal):
            return str(value)
        if hasattr(value, "ToString"):
            return str(value.ToString(culture))
        raise ValueError("The provider did not expose an exact decimal value.")
    if kind == "System.DateTime" and hasattr(value, "ToString"):
        return str(value.ToString("o", culture))
    if isinstance(value, (int, decimal.Decimal)):
        return str(value)
    if isinstance(value, (datetime.date, datetime.datetime)):
        return value.isoformat()
    if isinstance(value, float):
        import math
        if not math.isfinite(value):
            raise ValueError("The provider returned a nonfinite number.")
        return value
    return str(value)


def execute_query(query_id, values=None):
    item = next((entry for entry in project()["queries"] if entry["id"] == query_id), None)
    if item is None:
        raise ValueError("Choose a query ID from this project.")
    if values is None:
        values = parameter_values(query_id)
    bridge = os.environ.get("DAX_PROJECT_BRIDGE")
    token = os.environ.get("DAX_PROJECT_TOKEN")
    if bridge:
        if not token or not bridge.startswith("http://127.0.0.1:"):
            raise ValueError("Invalid managed project connection. Relaunch from Workbench.")
        request = urllib.request.Request(bridge + "/query", data=json.dumps({"queryId": query_id, "values": values}).encode(),
                                         headers={"Authorization": "Bearer " + token, "Content-Type": "application/json"}, method="POST")
        try:
            with urllib.request.urlopen(request, timeout=1900) as response:
                return json.load(response)
        except urllib.error.HTTPError as error:
            detail = json.loads(error.read().decode("utf-8")).get("error", {})
            raise RuntimeError(detail.get("message", "Managed query failed.")) from error
    if item.get("native_parameters"):
        raise ValueError("Independent execution does not bind native @parameters. Use Workbench or typed pack literals.")
    execution = item.get("execution")
    if execution is not None:
        if execution != {"kind": "contoso-retail", "version": 1} or item["parameters"]:
            raise ValueError("Unsupported offline source. Re-export a shipped Contoso recipe; no model was contacted.")
        # Load beside this runner even under Python -I, without changing global import paths.
        spec = importlib.util.spec_from_file_location("_contoso_fixture", ROOT / "contoso.py")
        fixture = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(fixture)
        return fixture.execute((ROOT / item["file"]).read_text(encoding="utf-8"), values)
    settings_path = ROOT / "connection.local.json"
    if not settings_path.is_file():
        raise ValueError("Configure connection.local.json and its connection-string environment variable before independent execution.")
    settings = json.loads(settings_path.read_text(encoding="utf-8"))["connections"][item["connection_name"]]
    connection = os.environ.get(settings["connection_string_env"])
    if not connection:
        raise ValueError("The configured connection-string environment variable is empty.")
    sys.path.insert(0, settings["adomd_directory"])
    from pyadomd import Pyadomd
    from Microsoft.AnalysisServices.AdomdClient import AdomdCommand
    from System.Globalization import CultureInfo
    query = (ROOT / item["file"]).read_text(encoding="utf-8")
    if item["parameters"]:
        query = render_query(query, item["parameters"], values)
    if not re.match(r"\s*(?:(?:--|//)[^\n]*\n|/\*[\s\S]*?\*/\s*)*(?:EVALUATE|DEFINE)\b", query, re.I):
        raise ValueError("Only a DAX read query is supported.")
    code = re.sub(r'"(?:[^"]|"")*"|\'(?:[^\']|\'\')*\'|\[(?:[^\]]|\]\])*\]|//[^\r\n]*|--[^\r\n]*|/\*[\s\S]*?\*/', " ", query)
    if ";" in code or re.search(r"\$SYSTEM|\bINFO\s*\.|\b(?:DBCC|ALTER|CREATE|DELETE|DROP|INSERT|UPDATE|EXEC|EXECUTE)\b", code, re.I):
        raise ValueError("Administrative and non-read statements are not supported.")
    rows, max_rows, max_bytes = [], 50000, 50 * 1024 * 1024
    size, truncated = 0, False
    with Pyadomd(connection) as client:
        command = AdomdCommand(query, client.conn)
        command.CommandTimeout = 120
        reader = None
        try:
            reader = command.ExecuteReader()
            columns = [{"id": "c" + str(i), "name": str(reader.GetName(i)), "dataType": str(reader.GetFieldType(i).FullName)}
                       for i in range(reader.FieldCount)]
            while reader.Read():
                # Pyadomd's cursor converts Decimal to float and empty strings to null.
                row = [None if reader.IsDBNull(i) else _cell(reader.GetValue(i), column["dataType"], CultureInfo.InvariantCulture)
                       for i, column in enumerate(columns)]
                encoded_size = len(json.dumps(row, ensure_ascii=False).encode("utf-8"))
                if len(rows) >= max_rows or size + encoded_size > max_bytes:
                    truncated = True
                    break
                rows.append(row)
                size += encoded_size
            if not truncated and reader.NextResult():
                raise ValueError("Independent projects require exactly one result table.")
        finally:
            if reader is not None:
                reader.Close()
            command.Dispose()
    return {"columns": columns, "rows": rows, "rowCount": len(rows), "truncated": truncated, "mode": "independent"}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Run one explicitly selected read query.")
    parser.add_argument("--query", help="Execute one query ID.")
    parser.add_argument("--list", action="store_true", help="List query IDs as JSON without executing.")
    parser.add_argument("--format", choices=("json", "table"), default="json",
                        help="Query output format (default: json). Table preserves exact values; --list always uses JSON.")
    args = parser.parse_args()
    if args.list:
        print(json.dumps([{"id": q["id"], "title": q["title"]} for q in project()["queries"]], indent=2))
    elif args.query:
        result = execute_query(args.query)
        print(format_table(result) if args.format == "table" else json.dumps(result, ensure_ascii=False))
    else:
        parser.error("Choose --query <id> or --list; no query was executed.")
