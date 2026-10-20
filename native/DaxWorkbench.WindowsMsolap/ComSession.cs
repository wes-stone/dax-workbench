using System;
using System.Collections.Generic;
using System.Data.Common;
using System.Globalization;
using System.Linq;
using System.Runtime.InteropServices;
using System.Text.RegularExpressions;
using System.Threading;
using DaxWorkbench.Shared;

namespace DaxWorkbench.WindowsMsolap
{
    internal interface IRowset : IDisposable
    {
        int FieldCount { get; }
        string Name(int index);
        int Type(int index);
        object Value(int index);
        bool Read();
        IRowset Next();
    }
    internal interface ISession : IDisposable
    {
        void Open(string connectionString, int timeout);
        IRowset Execute(string query, int timeout);
        IRowset Schema(int rowset, object[] restrictions);
        IRowset Metadata(MetadataRowset rowset, int timeout);
        void Cancel();
    }
    internal sealed class ComSession : ISession
    {
        private object connectionObject, commandObject;
        public void Open(string connectionString, int timeout)
        {
            if (Thread.CurrentThread.GetApartmentState() != ApartmentState.STA)
                throw new DaxGateError("WINDOWS_STA_REQUIRED", "The OS-provider worker must run on an STA thread.");
            try { connectionObject = Activator.CreateInstance(System.Type.GetTypeFromProgID("ADODB.Connection", true)); }
            catch { throw new DaxGateError("WINDOWS_PROVIDER_MISSING", "The x64 ADODB/MSOLAP provider could not be activated."); }
            dynamic connection = connectionObject;
            connection.ConnectionTimeout = Math.Min(20, timeout);
            connection.CommandTimeout = timeout;
            connection.ConnectionString = connectionString;
            try
            {
                connection.Properties.Item("Prompt").Value = 4;
                if ((int)connection.Properties.Item("Prompt").Value != 4)
                    throw new DaxGateError("WINDOWS_NOPROMPT_UNSUPPORTED", "The provider did not accept no-prompt operation; connection opening is blocked.");
            }
            catch (DaxGateError) { throw; }
            catch { throw new DaxGateError("WINDOWS_NOPROMPT_UNSUPPORTED", "No-prompt operation is unavailable; opening is blocked rather than enabling interactive sign-in."); }
            try { connection.Open(); }
            catch (Exception error)
            {
                var details = new List<string> { error.GetType().Name + " (0x" + error.HResult.ToString("X8", CultureInfo.InvariantCulture) + "): " + error.Message };
                try
                {
                    for (var i = 0; i < Math.Min((int)connection.Errors.Count, 4); i++)
                    {
                        dynamic item = connection.Errors.Item(i);
                        details.Add("Provider " + Convert.ToString(item.NativeError, CultureInfo.InvariantCulture) + ": " + (string)item.Description);
                    }
                }
                catch { details.Add("Extended connection diagnostics unavailable."); }
                throw new DaxGateError("WINDOWS_OPEN_FAILED", "Windows MSOLAP could not open with prompting disabled. " + RedactConnectionDetail(string.Join(" | ", details), connectionString));
            }
        }
        internal static string RedactConnectionDetail(string message, string connectionString)
        {
            message = message.Substring(0, Math.Min(message.Length, 16384));
            var builder = new DbConnectionStringBuilder { ConnectionString = connectionString };
            foreach (var value in builder.Values.Cast<object>().Select(value => Convert.ToString(value, CultureInfo.InvariantCulture)).Where(value => !string.IsNullOrEmpty(value)).OrderByDescending(value => value.Length))
                message = message.Replace(value, "[redacted]");
            message = Regex.Replace(message, @"(?i)\b(?:https?|powerbi|asazure)://[^\s""'<>]+", "[endpoint]");
            message = Regex.Replace(message, @"(?i)\b(?:Bearer\s+\S+|(?:password|pwd|access_token|token|client_secret|authorization)\s*[:=]\s*[^;\s]+)", "[credential]");
            message = Regex.Replace(message, @"[^\s@]+@[^\s@]+", "[identity]");
            message = Regex.Replace(message, @"(?i)\b[A-Z]:\\[^\r\n""'|]+", "[local path]");
            message = Regex.Replace(message, @"""[^""]*""|'[^']*'", "[quoted value]");
            message = Regex.Replace(message, @"[A-Za-z0-9_+/=-]{64,}", "[redacted]");
            return message.Length <= 1600 ? message : message.Substring(0, 1600) + "...";
        }
        public IRowset Execute(string query, int timeout)
        {
            var phase = "command activation";
            try
            {
                commandObject = Activator.CreateInstance(System.Type.GetTypeFromProgID("ADODB.Command", true));
                dynamic command = commandObject;
                phase = "command connection assignment";
                command.ActiveConnection = connectionObject;
                phase = "command configuration";
                command.CommandType = 1;
                command.CommandTimeout = timeout;
                command.CommandText = query;
                phase = "command execution";
                object rows = ExecuteWithoutParameters(commandObject);
                if (rows == null) throw new DaxGateError("WINDOWS_RESULTSET_MISSING", "The provider returned no readable result set.");
                return new ComRowset(rows);
            }
            catch (Exception error) { throw Errors.Map(error, phase); }
        }
        internal static object ExecuteWithoutParameters(object commandObject)
        {
            dynamic command = commandObject;
            object affected;
            // A by-ref Missing becomes a nested VARIANT that ADO rejects with adErrInvalidArgument.
            return command.Execute(out affected, System.Type.Missing, -1);
        }
        public IRowset Metadata(MetadataRowset rowset, int timeout)
        {
            var text = MetadataQueries.Command(rowset);
            dynamic connection = connectionObject;
            try
            {
                connection.CommandTimeout = timeout;
                object affected;
                object rows = connection.Execute(text, out affected, 1);
                if (rows == null) throw new DaxGateError("WINDOWS_SCHEMA_UNAVAILABLE", "The provider returned no metadata rowset.");
                return new ComRowset(rows);
            }
            catch (Exception error)
            {
                if (error is DaxGateError) throw;
                var details = new List<Exception> { error };
                try
                {
                    for (var i = 0; i < Math.Min((int)connection.Errors.Count, 4); i++)
                    {
                        dynamic item = connection.Errors.Item(i);
                        details.Add(new InvalidOperationException((string)item.Description));
                    }
                }
                catch { }
                var safe = Errors.Map(new InvalidOperationException(string.Join(" | ", details.Select(detail => detail.Message))), "schema");
                if (safe.Code != "WINDOWS_PROVIDER_FAILED") throw safe;
                throw new DaxGateError("WINDOWS_METADATA_FAILED", "Fixed " + rowset + " metadata failed (0x" +
                    error.HResult.ToString("X8", CultureInfo.InvariantCulture) + "). Provider details are withheld; no fallback was attempted.");
            }
        }
        public IRowset Schema(int rowset, object[] restrictions)
        {
            dynamic connection = connectionObject;
            try
            {
                object rows = connection.OpenSchema(rowset, restrictions, System.Type.Missing);
                if (rows == null) throw new DaxGateError("WINDOWS_SCHEMA_UNAVAILABLE", "The provider returned no schema rowset.");
                return new ComRowset(rows);
            }
            catch (COMException error) when (error.HResult == unchecked((int)0x800A0BB9))
            {
                throw new DaxGateError("WINDOWS_SCHEMA_UNAVAILABLE", "The installed provider does not accept these fixed schema restrictions.");
            }
        }
        public void Cancel()
        {
            // COM cancellation may itself block behind the STA call. The host's
            // independent deadline still kills this process after its grace.
            try
            {
                if (commandObject != null) { dynamic command = commandObject; command.Cancel(); }
                else if (connectionObject != null) { dynamic connection = connectionObject; connection.Cancel(); }
            }
            catch { /* Final metadata explicitly disclaims confirmed server cancellation. */ }
        }
        public void Dispose()
        {
            try { if (connectionObject != null) { dynamic connection = connectionObject; if ((int)connection.State != 0) connection.Close(); } }
            finally
            {
                if (commandObject != null) Marshal.FinalReleaseComObject(commandObject);
                if (connectionObject != null) Marshal.FinalReleaseComObject(connectionObject);
            }
        }
    }
    internal sealed class ComRowset : IRowset
    {
        private readonly object value;
        private bool first = true;
        internal ComRowset(object value) { this.value = value; }
        public int FieldCount { get { dynamic rows = value; return (int)rows.Fields.Count; } }
        public string Name(int index) { dynamic rows = value; return (string)rows.Fields.Item(index).Name; }
        public int Type(int index) { dynamic rows = value; return (int)rows.Fields.Item(index).Type; }
        public object Value(int index) { dynamic rows = value; return rows.Fields.Item(index).Value; }
        public bool Read()
        {
            dynamic rows = value;
            if (!first) rows.MoveNext();
            first = false;
            return !(bool)rows.EOF;
        }
        public IRowset Next()
        {
            dynamic rows = value;
            object affected;
            object next = rows.NextRecordset(out affected);
            return next == null ? null : new ComRowset(next);
        }
        public void Dispose()
        {
            try { dynamic rows = value; if ((int)rows.State != 0) rows.Close(); }
            finally { Marshal.FinalReleaseComObject(value); }
        }
    }
}
