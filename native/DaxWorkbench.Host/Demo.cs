namespace DaxWorkbench.Host;

public static class Demo
{
    public const string Limitation = "Synthetic Contoso supports four fixed recipes: raw sales, monthly performance, December product snapshot and annual revenue ranking, without parameters. Open a shipped Contoso starter; arbitrary DAX is not evaluated.";
    public const string MonthlyQuery = """
        EVALUATE
        SUMMARIZECOLUMNS(
            'Demo Sales'[Month],
            "Total Revenue", 'Demo Sales'[Total Revenue],
            "Units Sold", 'Demo Sales'[Units Sold]
        )
        ORDER BY 'Demo Sales'[Month] ASC
        """;
    public const string DecemberQuery = """
        EVALUATE
        SUMMARIZECOLUMNS(
            'Demo Sales'[Product],
            KEEPFILTERS(TREATAS({DATE(2025, 12, 1)}, 'Demo Sales'[Month])),
            "Total Revenue", 'Demo Sales'[Total Revenue],
            "Units Sold", 'Demo Sales'[Units Sold]
        )
        ORDER BY [Total Revenue] DESC
        """;
    public const string RankingQuery = """
        EVALUATE
        SUMMARIZECOLUMNS(
            'Demo Sales'[Product],
            "Total Revenue", 'Demo Sales'[Total Revenue]
        )
        ORDER BY [Total Revenue] DESC
        """;

    public static readonly List<Column> Columns =
    [
        new("column-0", "Month", "DateTime"), new("column-1", "Product", "String"),
        new("column-2", "Revenue", "Decimal", "$#,0.00"), new("column-3", "Units", "Int64", "#,0")
    ];
    public sealed record Result(List<Column> Columns, IEnumerable<object?[]> Rows);
    private sealed record Sale(DateTime Month, string Product, decimal Revenue, long Units);
    private sealed record Recipe(string Query, List<Column> Columns, Func<IEnumerable<object?[]>> Rows)
    {
        public List<ReadOnlyDax.Token> Tokens { get; } = ReadOnlyDax.Validate(Query);
    }
    private static List<Column> SummaryColumns(string dimension, string type, bool units) =>
    [
        new("column-0", $"Demo Sales[{dimension}]", type),
        new("column-1", "[Total Revenue]", "Decimal", "$#,0.00"),
        ..(units ? new[] { new Column("column-2", "[Units Sold]", "Int64", "#,0") } : [])
    ];
    private static readonly Recipe[] Recipes =
    [
        new(MonthlyQuery, SummaryColumns("Month", "DateTime", true), Monthly),
        new(DecemberQuery, SummaryColumns("Product", "String", true), December),
        new(RankingQuery, SummaryColumns("Product", "String", false), Ranking)
    ];
    public static ModelSchema Schema() => new(ConnectionRegistry.DemoId,
    [
        new("demo-table", "Demo Sales", "table", Description: "Invented retail sales of Desks, Chairs and Lamps, not a live model."),
        ..Columns.Select(c => new ModelObject("demo-" + c.Id, c.Name, "column", "Demo Sales", c.DataType)),
        new("demo-measure-revenue", "Total Revenue", "measure", "Demo Sales", "Decimal",
            "SUM('Demo Sales'[Revenue])", "Sum of illustrative revenue in the supported recipe's scope.", FormatString: "$#,0.00"),
        new("demo-measure-units", "Units Sold", "measure", "Demo Sales", "Int64",
            "SUM('Demo Sales'[Units])", "Physical items sold. Additive across products and months; not a customer count.", FormatString: "#,0")
    ], DateTimeOffset.UtcNow.ToString("O"), [Limitation]);

    public static Result Execute(List<ReadOnlyDax.Token> tokens)
    {
        if (ReadOnlyDax.IsDemo(tokens)) return new(Columns, Rows());
        foreach (var recipe in Recipes)
        {
            // Match the complete token stream, including literal spelling and token kind.
            // Substring matching could silently return a recipe after its semantics changed.
            if (tokens.Count == recipe.Tokens.Count && tokens.Zip(recipe.Tokens).All(pair =>
                pair.First.Kind == pair.Second.Kind && string.Equals(pair.First.Text, pair.Second.Text,
                    pair.First.Kind == "string" ? StringComparison.Ordinal : StringComparison.OrdinalIgnoreCase)))
                return new(recipe.Columns, recipe.Rows());
        }
        throw new HostError("UNSUPPORTED_DEMO_QUERY", Limitation);
    }
    private static IEnumerable<Sale> Sales()
    {
        string[] products = ["Desks", "Chairs", "Lamps"];
        for (var month = 1; month <= 12; month++)
            for (var product = 0; product < products.Length; product++)
                yield return new(new DateTime(2025, month, 1), products[product],
                    10000.00m + month * 1250.25m + product * 4321.10m, 100L + month * 11 + product * 47);
    }
    public static IEnumerable<object?[]> Rows() => Sales().Select(row => new object?[]
    {
        CellEncoding.Encode(row.Month), row.Product, CellEncoding.Encode(row.Revenue), CellEncoding.Encode(row.Units)
    });
    private static IEnumerable<object?[]> Monthly() => Sales().GroupBy(row => row.Month).OrderBy(group => group.Key)
        .Select(group => new object?[] { CellEncoding.Encode(group.Key), CellEncoding.Encode(group.Sum(row => row.Revenue)),
            CellEncoding.Encode(group.Sum(row => row.Units)) });
    private static IEnumerable<object?[]> December() => Sales().Where(row => row.Month == new DateTime(2025, 12, 1))
        .OrderByDescending(row => row.Revenue).Select(row => new object?[]
        { row.Product, CellEncoding.Encode(row.Revenue), CellEncoding.Encode(row.Units) });
    private static IEnumerable<object?[]> Ranking() => Sales().GroupBy(row => row.Product)
        .OrderByDescending(group => group.Sum(row => row.Revenue))
        .Select(group => new object?[] { group.Key, CellEncoding.Encode(group.Sum(row => row.Revenue)) });
}
