using System.Text.RegularExpressions;

namespace DaxWorkbench.Host;

public static class ProviderErrors
{
    public static string ConnectionDetail(string message, IEnumerable<string> secrets)
    {
        foreach (var secret in secrets.Where(s => s.Length > 0).OrderByDescending(s => s.Length))
            message = message.Replace(secret, "[redacted]", StringComparison.Ordinal);
        message = Regex.Replace(message, @"(?i)\b(?:https?|powerbi|asazure)://[^\s""'<>]+", "[endpoint]");
        message = Regex.Replace(message, @"(?i)\b(?:Bearer\s+\S+|(?:password|pwd|access_token|token|client_secret|authorization)\s*[:=]\s*[^;\s]+)", "[credential]");
        message = Regex.Replace(message, @"[^\s@]+@[^\s@]+", "[identity]");
        message = Regex.Replace(message, @"""[^""]*""|'[^']*'", "[quoted value]");
        message = Regex.Replace(message, @"[A-Za-z0-9_+/=-]{64,}", "[redacted]");
        return message.Length <= 800 ? message : message[..800] + "...";
    }
    public static HostError Map(Exception error, string phase)
    {
        if (error is HostError known) return known;
        if (phase == "Azure CLI token acquisition") return AzureCliDiagnostics.Map(error);
        var chain = new List<Exception>();
        for (Exception? current = error; current != null && chain.Count < 8; current = current.InnerException) chain.Add(current);
        var text = string.Join("\n", chain.Select(e => e.Message));
        bool Has(string value) => text.Contains(value, StringComparison.OrdinalIgnoreCase);
        var code = "ADOMD_OPERATION_FAILED";
        var hint = "Check endpoint compatibility and the query. Provider messages are withheld because they can contain credentials or result values.";
        if (chain.Any(e => e is FileNotFoundException or DllNotFoundException or TypeLoadException))
        {
            code = "PROVIDER_DEPENDENCY_MISSING";
            hint = "An Analysis Services client dependency could not be loaded. Repair the native companion installation.";
        }
        else if (chain.Any(e => e is Azure.Identity.CredentialUnavailableException))
        {
            code = "AUTHENTICATION_REQUIRED";
            hint = "Azure CLI credentials are unavailable. Install Azure CLI and sign in with az login yourself, then retry. The workbench never starts a login or changes your account.";
        }
        else if (Has("interactive") || Has("user interaction") || Has("MsalUiRequired"))
        {
            code = "AUTHENTICATION_REQUIRED";
            hint = phase == "Azure CLI token acquisition"
                ? "The Azure CLI session requires interactive sign-in or renewed consent. Complete az login yourself, then retry. The workbench does not start a login or change your account."
                : "This connection requires interactive sign-in. For supported Microsoft cloud endpoints, explicitly select Azure CLI authentication and use an already signed-in account.";
        }
        else if (Has("authentication") || Has("AADSTS") || Has("credential") || Has("Msal"))
        {
            code = "AUTHENTICATION_FAILED";
            hint = "The configured identity could not authenticate. Check its sign-in state and endpoint authentication method.";
        }
        else if (Has("workspace") && (Has("not found") || Has("not exist")))
        {
            code = "WORKSPACE_UNAVAILABLE";
            hint = "The workspace could not be resolved for this identity and tenant. Check the XMLA URL, tenant selection, and workspace access.";
        }
        else if (Has("permission") || Has("access denied") || Has("not authorized"))
        {
            code = "ACCESS_DENIED";
            hint = "The identity cannot access this operation. Read/Build permission may allow queries but not administrative schema rowsets.";
        }
        else if (Has("not supported") || Has("unsupported") || Has("not a supported"))
        {
            code = "PROVIDER_UNSUPPORTED";
            var options = new[] { "ReadWriteMode", "Persist Security Info", "Connect Timeout", "Integrated Security", "Provider", "Identity Provider" }.Where(Has);
            hint = "The provider rejected a feature or connection option." + (options.Any() ? " Referenced options: " + string.Join(", ", options) + "." : "");
        }
        var types = string.Join(" -> ", chain.Select(e => e.GetType().Name).Distinct());
        return new(code, $"Failed during {phase}. {hint} Provider: {types} (0x{chain[^1].HResult:X8}).");
    }
}
