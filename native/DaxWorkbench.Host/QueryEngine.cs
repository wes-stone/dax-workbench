using System.Data;
using System.Diagnostics;
using System.Globalization;
using System.Text.Json;
using Microsoft.AnalysisServices.AdomdClient;

namespace DaxWorkbench.Host;

public sealed class ResultEmitter(QueryResult result, ProtocolWriter writer, int maxRows, int maxBytes, CancellationToken token)
{
    private ResultSet? current;
    private readonly List<object?[]> chunk = [];
    private int chunkBytes;
    private long totalBytes;
    public void Begin(List<Column> columns)
    {
        Flush();
        token.ThrowIfCancellationRequested();
        if (columns.Count > 1024) throw new HostError("SCHEMA_TOO_LARGE", "Result sets support at most 1024 columns.");
        if (result.ResultSets.Count >= 64) throw new HostError("RESULTSET_LIMIT", "At most 64 result sets are supported.");
        current = new ResultSet { Id = $"result-{result.ResultSets.Count}", Columns = columns };
        writer.Write(new { @event = "query.resultset", runId = result.RunId, resultSetId = current.Id, columns });
        result.ResultSets.Add(current);
    }
    public bool Add(object?[] row)
    {
        token.ThrowIfCancellationRequested();
        foreach (var cell in row)
            if (Json.Bytes(cell!).Length > Json.MaxLineBytes - 8192)
                throw new HostError("CELL_TOO_LARGE", "A single result cell exceeds the protocol limit.");
        var rowBytes = Json.Bytes(row).Length + 1;
        if (rowBytes > Json.MaxLineBytes - 8192)
            throw new HostError("ROW_TOO_LARGE", "A single result row exceeds the protocol limit.");
        if (result.RowCount >= maxRows || totalBytes + rowBytes > maxBytes)
        {
            result.Truncated = true;
            result.UnreadResultSets = true;
            current!.Truncated = true;
            result.Warnings.Add(result.RowCount >= maxRows ? "The total row limit was reached." : "The total serialized-row byte limit was reached.");
            Flush();
            return false;
        }
        if (chunk.Count != 0 && chunkBytes + rowBytes > 128 * 1024) Flush();
        chunk.Add(row);
        chunkBytes += rowBytes;
        totalBytes += rowBytes;
        current!.RowCount++;
        result.RowCount++;
        if (chunk.Count >= 128 || chunkBytes >= 128 * 1024) Flush();
        return true;
    }
    public void Flush()
    {
        if (chunk.Count == 0) return;
        writer.Write(new
        {
            @event = "query.rows", runId = result.RunId, resultSetId = current!.Id,
            offset = current.RowCount - chunk.Count, rows = chunk
        });
        chunk.Clear(); chunkBytes = 0;
    }
}

public static class CellEncoding
{
    public static string TypeName(Type type) =>
        type == typeof(long) || type == typeof(ulong) ? "Int64" :
        type == typeof(decimal) ? "Decimal" :
        type == typeof(DateTime) || type == typeof(DateTimeOffset) ? "DateTime" :
        type == typeof(bool) ? "Boolean" :
        type == typeof(string) || type == typeof(char) || type == typeof(Guid) ? "String" :
        type == typeof(byte[]) ? "Binary" :
        type == typeof(float) || type == typeof(double) ? "Double" :
        type == typeof(int) || type == typeof(short) || type == typeof(byte) ||
        type == typeof(uint) || type == typeof(ushort) || type == typeof(sbyte) ? "Int32" : "Variant";
    public static object? Encode(object? value) => value switch
    {
        null or DBNull => null,
        long n => n.ToString(CultureInfo.InvariantCulture),
        ulong n => n.ToString(CultureInfo.InvariantCulture),
        decimal n => n.ToString(CultureInfo.InvariantCulture),
        DateTime date => date.ToString("O", CultureInfo.InvariantCulture),
        DateTimeOffset date => date.ToString("O", CultureInfo.InvariantCulture),
        byte[] bytes => Convert.ToBase64String(bytes),
        Guid guid => guid.ToString("D"),
        char c => c.ToString(),
        string or bool or int or short or sbyte or byte or ushort or uint => value,
        double d when double.IsFinite(d) => d,
        float f when float.IsFinite(f) => f,
        _ => throw new HostError("UNSUPPORTED_CELL", "A result value cannot be represented safely by protocol v1.")
    };
}

public static class QueryEngine
{
    public static QueryResult Run(JsonElement request, string? connectionString, ProtocolWriter writer, CancellationToken token)
        => Run(request, connectionString, writer, token, null);

