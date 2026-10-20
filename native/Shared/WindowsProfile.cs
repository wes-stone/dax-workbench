using System;
using System.Data.Common;
using System.Text.RegularExpressions;

namespace DaxWorkbench.Shared
{
    public static class WindowsProfile
    {
        public const string Kind = "windows-msolap";
        public const string KindKey = "DaxWorkbench Kind";
        public const string AuthKey = "DaxWorkbench Authentication";
        public static string Create(string connectionString, string authMode)
        {
            if (authMode != "connection-string") throw new DaxGateError("INVALID_AUTH_MODE", "Windows MSOLAP supports only connection-string authentication through the existing OS provider session.");
            var builder = Parse(connectionString);
            if (builder.ContainsKey(KindKey) || builder.ContainsKey(AuthKey))
                throw new DaxGateError("INVALID_CONNECTION", "Internal transport/authentication markers cannot be supplied in a Windows MSOLAP connection string.");
            Validate(builder);
            builder[KindKey] = Kind;
            return builder.ConnectionString;
        }
        public static DbConnectionStringBuilder Read(string profile)
        {
            var builder = Parse(profile);
            if (!builder.TryGetValue(KindKey, out var kind) || !string.Equals(kind?.ToString(), Kind, StringComparison.Ordinal))
                throw new DaxGateError("INVALID_CONNECTION", "A protected explicit Windows MSOLAP profile is required.");
            if (builder.ContainsKey(AuthKey))
                throw new DaxGateError("INVALID_AUTH_MODE", "Windows MSOLAP does not accept an authentication broker marker.");
            builder.Remove(KindKey);
            Validate(builder);
            return builder;
        }
        private static DbConnectionStringBuilder Parse(string text)
        {
            try { return new DbConnectionStringBuilder { ConnectionString = text }; }
            catch { throw new DaxGateError("INVALID_CONNECTION", "The Windows MSOLAP profile could not be parsed."); }
        }
        private static void Validate(DbConnectionStringBuilder builder)
        {
            if (!builder.TryGetValue("Data Source", out var source) || string.IsNullOrWhiteSpace(source?.ToString()))
                throw new DaxGateError("INVALID_CONNECTION", "Windows MSOLAP requires Data Source.");
            if (!builder.TryGetValue("Provider", out var provider) || !Regex.IsMatch(provider?.ToString() ?? "", @"^MSOLAP(?:\.[0-9]+)?\z", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant))
                throw new DaxGateError("UNSUPPORTED_CONNECTION", "Windows transport requires an explicit MSOLAP or versioned MSOLAP provider.");
            if (builder.ContainsKey("ReadWriteMode"))
                throw new DaxGateError("WINDOWS_UNSUPPORTED_PROPERTY", "ReadWriteMode is not a supported connection-string property for this OS-provider path. Read-only execution is enforced by the shared DAX guard.");
        }
    }
}
