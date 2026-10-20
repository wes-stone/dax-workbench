using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace DaxWorkbench.Host;

public sealed class HostError(string code, string message) : Exception(message)
{
    public string Code { get; } = code;
    public object Safe => new { code = Code, message = Message };
}

public static class Json
{
    public const int MaxLineBytes = 2 * 1024 * 1024;
    public static readonly JsonSerializerOptions Options = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        MaxDepth = 64
    };
    public static byte[] Bytes(object value) => JsonSerializer.SerializeToUtf8Bytes(value, Options);
    public static JsonElement Element(object value) => JsonSerializer.SerializeToElement(value, Options);
    public static string Required(this JsonElement element, string name, int max = 4096)
    {
        if (!element.TryGetProperty(name, out var value) || value.ValueKind != JsonValueKind.String ||
            value.GetString() is not { Length: > 0 } text || text.Length > max)
            throw new HostError("INVALID_PARAMS", $"A valid {name} is required.");
        return text;
    }
    public static int Integer(this JsonElement element, string name, int fallback, int minimum, int maximum)
    {
        if (!element.TryGetProperty(name, out var value)) return fallback;
        if (value.ValueKind != JsonValueKind.Number || !value.TryGetInt32(out var number) || number < minimum || number > maximum)
            throw new HostError("INVALID_PARAMS", $"{name} is outside the supported range.");
        return number;
    }
}

public sealed class ProtocolWriter(Stream stream)
{
    private readonly object gate = new();
    public void Write(object message) => Write(Json.Bytes(message));
    public void Write(byte[] bytes)
    {
        if (bytes.Length > Json.MaxLineBytes)
            throw new HostError("MESSAGE_TOO_LARGE", "The protocol message exceeds 2 MiB.");
        lock (gate)
        {
            stream.Write(bytes);
            stream.WriteByte((byte)'\n');
            stream.Flush();
        }
    }
}

// Count bytes before decoding or allocating a JSON document. Drain an oversized
// line so subsequent requests remain aligned without unbounded ReadLine storage.
public sealed class BoundedLines(Stream stream)
{
    private readonly byte[] buffer = new byte[8192];
    private int position;
    private int available;
    public async Task<byte[]?> ReadAsync(CancellationToken token = default)
    {
        using var line = new MemoryStream();
        var oversized = false;
        while (true)
        {
            if (position == available)
            {
                available = await stream.ReadAsync(buffer, token);
                position = 0;
                if (available == 0)
                {
                    if (oversized) throw TooLarge();
                    return line.Length == 0 ? null : line.ToArray();
                }
            }
            var value = buffer[position++];
            if (value == '\n')
            {
                if (oversized) throw TooLarge();
                var result = line.ToArray();
                return result.Length > 0 && result[^1] == '\r' ? result[..^1] : result;
            }
            if (line.Length == Json.MaxLineBytes) oversized = true;
            if (!oversized) line.WriteByte(value);
        }
    }
    private static HostError TooLarge() => new("MESSAGE_TOO_LARGE", "Request exceeds the 2 MiB protocol limit.");
}

public sealed record Column(string Id, string Name, string DataType,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] string? FormatString = null);
public sealed record Capability(string Status, string Reason);
public sealed record ConnectionDescriptor(string Id, string Name, string Kind,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] string? Model,
    Dictionary<string, Capability> Capabilities, string AuthMode = "connection-string");
public sealed record ModelObject(string Id, string Name, string Kind,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] string? Table = null,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] string? DataType = null,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] string? Expression = null,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] string? Description = null,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] string? QualifiedName = null,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] string? NativeDataType = null,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] bool? IsHidden = null,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] string? DisplayFolder = null,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] string? FormatString = null,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] string? Source = null,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] string? MeasureGroup = null,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] string? SortByColumnId = null);
public sealed record ModelRelationship(string Id, string FromTable, string FromColumn, string ToTable, string ToColumn,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] string? Name = null,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] bool? IsActive = null,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] string? FromCardinality = null,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] string? ToCardinality = null,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] string? CrossFilteringBehavior = null,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] string? Source = null);
public sealed record ModelSchema(string ConnectionId, List<ModelObject> Objects, string FetchedAt, List<string> Warnings,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] List<ModelRelationship>? Relationships = null,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] Dictionary<string, object>? Coverage = null,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] List<ModelHierarchy>? Hierarchies = null);
public sealed record ModelHierarchyLevel(string Id, string Name, int Ordinal, string ColumnId);
public sealed record ModelHierarchy(string Id, string Name, string Table, List<ModelHierarchyLevel> Levels,
    string Kind = "hierarchy",
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] string? QualifiedName = null,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] bool? IsHidden = null,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] string? DisplayFolder = null,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] string? Description = null,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] string? Source = null);
public sealed class ResultSet
{
    public required string Id { get; init; }
    public required List<Column> Columns { get; init; }
    public int RowCount { get; set; }
    public bool Truncated { get; set; }
}
public sealed class QueryResult
{
    public required string RunId { get; init; }
    public string Status { get; set; } = "completed";
    public List<ResultSet> ResultSets { get; } = [];
    public int RowCount { get; set; }
    public long DurationMs { get; set; }
    public bool Truncated { get; set; }
    public bool UnreadResultSets { get; set; }
    public List<string> Warnings { get; } = [];
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public object? Error { get; set; }
}