    internal static QueryResult Run(JsonElement request, string? connectionString, ProtocolWriter writer, CancellationToken token, PowerBiRestTransport? restTransport)
    {
        var runId = request.Required("runId", 128);
        var connectionId = request.Required("connectionId", 256);
        var query = request.Required("query", 1_500_000);
        var result = new QueryResult { RunId = runId };
        var rest = connectionId != ConnectionRegistry.DemoId && NativeConnections.IsPowerBiRest(connectionString);
        if (rest) PowerBiRest.AddWarnings(result);
        var timer = Stopwatch.StartNew();
        var phase = "query preparation";
        var emitter = new ResultEmitter(result, writer,
            request.Integer("maxRows", 10000, 1, 100000),
            request.Integer("maxBytes", 8 * 1024 * 1024, 1, 100 * 1024 * 1024), token);
        try
        {
            var tokens = ReadOnlyDax.Validate(query);
            var parameters = ReadOnlyDax.Parameters(request);
            writer.Write(new { @event = "query.progress", runId, status = "connecting" });
            token.ThrowIfCancellationRequested();
            if (connectionId == ConnectionRegistry.DemoId)
            {
                if (parameters.Count != 0) throw new HostError("UNSUPPORTED_DEMO_QUERY", Demo.Limitation);
                var demo = Demo.Execute(tokens);
                writer.Write(new { @event = "query.progress", runId, status = "executing" });
                emitter.Begin(demo.Columns);
                writer.Write(new { @event = "query.progress", runId, status = "streaming" });
                foreach (var row in demo.Rows) if (!emitter.Add(row)) break;
            }
            else if (rest)
            {
                PowerBiRest.RunAsync(request, PowerBiRestProfile.Read(connectionString!), result, emitter, writer, token, restTransport).GetAwaiter().GetResult();
            }
            else
            {
                phase = "opening connection";
                using var connection = NativeConnections.Open(connectionString, token);
                token.ThrowIfCancellationRequested();
                using var command = connection.CreateCommand();
                command.CommandText = query;
                command.CommandTimeout = request.Integer("timeoutSeconds", 30, 1, 600);
                foreach (var parameter in parameters)
                    command.Parameters.Add(new AdomdParameter(parameter.Key, parameter.Value ?? DBNull.Value));
                // Cancellation runs on the independent worker control reader, never
                // on the thread blocked inside ADOMD ExecuteReader/Read/NextResult.
                using var cancellation = token.Register(() =>
                {
                    try { command.Cancel(); } catch { }
                });
                writer.Write(new { @event = "query.progress", runId, status = "executing" });
                phase = "query execution";
                using var reader = command.ExecuteReader();
                phase = "result reading";
                var stopped = false;
                do
                {
                    token.ThrowIfCancellationRequested();
                    var columns = new List<Column>();
                    for (var i = 0; i < reader.FieldCount; i++)
                        columns.Add(new($"column-{i}", reader.GetName(i), CellEncoding.TypeName(reader.GetFieldType(i))));
                    emitter.Begin(columns);
                    writer.Write(new { @event = "query.progress", runId, status = "streaming" });
                    while (reader.Read())
                    {
                        token.ThrowIfCancellationRequested();
                        var row = new object?[reader.FieldCount];
                        for (var i = 0; i < row.Length; i++) row[i] = reader.IsDBNull(i) ? null : CellEncoding.Encode(reader.GetValue(i));
                        if (!emitter.Add(row)) { stopped = true; break; }
                    }
                    emitter.Flush();
                    if (stopped)
                    {
                        try { command.Cancel(); } catch { }
                        break;
                    }
                } while (reader.NextResult());
            }
            emitter.Flush();
        }
        catch (OperationCanceledException)
        {
            result.Status = "cancelled";
            result.UnreadResultSets = true;
            result.Error = new HostError("CANCELLED", "The query was cancelled.").Safe;
        }
        catch (HostError error)
        {
            result.Status = error.Code is "REST_TIMEOUT" or "REST_AZURE_CLI_TIMEOUT" or "AZURE_CLI_TIMEOUT" ? "timed-out" : "failed";
            result.UnreadResultSets = rest || result.ResultSets.Count > 0;
            if (rest && error.Code is "REST_QUERY_ERROR" or "REST_SERVICE_LIMIT" or "REST_RESPONSE_TOO_LARGE" or "REST_RESULT_SHAPE_UNSUPPORTED")
            {
                result.Truncated = true;
                result.Warnings.Add("The REST response was discarded because completeness could not be established; no response rows were emitted.");
            }
            result.Error = error.Safe;
        }
        catch (Exception error)
        {
            result.Status = token.IsCancellationRequested ? "cancelled" : "failed";
            result.UnreadResultSets = true;
            result.Error = token.IsCancellationRequested ? new HostError("CANCELLED", "The query was cancelled.").Safe
                : rest ? new HostError("REST_EXECUTION_FAILED", "The Power BI REST operation failed. No provider details or response values are included; no XMLA fallback was attempted.").Safe
                : ProviderErrors.Map(error, phase).Safe;
        }
        finally
        {
            emitter.Flush();
            result.DurationMs = timer.ElapsedMilliseconds;
        }
        return result;
    }
}

