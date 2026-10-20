using System.Collections.Concurrent;
using System.Text.Json;
using Microsoft.Data.Sqlite;

namespace DaxWorkbench.Host;

public static class Program
{
    public static async Task<int> Main(string[] args)
    {
        var output = new ProtocolWriter(Console.OpenStandardOutput());
        try
        {
            if (args.Length == 1 && args[0] == "--worker") return await Worker(output);
            if (args.Length != 2 || args[0] != "--artifacts")
            {
                Console.Error.WriteLine("Usage: DaxWorkbench.Host.exe --artifacts <absolute-directory>");
                return 2;
            }
            var store = new LocalStore(args[1]);
            var registry = new ConnectionRegistry(store);
            using var coordinator = new QueryCoordinator(registry, output);
            var lines = new BoundedLines(Console.OpenStandardInput());
            var pending = new ConcurrentDictionary<string, Task>();
            while (true)
            {
                byte[]? line;
                try { line = await lines.ReadAsync(); }
                catch (HostError error) { output.Write(new { id = "", error = error.Safe }); continue; }
                if (line == null) break;
                if (line.Length == 0) continue;
                string id = "";
                try
                {
                    using var document = JsonDocument.Parse(line);
                    var root = document.RootElement;
                    id = root.Required("id", 128);
                    var method = root.Required("method", 128);
                    var parameters = root.TryGetProperty("params", out var parameter) ? parameter.Clone() : Json.Element(new { });
                    if (parameters.ValueKind != JsonValueKind.Object) throw new HostError("INVALID_PARAMS", "params must be an object.");
                    if (!pending.TryAdd(id, Task.CompletedTask)) throw new HostError("DUPLICATE_REQUEST", "This request ID is already active.");
                    if (pending.Count > 64 && method != "query.cancel")
                    {
                        pending.TryRemove(id, out _);
                        throw new HostError("HOST_BUSY", "Too many concurrent requests.");
                    }
                    var requestId = id;
                    Task<object> operation;
                    try
                    {
                        operation = method switch
                        {
                            "query.execute" => coordinator.Execute(parameters),
                            "query.cancel" => Task.FromResult(coordinator.Cancel(parameters.Required("runId", 128))),
                            "schema.get" => Task.Run(() => coordinator.Schema(parameters)),
                            "health" => Task.FromResult<object>(new { protocolVersion = 1, version = "0.1.0" }),
                            _ => Task.Run<object>(() => Dispatch(method, parameters, registry, store))
                        };
                    }
                    catch { pending.TryRemove(id, out _); throw; }
                    // Reserve the ID before scheduling, and use an independent
                    // continuation so query execution never stalls control input.
                    var completion = operation.ContinueWith(task =>
                    {
                        try
                        {
                            if (task.IsCompletedSuccessfully) output.Write(new { id = requestId, result = task.Result });
                            else output.Write(new { id = requestId, error = SafeError(task.Exception?.GetBaseException()).Safe });
                        }
                        catch (HostError error) { output.Write(new { id = requestId, error = error.Safe }); }
                        finally { pending.TryRemove(requestId, out _); }
                    }, TaskScheduler.Default);
                    pending.TryUpdate(requestId, completion, Task.CompletedTask);
                }
                catch (Exception error) { output.Write(new { id, error = SafeError(error).Safe }); }
            }
            coordinator.Dispose();
            await Task.WhenAny(Task.WhenAll(pending.Values), Task.Delay(8000));
            return 0;
        }
        catch
        {
            Console.Error.WriteLine("Native companion stopped. Check artifact-directory permissions and local dependencies.");
            return 1;
        }
    }
    private static object Dispatch(string method, JsonElement parameters, ConnectionRegistry registry, LocalStore store) => method switch
    {
        "connections.list" => new { connections = registry.List(), discovery = registry.ConfiguredDiscovery },
        "connections.import" when parameters.TryGetProperty("source", out var source) && source.GetString() == "dax-query"
            => registry.SyncConfigured(parameters.Required("directory")),
        "connections.import" => new { connections = registry.Import(parameters.Required("directory"),
            parameters.TryGetProperty("connectionName", out _) ? parameters.Required("connectionName", 200) : null,
            parameters.TryGetProperty("authMode", out _) ? parameters.Required("authMode", 30) : "connection-string",
            parameters.TryGetProperty("kind", out _) ? parameters.Required("kind", 30) : "msolap") },
        "connections.discover" => new { connections = registry.Discover() },
        "connection.add" => new { connection = registry.Add(parameters) },
        "connection.details" => registry.Inspect(parameters.Required("connectionId", 256)),
        "store.read" => store.Read(parameters.Required("key", 256)),
        "store.write" => StoreWrite(parameters, store),
        _ => throw new HostError("METHOD_NOT_FOUND", "This native protocol method is not supported.")
    };
    private static object StoreWrite(JsonElement parameters, LocalStore store)
    {
        var key = parameters.Required("key", 256);
        if (!parameters.TryGetProperty("expectedRevision", out var revision) || revision.ValueKind != JsonValueKind.Number ||
            !revision.TryGetInt64(out var expected) ||
            !parameters.TryGetProperty("value", out var value))
            throw new HostError("INVALID_PARAMS", "store.write requires expectedRevision and value.");
        return store.Write(key, expected, value);
    }
    internal static HostError SafeError(Exception? error) => error switch
    {
        HostError safe => safe,
        JsonException => new("INVALID_JSON", "The request is not valid protocol JSON."),
        OperationCanceledException => new("CANCELLED", "The operation was cancelled."),
        SqliteException { SqliteErrorCode: 5 or 6 } => new("STORE_BUSY", "The local store is busy. Retry the operation."),
        SqliteException => new("STORE_FAILED", "The local store operation failed."),
        _ => new("NATIVE_ERROR", "The native operation failed. Check the selected connection or local configuration.")
    };
    private static async Task<int> Worker(ProtocolWriter output)
    {
        var input = new BoundedLines(Console.OpenStandardInput());
        var line = await input.ReadAsync();
        if (line == null) return 2;
        using var document = JsonDocument.Parse(line);
        var message = document.RootElement;
        var request = message.GetProperty("request").Clone();
        var connectionString = message.TryGetProperty("connectionString", out var secret) ? secret.GetString() : null;
        var method = message.Required("method");
        using var cancellation = new CancellationTokenSource();
        _ = Task.Run(async () =>
        {
            try
            {
                await input.ReadAsync();
                await cancellation.CancelAsync();
            }
            catch { }
        });
        try
        {
            var result = method == "query.execute"
                ? (object)QueryEngine.Run(request, connectionString, output, cancellation.Token)
                : NativeSchema.Read(request.Required("connectionId", 256), connectionString, cancellation.Token);
            output.Write(new { result });
        }
        catch (Exception error)
        {
            var safe = error is HostError ? SafeError(error) : ProviderErrors.Map(error, "schema discovery");
            output.Write(new { error = safe.Safe });
        }
        return 0;
    }
}
