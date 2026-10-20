"""Offline retail fixture for four explicit Contoso recipes, not a DAX engine."""
from decimal import Decimal
import re


RECIPES = {
    "sales": "EVALUATE 'Demo Sales'",
    "monthly": """EVALUATE SUMMARIZECOLUMNS(
        'Demo Sales'[Month],
        "Total Revenue", 'Demo Sales'[Total Revenue],
        "Units Sold", 'Demo Sales'[Units Sold]
    ) ORDER BY 'Demo Sales'[Month] ASC""",
    "december": """EVALUATE SUMMARIZECOLUMNS(
        'Demo Sales'[Product],
        KEEPFILTERS(TREATAS({DATE(2025, 12, 1)}, 'Demo Sales'[Month])),
        "Total Revenue", 'Demo Sales'[Total Revenue],
        "Units Sold", 'Demo Sales'[Units Sold]
    ) ORDER BY [Total Revenue] DESC""",
    "ranking": """EVALUATE SUMMARIZECOLUMNS(
        'Demo Sales'[Product],
        "Total Revenue", 'Demo Sales'[Total Revenue]
    ) ORDER BY [Total Revenue] DESC""",
}
LIMITATION = (
    "Offline Contoso supports only the four shipped retail recipes, without parameters. "
    "Restore a shipped sample query, or export from your own model for arbitrary DAX. "
    "No model was contacted."
)
_TOKEN = re.compile(
    r'(?P<skip>\s+|--[^\r\n]*|//[^\r\n]*|/\*[\s\S]*?\*/)'
    r'|(?P<string>"(?:[^"]|"")*")'
    r"|(?P<table>'(?:[^']|'')*')"
    r"|\[(?:[^\]]|\]\])*\]|[A-Za-z_][A-Za-z0-9_]*|\d+|[(),{}]"
)


def _tokens(query):
    result, position = [], 0
    for token in _TOKEN.finditer(query):
        if token.start() != position:
            raise ValueError(LIMITATION)
        position = token.end()
        if token.lastgroup != "skip":
            result.append(token.group() if token.lastgroup == "string" else token.group().lower())
    if position != len(query):
        raise ValueError(LIMITATION)
    return result


def _sales():
    for month in range(1, 13):
        for index, product in enumerate(("Desks", "Chairs", "Lamps")):
            yield (
                f"2025-{month:02d}-01T00:00:00.0000000", product,
                Decimal("10000.00") + month * Decimal("1250.25") + index * Decimal("4321.10"),
                100 + month * 11 + index * 47,
            )


def execute(query, values):
    if not isinstance(values, dict) or values:
        raise ValueError(LIMITATION)
    tokens = _tokens(query)
    recipe = next((name for name, dax in RECIPES.items() if tokens == _tokens(dax)), None)
    if recipe is None:
        raise ValueError(LIMITATION)
    sales = list(_sales())
    if recipe == "sales":
        fields = [("Month", "DateTime"), ("Product", "String"), ("Revenue", "Decimal"), ("Units", "Int64")]
        rows = sales
    else:
        monthly = recipe == "monthly"
        fields = [("Demo Sales[Month]" if monthly else "Demo Sales[Product]", "DateTime" if monthly else "String"),
                  ("[Total Revenue]", "Decimal")]
        if recipe != "ranking":
            fields.append(("[Units Sold]", "Int64"))
        if recipe == "december":
            rows = [(product, revenue, units) for month, product, revenue, units in sales if month.startswith("2025-12-")]
        else:
            groups = {}
            for month, product, revenue, units in sales:
                key = month if monthly else product
                totals = groups.setdefault(key, [Decimal("0.00"), 0])
                totals[0] += revenue
                totals[1] += units
            rows = [(key, *totals) if monthly else (key, totals[0]) for key, totals in groups.items()]
        rows.sort(key=lambda row: row[0] if monthly else row[1], reverse=not monthly)
    columns = [{"id": f"column-{index}", "name": name, "dataType": kind} for index, (name, kind) in enumerate(fields)]
    encoded = [[format(value, ".2f") if isinstance(value, Decimal) else str(value) if isinstance(value, int) else value
                for value in row] for row in rows]
    return {"columns": columns, "rows": encoded, "rowCount": len(encoded), "truncated": False,
            "mode": "synthetic", "source": "Contoso retail fixture v1", "recipe": recipe,
            "notice": "Invented Desks, Chairs and Lamps sales in 2025. Revenue is illustrative USD; units are physical items. No model connection."}