public static class NativeSchema
{
    public static ModelSchema Read(string connectionId, string? connectionString, CancellationToken cancellationToken = default)
    {
        if (connectionId == ConnectionRegistry.DemoId) return Demo.Schema();
        if (NativeConnections.IsPowerBiRest(connectionString))
        {
            PowerBiRestProfile.Read(connectionString!);
            cancellationToken.ThrowIfCancellationRequested();
            return new(connectionId, [], DateTimeOffset.UtcNow.ToString("O"), [PowerBiRest.SchemaWarning]);
        }
        using var connection = NativeConnections.Open(connectionString, cancellationToken);
        var objects = new List<ModelObject>();
        var warnings = new List<string>();
        var tables = new Dictionary<string, string>();
        var tableRows = Rowset(connection, "TMSCHEMA_TABLES");
        foreach (DataRow row in tableRows.Rows)
        {
            var name = Text(row, "Name");
            var id = Text(row, "ID");
            if (name == null || id == null) continue;
            tables[id] = name;
            objects.Add(new("table:" + id, name, "table", Description: Text(row, "Description")));
            if (objects.Count > 20000) throw new HostError("SCHEMA_TOO_LARGE", "The native schema exceeds 20000 objects.");
        }
        foreach (var kind in new[] { "COLUMNS", "MEASURES", "RELATIONSHIPS" })
        {
            try
            {
                var rows = Rowset(connection, "TMSCHEMA_" + kind);
                foreach (DataRow row in rows.Rows)
                {
                    var id = Text(row, "ID");
                    if (id == null) continue;
                    var tableId = Text(row, kind == "RELATIONSHIPS" ? "FromTableID" : "TableID") ?? "";
                    var name = Text(row, "Name") ?? Text(row, "ExplicitName") ?? Text(row, "InferredName") ?? id;
                    var objectKind = kind == "COLUMNS" ? "column" : kind == "MEASURES" ? "measure" : "relationship";
                    tables.TryGetValue(tableId, out var table);
                    objects.Add(new(objectKind + ":" + id, name, objectKind, table, DataType(Text(row, "DataType") ?? Text(row, "ExplicitDataType")),
                        kind == "MEASURES" ? Text(row, "Expression") : null, Text(row, "Description")));
                    if (objects.Count > 20000) throw new HostError("SCHEMA_TOO_LARGE", "The native schema exceeds 20000 objects.");
                }
            }
            catch (HostError) { throw; }
            catch { warnings.Add($"The {kind.ToLowerInvariant()} schema rowset is unavailable for this model."); }
        }
        var schema = new ModelSchema(connectionId, objects, DateTimeOffset.UtcNow.ToString("O"), warnings);
        if (Json.Bytes(schema).Length > Json.MaxLineBytes - 8192)
            throw new HostError("SCHEMA_TOO_LARGE", "The model schema exceeds the 2 MiB protocol limit.");
        return schema;
    }
    private static DataTable Rowset(AdomdConnection connection, string rowset)
    {
        var data = connection.GetSchemaDataSet(rowset, new AdomdRestrictionCollection());
        if (data.Tables.Count == 0) throw new HostError("SCHEMA_UNAVAILABLE", "The requested native schema rowset is unavailable.");
        return data.Tables[0];
    }
    private static string? Text(DataRow row, string name) =>
        row.Table.Columns.Contains(name) && row[name] is not DBNull ? Convert.ToString(row[name], CultureInfo.InvariantCulture) : null;
    private static string? DataType(string? value) => value switch
    {
        "2" => "String", "6" => "Int64", "8" => "Double", "9" => "DateTime", "10" => "Decimal",
        "11" => "Boolean", "17" => "Binary", _ => value
    };
}
