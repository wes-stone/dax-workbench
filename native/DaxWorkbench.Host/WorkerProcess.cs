using System.Collections.Concurrent;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Security.Principal;
using System.Text.Json;
using Microsoft.Win32.SafeHandles;

namespace DaxWorkbench.Host;

// Worker lifetime is tied to the supervising host even when the host crashes.
// A hung provider can be terminated without blocking the host's control reader.
internal sealed class WorkerJob : IDisposable
{
    private readonly SafeFileHandle handle;
    public WorkerJob(Process process)
    {
        handle = CreateJobObject(IntPtr.Zero, null);
        if (handle.IsInvalid) throw new HostError("WORKER_START_FAILED", "Could not create a query worker job.");
        var information = new ExtendedLimitInformation();
        information.BasicLimitInformation.LimitFlags = 0x2000; // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
        var size = Marshal.SizeOf<ExtendedLimitInformation>();
        var pointer = Marshal.AllocHGlobal(size);
        try
        {
            Marshal.StructureToPtr(information, pointer, false);
            if (!SetInformationJobObject(handle, 9, pointer, (uint)size) ||
                !AssignProcessToJobObject(handle, process.Handle))
                throw new HostError("WORKER_START_FAILED", "Could not supervise the query worker.");
        }
        catch { handle.Dispose(); throw; }
        finally { Marshal.FreeHGlobal(pointer); }
    }
    public void Dispose() => handle.Dispose();
    [StructLayout(LayoutKind.Sequential)]
    private struct BasicLimitInformation
    {
        public long PerProcessUserTimeLimit, PerJobUserTimeLimit;
        public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize, MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass, SchedulingClass;
    }
    [StructLayout(LayoutKind.Sequential)]
    private struct IoCounters { public ulong ReadOperationCount, WriteOperationCount, OtherOperationCount, ReadTransferCount, WriteTransferCount, OtherTransferCount; }
    [StructLayout(LayoutKind.Sequential)]
    private struct ExtendedLimitInformation
    {
        public BasicLimitInformation BasicLimitInformation;
        public IoCounters IoInfo;
        public UIntPtr ProcessMemoryLimit, JobMemoryLimit, PeakProcessMemoryUsed, PeakJobMemoryUsed;
    }
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
    private static extern SafeFileHandle CreateJobObject(IntPtr attributes, string? name);
    [DllImport("kernel32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool SetInformationJobObject(SafeFileHandle job, int informationClass, IntPtr information, uint length);
    [DllImport("kernel32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool AssignProcessToJobObject(SafeFileHandle job, IntPtr process);
}

public sealed class QueryCoordinator(ConnectionRegistry registry, ProtocolWriter output) : IDisposable
{
    private readonly ConcurrentDictionary<string, CancellationTokenSource> active = new();
    private readonly object schemaGate = new();
    private readonly Dictionary<string, Task<object>> schemaReads = new();
    private readonly CancellationTokenSource lifetime = new();
    internal const int SchemaLockWaitMilliseconds = 15_000;
    private int disposed;
    public Task<object> Execute(JsonElement request)
    {
        var runId = request.Required("runId", 128);
        request.Required("connectionId", 256);
        ReadOnlyDax.Validate(request.Required("query", 1_500_000));
        ReadOnlyDax.Parameters(request);
        request.Integer("maxRows", 10000, 1, 100000);
        request.Integer("maxBytes", 8 * 1024 * 1024, 1, 100 * 1024 * 1024);
        var timeout = request.Integer("timeoutSeconds", 30, 1, 600);
        var cancellation = CancellationTokenSource.CreateLinkedTokenSource(lifetime.Token);
        if (!active.TryAdd(runId, cancellation))
        {
            cancellation.Dispose();
            throw new HostError("RUN_BUSY", "This run ID is already active.");
        }
        return Task.Factory.StartNew(() =>
        {
            try
            {
                var connectionString = registry.Resolve(request.Required("connectionId", 256))?.ConnectionString();
                return RunWorker("query.execute", request, connectionString, timeout, cancellation.Token);
            }
            catch (OperationCanceledException)
            {
                return new QueryResult { RunId = runId, Status = "cancelled", UnreadResultSets = true,
                    Error = new HostError("CANCELLED", "The query was cancelled.").Safe };
            }
            finally
            {
                active.TryRemove(runId, out _);
                cancellation.Dispose();
            }
        }, CancellationToken.None, TaskCreationOptions.LongRunning, TaskScheduler.Default);
    }
    public Task<object> Schema(JsonElement request)
    {
        var connectionId = request.Required("connectionId", 256);
        var connectionString = registry.Resolve(connectionId)?.ConnectionString();
        // Share only the exact profile snapshot, not aliases with different
        // credentials, perspectives or caller-visible connection IDs.
        var key = connectionId + "\n" + ConnectionRegistry.Hash(connectionString ?? "");
        lock (schemaGate)
        {
            if (Volatile.Read(ref disposed) != 0) throw new OperationCanceledException("The native host is closing.");
            if (schemaReads.TryGetValue(key, out var pending)) return pending;
            var token = lifetime.Token;
            var task = Task.Factory.StartNew(() =>
            {
                try { return RunWorker("schema.get", request, connectionString, 30, token); }
                finally { lock (schemaGate) schemaReads.Remove(key); }
            }, CancellationToken.None, TaskCreationOptions.LongRunning, TaskScheduler.Default);
            schemaReads.Add(key, task);
            return task;
        }
    }
    public object Cancel(string runId)
    {
        if (active.TryGetValue(runId, out var cancellation))
        {
            try { cancellation.Cancel(); } catch (ObjectDisposedException) { }
        }
        return new { requested = true };
    }
    public static string MutexName(string identity) =>
        @"Global\DaxWorkbench.Native.Query.v1." + ConnectionRegistry.Hash(WindowsIdentity.GetCurrent().User!.Value + "\n" + identity);
    internal static bool WaitForConnection(Mutex mutex, int waitMilliseconds, CancellationToken token)
    {
        var timer = Stopwatch.StartNew();
        do
        {
            token.ThrowIfCancellationRequested();
            var remaining = Math.Max(0, waitMilliseconds - (int)timer.ElapsedMilliseconds);
            try { if (mutex.WaitOne(Math.Min(100, remaining))) return true; }
            catch (AbandonedMutexException) { return true; }
        } while (timer.ElapsedMilliseconds < waitMilliseconds);
        return false;
    }
    private object RunWorker(string method, JsonElement request, string? connectionString, int timeout, CancellationToken token)
    {
        var connectionId = request.Required("connectionId", 256);
        if (method == "query.execute" && NativeConnections.IsPowerBiRest(connectionString))
            PowerBiRest.ValidateRequest(request);
        if (WindowsMsolapNative.IsProfile(connectionString))
        {
            WindowsMsolapNative.ReadProfile(connectionString!);
            if (method == "query.execute") WindowsMsolapNative.ValidateRequest(request);
        }
        using var mutex = new Mutex(false, MutexName(ConnectionRegistry.LockIdentity(connectionId, connectionString)));
        var acquired = false;
        try
        {
            acquired = WaitForConnection(mutex, method == "schema.get" ? SchemaLockWaitMilliseconds : 0, token);
            if (!acquired) throw new HostError("CONNECTION_BUSY", method == "schema.get"
                ? "Model metadata could not start after waiting 15 seconds for a query or metadata refresh using this connection. It may be in this workbench or another session. Wait for it to finish, then retry schema."
                : "A query or metadata refresh is already using this connection, in this workbench or another session. Wait for it to finish before running the query.");
            token.ThrowIfCancellationRequested();
            return Supervise(method, request, connectionString, timeout, token);
        }
        catch (OperationCanceledException) when (method == "query.execute" && NativeConnections.IsPowerBiRest(connectionString))
        {
            var cancelled = new QueryResult { RunId = request.Required("runId", 128), Status = "cancelled",
                UnreadResultSets = true, Error = new HostError("CANCELLED", "The query was cancelled.").Safe };
            PowerBiRest.AddWarnings(cancelled);
            return cancelled;
        }
        finally { if (acquired) mutex.ReleaseMutex(); }
    }
    private object Supervise(string method, JsonElement request, string? connectionString, int timeout, CancellationToken token)
    {
        var timer = Stopwatch.StartNew();
        var start = new ProcessStartInfo
        {
            FileName = Environment.ProcessPath!,
            UseShellExecute = false, CreateNoWindow = true,
            RedirectStandardInput = true, RedirectStandardOutput = true, RedirectStandardError = true
        };
        if (Path.GetFileNameWithoutExtension(start.FileName).Equals("dotnet", StringComparison.OrdinalIgnoreCase))
            start.ArgumentList.Add(typeof(QueryCoordinator).Assembly.Location);
        if (WindowsMsolapNative.IsProfile(connectionString))
        {
            start.FileName = WindowsMsolapNative.WorkerPath();
            start.WorkingDirectory = Path.GetDirectoryName(start.FileName)!;
            start.ArgumentList.Clear();
        }
        start.ArgumentList.Add("--worker");
        using var process = Process.Start(start) ?? throw new HostError("WORKER_START_FAILED", "Could not start a native query worker.");
        try
        {
            using var job = new WorkerJob(process);
            var workerInput = new ProtocolWriter(process.StandardInput.BaseStream);
            workerInput.Write(new { method, request, connectionString });
            var partial = new QueryResult { RunId = method == "query.execute" ? request.Required("runId", 128) : "" };
            if (NativeConnections.IsPowerBiRest(connectionString)) PowerBiRest.AddWarnings(partial);
            if (WindowsMsolapNative.IsProfile(connectionString)) partial.Warnings.Add(WindowsMsolapNative.CancellationWarning);
            JsonElement? final = null;
            HostError? workerError = null;
            var reader = new BoundedLines(process.StandardOutput.BaseStream);
            var outputTask = Task.Run(async () =>
            {
                while (await reader.ReadAsync() is { } line)
                {
                    using var document = JsonDocument.Parse(line);
                    var message = document.RootElement;
                    if (message.TryGetProperty("event", out var eventName))
                    {
                        if (eventName.GetString() == "query.resultset")
                        {
                            partial.ResultSets.Add(new ResultSet
                            {
                                Id = message.Required("resultSetId"),
                                Columns = JsonSerializer.Deserialize<List<Column>>(message.GetProperty("columns"), Json.Options)!
                            });
                        }
                        else if (eventName.GetString() == "query.rows")
                        {
                            var count = message.GetProperty("rows").GetArrayLength();
                            var set = partial.ResultSets.First(s => s.Id == message.Required("resultSetId"));
                            set.RowCount += count; partial.RowCount += count;
                        }
                        output.Write(line);
                    }
                    else if (message.TryGetProperty("result", out var result)) final = result.Clone();
                    else if (message.TryGetProperty("error", out var error))
                        workerError = new HostError(error.Required("code"), error.Required("message"));
                }
            });
            var stderrTask = Task.Run(async () =>
            {
                var buffer = new char[4096];
                while (await process.StandardError.ReadAsync(buffer) != 0) { }
            });
            string? stopped = null;
            long? cancelAt = null;
            while (!process.WaitForExit(25))
            {
                if (stopped == null && (token.IsCancellationRequested || timer.Elapsed.TotalSeconds >= timeout))
                {
                    stopped = token.IsCancellationRequested ? "cancelled" : "timed-out";
                    cancelAt = timer.ElapsedMilliseconds;
                    try { workerInput.Write(new { method = "cancel" }); } catch { }
                }
                if (cancelAt.HasValue && timer.ElapsedMilliseconds - cancelAt.Value >= 2000)
                {
                    process.Kill(entireProcessTree: true);
                    process.WaitForExit(5000);
                    break;
                }
            }
            try { Task.WaitAll([outputTask, stderrTask], TimeSpan.FromSeconds(5)); }
            catch
            {
                if (stopped == null) throw new HostError("WORKER_FAILED", "The native worker returned an invalid response.");
            }
            if (!outputTask.IsCompleted) throw new HostError("WORKER_FAILED", "The native worker output did not close.");
            if (stopped != null)
            {
                if (method != "query.execute") throw new HostError("SCHEMA_TIMEOUT", "Native schema discovery exceeded its time limit.");
                partial.Status = stopped;
                partial.DurationMs = timer.ElapsedMilliseconds;
                partial.UnreadResultSets = true;
                partial.Error = new HostError(stopped == "cancelled" ? "CANCELLED" : "TIMEOUT",
                    stopped == "cancelled" ? "The query was cancelled." : "The query exceeded its time limit.").Safe;
                partial.Warnings.Add("Partial rows may have been returned before the worker stopped.");
                return partial;
            }
            if (workerError != null) throw workerError;
            if (final != null) return final.Value;
            if (method != "query.execute") throw new HostError("SCHEMA_FAILED", "The native schema worker stopped unexpectedly.");
            partial.Status = "failed";
            partial.UnreadResultSets = true;
            partial.DurationMs = timer.ElapsedMilliseconds;
            partial.Error = new HostError("WORKER_FAILED", "The native query worker stopped unexpectedly.").Safe;
            return partial;
        }
        finally
        {
            if (!process.HasExited)
            {
                try { process.Kill(entireProcessTree: true); process.WaitForExit(5000); } catch { }
            }
        }
    }
    public void Dispose()
    {
        if (Interlocked.Exchange(ref disposed, 1) != 0) return;
        lifetime.Cancel();
        foreach (var cancellation in active.Values)
            try { cancellation.Cancel(); } catch (ObjectDisposedException) { }
        lifetime.Dispose();
    }
}
