using System;
using System.Collections.Generic;
using System.Globalization;
using System.Threading;
using DaxWorkbench.Shared;

namespace DaxWorkbench.WindowsMsolap
{
    internal static class Cells
    {
        internal static string TypeName(int type)
        {
            switch (type)
            {
                case 20: case 21: return "Int64";
                case 6: case 14: case 131: case 139: return "Decimal";
                case 2: case 3: case 16: case 17: case 18: case 19: return "Int32";
                case 4: case 5: return "Double";
                case 11: return "Boolean";
                case 7: case 133: case 134: case 135: return "DateTime";
                case 8: case 72: case 129: case 130: case 200: case 201: case 202: case 203: return "String";
                case 128: case 204: case 205: return "Binary";
                default: return "Variant";
            }
        }
        internal static object Encode(object value, string type)
        {
            if (value == null || value is DBNull) return null;
            if (type == "Int64")
            {
                if (value is long || value is ulong || value is int || value is uint || value is short || value is ushort || value is byte || value is sbyte)
                    return Convert.ToString(value, CultureInfo.InvariantCulture);
                if (value is decimal && decimal.Truncate((decimal)value) == (decimal)value && (decimal)value >= long.MinValue && (decimal)value <= ulong.MaxValue)
                    return ((decimal)value).ToString(CultureInfo.InvariantCulture);
                long signed; ulong unsigned;
                if (value is string && (long.TryParse((string)value, NumberStyles.AllowLeadingSign, CultureInfo.InvariantCulture, out signed) ||
                    ulong.TryParse((string)value, NumberStyles.None, CultureInfo.InvariantCulture, out unsigned))) return value;
                throw new DaxGateError("UNSAFE_NUMERIC_CELL", "The provider did not expose an exact integral value for an Int64 field.");
            }
            if (type == "Decimal")
            {
                if (value is decimal || value is long || value is ulong || value is int || value is uint || value is short || value is ushort || value is byte || value is sbyte)
                    return Convert.ToString(value, CultureInfo.InvariantCulture);
                throw new DaxGateError("UNSAFE_NUMERIC_CELL", "The provider did not expose an exact decimal value for a Decimal field.");
            }
            if (value is long || value is ulong || value is decimal) return Convert.ToString(value, CultureInfo.InvariantCulture);
            if (value is DateTime) return ((DateTime)value).ToString("O", CultureInfo.InvariantCulture);
            if (value is DateTimeOffset) return ((DateTimeOffset)value).ToString("O", CultureInfo.InvariantCulture);
            if (value is byte[]) return Convert.ToBase64String((byte[])value);
            if (value is Guid) return ((Guid)value).ToString("D");
            if (value is char) return value.ToString();
            if (value is string || value is bool || value is int || value is uint || value is short || value is ushort || value is byte || value is sbyte) return value;
            if (value is double && !double.IsNaN((double)value) && !double.IsInfinity((double)value)) return value;
            if (value is float && !float.IsNaN((float)value) && !float.IsInfinity((float)value)) return value;
            throw new DaxGateError("UNSUPPORTED_CELL", "The Windows provider returned a cell that cannot be encoded safely.");
        }
    }
    internal sealed class SetMetadata
    {
        public string id { get; set; }
        public List<Dictionary<string, object>> columns { get; set; }
        public int rowCount { get; set; }
        public bool truncated { get; set; }
    }
    internal sealed class RunResult
    {
        internal string RunId;
        internal string Status = "completed";
        internal readonly List<SetMetadata> Sets = new List<SetMetadata>();
        internal int RowCount;
        internal long DurationMs;
        internal bool Truncated, Unread;
        internal readonly List<string> Warnings = new List<string>
        {
            "Windows MSOLAP uses the installed CLR4 OS provider with prompting disabled; it does not use Azure CLI.",
            "Read-only execution is enforced by the shared DAX guard, not an injected ReadWriteMode/ADO.Mode property.",
            "Cancellation stops local work or terminates the isolated worker. Server cancellation is best effort and server execution may continue."
        };
        internal object Error;
        internal object Metadata()
        {
            var value = new Dictionary<string, object>
            {
                ["runId"] = RunId, ["status"] = Status, ["resultSets"] = Sets, ["rowCount"] = RowCount,
                ["durationMs"] = DurationMs, ["truncated"] = Truncated, ["unreadResultSets"] = Unread, ["warnings"] = Warnings
            };
            if (Error != null) value["error"] = Error;
            return value;
        }
    }
    internal sealed class Emitter
    {
        private readonly Writer writer;
        private readonly RunResult result;
        private readonly int maxRows, maxBytes;
        private readonly CancellationToken token;
        private SetMetadata current;
        private readonly List<object[]> chunk = new List<object[]>();
        private int chunkBytes;
        private long totalBytes;
        internal Emitter(Writer writer, RunResult result, int maxRows, int maxBytes, CancellationToken token)
        { this.writer = writer; this.result = result; this.maxRows = maxRows; this.maxBytes = maxBytes; this.token = token; }
        internal void Begin(List<Dictionary<string, object>> columns)
        {
            Flush(); token.ThrowIfCancellationRequested();
            if (columns.Count > 1024) throw new DaxGateError("SCHEMA_TOO_LARGE", "At most 1024 result columns are supported.");
            if (result.Sets.Count >= 64) throw new DaxGateError("RESULTSET_LIMIT", "At most 64 result sets are supported.");
            current = new SetMetadata { id = "result-" + result.Sets.Count, columns = columns };
            writer.Write(new { @event = "query.resultset", runId = result.RunId, resultSetId = current.id, columns });
            result.Sets.Add(current);
        }
        internal bool Add(object[] row)
        {
            token.ThrowIfCancellationRequested();
            long estimated = 2;
            foreach (var cell in row)
            {
                if (cell is string && ((string)cell).Length > Wire.MaxLineBytes - 8192)
                    throw new DaxGateError("CELL_TOO_LARGE", "A result cell exceeds the protocol budget.");
                var bytes = Wire.Bytes(cell).Length;
                if (bytes > Wire.MaxLineBytes - 8192) throw new DaxGateError("CELL_TOO_LARGE", "A result cell exceeds the protocol budget.");
                estimated += bytes + 1;
                if (estimated > Wire.MaxLineBytes - 8192) throw new DaxGateError("ROW_TOO_LARGE", "A result row exceeds the protocol budget.");
            }
            var rowBytes = Wire.Bytes(row).Length + 1;
            if (result.RowCount >= maxRows || totalBytes + rowBytes > maxBytes)
            {
                result.Truncated = result.Unread = current.truncated = true;
                result.Warnings.Add(result.RowCount >= maxRows ? "The total row limit was reached." : "The total serialized-row byte limit was reached.");
                Flush(); return false;
            }
            if (chunk.Count != 0 && chunkBytes + rowBytes > 128 * 1024) Flush();
            chunk.Add(row); chunkBytes += rowBytes; totalBytes += rowBytes; current.rowCount++; result.RowCount++;
            if (chunk.Count >= 128 || chunkBytes >= 128 * 1024) Flush();
            return true;
        }
        internal void Flush()
        {
            if (chunk.Count == 0) return;
            writer.Write(new { @event = "query.rows", runId = result.RunId, resultSetId = current.id, offset = current.rowCount - chunk.Count, rows = chunk });
            chunk.Clear(); chunkBytes = 0;
        }
    }
}
