using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using System.Threading;
using DaxWorkbench.Shared;
using Microsoft.CSharp.RuntimeBinder;

namespace DaxWorkbench.WindowsMsolap
{
    internal static class Errors
    {
        internal static DaxGateError Map(Exception error, string phase)
        {
            if (error is DaxGateError) return (DaxGateError)error;
            if (error is OperationCanceledException) return new DaxGateError("CANCELLED", "The local Windows provider operation was cancelled.");
            var messages = new List<string>();
            for (var current = error; current != null && messages.Count < 8; current = current.InnerException)
                messages.Add(current.Message.Length > 8192 ? current.Message.Substring(0, 8192) : current.Message);
            Func<string, bool> has = word => messages.Any(message => message.IndexOf(word, StringComparison.OrdinalIgnoreCase) >= 0);
            if (phase == "schema" && (has("permission") || has("access denied") || has("not authorized") || has("administrator")))
                return new DaxGateError("WINDOWS_SCHEMA_ACCESS_DENIED", "Opening succeeded, but the OS provider denied this reader metadata rowset.");
            if (phase == "schema" && (has("not supported") || has("not recognized") || has("unsupported")))
                return new DaxGateError("WINDOWS_SCHEMA_UNAVAILABLE", "Opening succeeded, but the OS provider does not expose this reader metadata rowset.");
            if (phase == "opening" && (has("authentication") || has("interactive") || has("prompt") || has("credential") || has("sign in")))
                return new DaxGateError("WINDOWS_AUTHENTICATION_REQUIRED", "The OS provider could not open using its existing session with prompting disabled. No sign-in or credential submission was attempted.");
            var diagnostic = error;
            var candidate = error;
            for (var depth = 0; candidate != null && depth < 8; candidate = candidate.InnerException, depth++)
            {
                if (!(candidate is COMException) && !(candidate is RuntimeBinderException)) continue;
                diagnostic = candidate;
                break;
            }
            var category = diagnostic is RuntimeBinderException ? "local COM binding" :
                diagnostic is COMException ? "COM provider" : "managed adapter";
            return new DaxGateError("WINDOWS_PROVIDER_FAILED", "The Windows MSOLAP operation failed during " + phase +
                " (" + category + ", HRESULT 0x" + diagnostic.HResult.ToString("X8", CultureInfo.InvariantCulture) +
                "). Provider messages and values are withheld.");
        }
        internal static object Safe(DaxGateError error) => new { code = error.Code, message = error.Message };
    }
    internal static class Program
    {
        [STAThread]
        private static int Main(string[] args)
        {
            var writer = new Writer(Console.OpenStandardOutput());
            try
            {
                if (args.Length != 1 || args[0] != "--worker") throw new DaxGateError("METHOD_NOT_FOUND", "This executable accepts only the private supervised worker protocol.");
                var input = Console.OpenStandardInput();
                var bytes = Wire.ReadLine(input);
                if (bytes == null) return 2;
                var message = Wire.Parse(bytes);
                using (var cancellation = new CancellationTokenSource())
                {
                    var control = new Thread(() =>
                    {
                        try { Wire.ReadLine(input); }
                        catch { /* Invalid control input also cancels rather than extending the run. */ }
                        try { cancellation.Cancel(); } catch (ObjectDisposedException) { }
                    }) { IsBackground = true };
                    control.Start();
                    var method = Wire.Required(message, "method", 128);
                    var request = Wire.Object(message["request"]);
                    var profile = Wire.Required(message, "connectionString", 65536);
                    if (method == "query.execute")
                        writer.Write(new { result = RunQuery(request, profile, writer, cancellation, () => new ComSession()).Metadata() });
                    else if (method == "schema.get")
                    {
                        var builder = WindowsProfile.Read(profile);
                        var id = Wire.Required(request, "connectionId", 256);
                        cancellation.CancelAfter(TimeSpan.FromSeconds(30));
                        using (var session = new ComSession())
                        {
                            cancellation.Token.ThrowIfCancellationRequested();
                            try { session.Open(builder.ConnectionString, 30); }
                            catch (Exception error) { throw Errors.Map(error, "opening"); }
                            object catalog, cube;
                            var schema = ReaderSchema.Read(session, id, builder.TryGetValue("Initial Catalog", out catalog) ? catalog.ToString() : null,
                                cancellation.Token, builder.TryGetValue("Cube", out cube) ? cube.ToString() : null);
                            writer.Write(new { result = schema });
                        }
                    }
                    else throw new DaxGateError("METHOD_NOT_FOUND", "The Windows worker supports only query.execute and schema.get.");
                }
                return 0;
            }
            catch (Exception error)
            {
                try { writer.Write(new { error = Errors.Safe(Errors.Map(error, "worker")) }); }
                catch { Console.Error.WriteLine("The Windows worker could not emit its bounded response."); }
                return 1;
            }
        }
        internal static void ValidateRequest(Dictionary<string, object> request)
        {
            var tokens = DaxReadOnlyGate.Validate(Wire.Required(request, "query", 1500000));
            object parameters;
            if (request.TryGetValue("parameters", out parameters) && Wire.Object(parameters).Count != 0 ||
                tokens.Any(token => token.Kind == "symbol" && token.Text == "@"))
                throw new DaxGateError("WINDOWS_PARAMETERS_UNSUPPORTED", "Windows MSOLAP native parameters are not yet supported. No parameter substitution is performed.");
        }
        internal static RunResult RunQuery(Dictionary<string, object> request, string profile, Writer writer,
            CancellationTokenSource cancellation, Func<ISession> createSession)
        {
            var result = new RunResult { RunId = Wire.Required(request, "runId", 128) };
            Wire.Required(request, "connectionId", 256);
            var timer = Stopwatch.StartNew();
            var emitter = new Emitter(writer, result, Wire.Integer(request, "maxRows", 10000, 1, 100000),
                Wire.Integer(request, "maxBytes", 8 * 1024 * 1024, 1, 100 * 1024 * 1024), cancellation.Token);
            var phase = "preparation";
            try
            {
                ValidateRequest(request);
                var builder = WindowsProfile.Read(profile);
                var timeout = Wire.Integer(request, "timeoutSeconds", 30, 1, 600);
                cancellation.CancelAfter(TimeSpan.FromSeconds(timeout));
                using (var session = createSession())
                using (cancellation.Token.Register(() => ThreadPool.QueueUserWorkItem(_ => session.Cancel())))
                {
                    cancellation.Token.ThrowIfCancellationRequested();
                    writer.Write(new { @event = "query.progress", runId = result.RunId, status = "connecting" });
                    phase = "opening";
                    session.Open(builder.ConnectionString, timeout);
                    cancellation.Token.ThrowIfCancellationRequested();
                    writer.Write(new { @event = "query.progress", runId = result.RunId, status = "executing" });
                    phase = "execution";
                    IRowset rows = session.Execute(Wire.Required(request, "query", 1500000), timeout);
                    try
                    {
                        while (rows != null)
                        {
                            cancellation.Token.ThrowIfCancellationRequested();
                            phase = "result reading";
                            if (rows.FieldCount > 1024) throw new DaxGateError("SCHEMA_TOO_LARGE", "At most 1024 result columns are supported.");
                            var columns = new List<Dictionary<string, object>>();
                            var types = new List<string>();
                            for (var i = 0; i < rows.FieldCount; i++)
                            {
                                var type = Cells.TypeName(rows.Type(i)); types.Add(type);
                                columns.Add(new Dictionary<string, object> { ["id"] = "column-" + i, ["name"] = rows.Name(i), ["dataType"] = type });
                            }
                            emitter.Begin(columns);
                            writer.Write(new { @event = "query.progress", runId = result.RunId, status = "streaming" });
                            var stopped = false;
                            while (rows.Read())
                            {
                                cancellation.Token.ThrowIfCancellationRequested();
                                var values = new object[types.Count];
                                for (var i = 0; i < values.Length; i++) values[i] = Cells.Encode(rows.Value(i), types[i]);
                                if (!emitter.Add(values)) { stopped = true; break; }
                            }
                            emitter.Flush();
                            if (stopped) break;
                            var next = rows.Next();
                            rows.Dispose();
                            rows = next;
                        }
                    }
                    finally { if (rows != null) rows.Dispose(); }
                }
            }
            catch (Exception error)
            {
                var safe = Errors.Map(error, phase);
                result.Status = error is OperationCanceledException ? "cancelled" : "failed";
                result.Unread = true;
                result.Error = Errors.Safe(safe);
            }
            finally { emitter.Flush(); result.DurationMs = timer.ElapsedMilliseconds; }
            return result;
        }
    }
}
