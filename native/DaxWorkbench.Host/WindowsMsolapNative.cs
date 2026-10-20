using System.Data.Common;
using System.Text.Json;
using DaxWorkbench.Shared;

namespace DaxWorkbench.Host;

public static class WindowsMsolapNative
{
    public const string CancellationWarning = "Windows MSOLAP cancellation stops local work or terminates the isolated CLR4 worker; server cancellation is best effort and server execution may continue.";
    public static bool IsProfile(string? text)
    {
        if (string.IsNullOrWhiteSpace(text)) return false;
        var builder = new DbConnectionStringBuilder { ConnectionString = text };
        return builder.TryGetValue(WindowsProfile.KindKey, out var kind) && kind.ToString() == WindowsProfile.Kind;
    }
    public static string CreateProfile(string text, string authMode)
    {
        try { return WindowsProfile.Create(text, authMode); }
        catch (DaxGateError error) { throw new HostError(error.Code, error.Message); }
    }
    public static DbConnectionStringBuilder ReadProfile(string text)
    {
        try { return WindowsProfile.Read(text); }
        catch (DaxGateError error) { throw new HostError(error.Code, error.Message); }
    }
    public static void ValidateRequest(JsonElement request)
    {
        var tokens = ReadOnlyDax.Validate(request.Required("query", 1_500_000));
        if (ReadOnlyDax.Parameters(request).Count != 0 || tokens.Any(t => t.Kind == "symbol" && t.Text == "@"))
            throw new HostError("WINDOWS_PARAMETERS_UNSUPPORTED", "Windows MSOLAP native parameters are not yet supported. No parameter substitution is performed.");
    }
    public static string WorkerPath()
    {
        var path = Path.Combine(AppContext.BaseDirectory, "windows-msolap", "DaxWorkbench.WindowsMsolap.exe");
        if (!File.Exists(path) || !File.Exists(path + ".config"))
            throw new HostError("WINDOWS_WORKER_MISSING", "The CLR4 Windows MSOLAP worker and its configuration must be deployed in the isolated windows-msolap subdirectory.");
        return path;
    }
}
