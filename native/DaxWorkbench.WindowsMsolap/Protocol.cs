using System;
using System.Collections.Generic;
using System.IO;
using System.Text;
using System.Web.Script.Serialization;
using DaxWorkbench.Shared;

namespace DaxWorkbench.WindowsMsolap
{
    internal static class Wire
    {
        internal const int MaxLineBytes = 2 * 1024 * 1024;
        internal static byte[] Bytes(object value) =>
            Encoding.UTF8.GetBytes(new JavaScriptSerializer { MaxJsonLength = 8 * MaxLineBytes, RecursionLimit = 64 }.Serialize(value));
        internal static Dictionary<string, object> Parse(byte[] bytes)
        {
            try
            {
                var text = new UTF8Encoding(false, true).GetString(bytes);
                return Object(new JavaScriptSerializer { MaxJsonLength = MaxLineBytes, RecursionLimit = 64 }.DeserializeObject(text));
            }
            catch (DaxGateError) { throw; }
            catch { throw new DaxGateError("INVALID_JSON", "The private worker request is not valid bounded JSON."); }
        }
        internal static Dictionary<string, object> Object(object value) =>
            value as Dictionary<string, object> ?? throw new DaxGateError("INVALID_PARAMS", "A JSON object is required.");
        internal static string Required(Dictionary<string, object> value, string key, int max = 4096)
        {
            object raw;
            var text = value.TryGetValue(key, out raw) ? raw as string : null;
            if (string.IsNullOrEmpty(text) || text.Length > max) throw new DaxGateError("INVALID_PARAMS", "A valid " + key + " is required.");
            return text;
        }
        internal static int Integer(Dictionary<string, object> value, string key, int fallback, int min, int max)
        {
            object raw;
            if (!value.TryGetValue(key, out raw)) return fallback;
            if (!(raw is int) || (int)raw < min || (int)raw > max)
                throw new DaxGateError("INVALID_PARAMS", key + " is outside the supported range.");
            return (int)raw;
        }
        internal static byte[] ReadLine(Stream input)
        {
            using (var line = new MemoryStream())
            {
                int next;
                while ((next = input.ReadByte()) != -1)
                {
                    if (next == '\n') break;
                    if (line.Length == MaxLineBytes) throw new DaxGateError("MESSAGE_TOO_LARGE", "The private worker request exceeds 2 MiB.");
                    line.WriteByte((byte)next);
                }
                if (next == -1 && line.Length == 0) return null;
                var bytes = line.ToArray();
                if (bytes.Length > 0 && bytes[bytes.Length - 1] == '\r') Array.Resize(ref bytes, bytes.Length - 1);
                return bytes;
            }
        }
    }
    internal sealed class Writer
    {
        private readonly Stream stream;
        private readonly object gate = new object();
        internal Writer(Stream stream) { this.stream = stream; }
        internal void Write(object message)
        {
            var bytes = Wire.Bytes(message);
            if (bytes.Length > Wire.MaxLineBytes) throw new DaxGateError("MESSAGE_TOO_LARGE", "The private worker response exceeds 2 MiB.");
            lock (gate) { stream.Write(bytes, 0, bytes.Length); stream.WriteByte((byte)'\n'); stream.Flush(); }
        }
    }
}
