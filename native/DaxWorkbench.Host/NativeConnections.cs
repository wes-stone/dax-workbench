using Azure.Core;
using Azure.Identity;
using Microsoft.AnalysisServices.AdomdClient;
using System.Data.Common;

namespace DaxWorkbench.Host;

public static class NativeConnections
{
    private const string AuthenticationKey = "DaxWorkbench Authentication";
    internal const string KindKey = "DaxWorkbench Kind";
    public static bool IsPowerBiRest(string? connectionString)
    {
        if (string.IsNullOrWhiteSpace(connectionString)) return false;
        var builder = new DbConnectionStringBuilder { ConnectionString = connectionString };
        return builder.TryGetValue(KindKey, out var kind) && kind.ToString() == "powerbi-rest";
    }
    public static string Mode(string connectionString)
    {
        var builder = new DbConnectionStringBuilder { ConnectionString = connectionString };
        return builder.TryGetValue(AuthenticationKey, out var mode) ? mode.ToString()! : "connection-string";
    }
    public static string TokenScope(string source)
    {
        if (Uri.TryCreate(source, UriKind.Absolute, out var uri) && uri.UserInfo.Length == 0 &&
            uri.Fragment.Length == 0 && (uri.IsDefaultPort || uri.Port == 443))
        {
            if (uri.Scheme == "powerbi" && uri.Host.Equals("api.powerbi.com", StringComparison.OrdinalIgnoreCase))
                return "https://analysis.windows.net/powerbi/api/.default";
            if (uri.Scheme == "asazure" && uri.Host.EndsWith(".asazure.windows.net", StringComparison.OrdinalIgnoreCase))
                return "https://*.asazure.windows.net/.default";
        }
        var endpoint = uri == null ? "an unrecognized address" : $"{uri.Scheme}://{uri.Host} (port {uri.Port}; URL parameters: {uri.Query.Length != 0}; fragment: {uri.Fragment.Length != 0}; embedded identity: {uri.UserInfo.Length != 0})";
        throw new HostError("UNSUPPORTED_AUTH_ENDPOINT", $"Azure CLI authentication is not supported for {endpoint}. Use a public-cloud Power BI or Azure Analysis Services origin without embedded identity, fragments, or nonstandard ports.");
    }
    public static void Configure(DbConnectionStringBuilder builder, string authMode)
    {
        if (builder.ContainsKey(KindKey))
            throw new HostError("INVALID_CONNECTION", "Transport markers cannot be supplied in an MSOLAP connection string. Register an explicit connection kind instead.");
        if (authMode is not "connection-string" and not "azure-cli")
            throw new HostError("INVALID_AUTH_MODE", "Choose connection-string or azure-cli authentication.");
        builder.Remove(AuthenticationKey);
        if (authMode == "connection-string") return;
        TokenScope(builder["Data Source"].ToString()!);
        Tenant(builder["Data Source"].ToString()!);
        if (new[] { "User ID", "UID", "Password", "PWD" }.Any(key => builder.TryGetValue(key, out var value) && !string.IsNullOrWhiteSpace(value.ToString())))
            throw new HostError("AUTHENTICATION_CONFLICT", "Azure CLI authentication cannot override an embedded user ID or password. Use a credential-free connection string.");
        builder.Remove("Integrated Security");
        builder[AuthenticationKey] = authMode;
    }
    public static string? Tenant(string source)
    {
        if (!Uri.TryCreate(source, UriKind.Absolute, out var uri)) return null;
        var tenants = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (var parameter in uri.Query.TrimStart('?').Split('&', StringSplitOptions.RemoveEmptyEntries))
        {
            var pair = parameter.Split('=', 2);
            var key = Uri.UnescapeDataString(pair[0]);
            if (!new[] { "tenant", "tenantId", "ctid" }.Contains(key, StringComparer.OrdinalIgnoreCase)) continue;
            if (pair.Length != 2 || !Guid.TryParse(Uri.UnescapeDataString(pair[1]), out var tenant))
                throw new HostError("INVALID_AUTH_TENANT", "The endpoint tenant parameter must be a tenant GUID.");
            tenants.Add(tenant.ToString());
        }
        var segments = uri.AbsolutePath.Split('/', StringSplitOptions.RemoveEmptyEntries);
        if (uri.Scheme == "powerbi" && segments.Length >= 2 && segments[0] == "v1.0" && Guid.TryParse(segments[1], out var pathTenant))
            tenants.Add(pathTenant.ToString());
        if (tenants.Count > 1) throw new HostError("INVALID_AUTH_TENANT", "The endpoint contains conflicting tenant identifiers.");
        return tenants.SingleOrDefault();
    }
    public static AdomdConnection Open(string? connectionString, CancellationToken cancellationToken)
    {
        if (string.IsNullOrWhiteSpace(connectionString)) throw new HostError("INVALID_CONNECTION", "A registered native connection is required.");
        if (IsPowerBiRest(connectionString))
            throw new HostError("UNSUPPORTED_CONNECTION", "Power BI REST connections cannot execute through ADOMD/XMLA.");
        if (WindowsMsolapNative.IsProfile(connectionString))
            throw new HostError("WINDOWS_WORKER_REQUIRED", "Windows MSOLAP must execute in its supervised CLR4 worker, never through .NET 10 ADOMD or COM.");
        var builder = new DbConnectionStringBuilder { ConnectionString = connectionString };
        var mode = Mode(connectionString);
        builder.Remove(AuthenticationKey);
        if (mode is not "connection-string" and not "azure-cli") throw new HostError("INVALID_AUTH_MODE", "The saved authentication mode is unsupported.");
        var connection = new AdomdConnection(builder.ConnectionString);
        var phase = "opening connection";
        string? accessToken = null;
        try
        {
            if (mode == "azure-cli")
            {
                phase = "Azure CLI token acquisition";
                var scope = TokenScope(builder["Data Source"].ToString()!);
                var credential = new AzureCliCredential(new AzureCliCredentialOptions {
                    ProcessTimeout = TimeSpan.FromSeconds(20), TenantId = Tenant(builder["Data Source"].ToString()!)
                });
                var token = AzureCliDiagnostics.GetToken(credential, new TokenRequestContext([scope]), cancellationToken);
                accessToken = token.Token;
                connection.AccessToken = new(token.Token, token.ExpiresOn);
            }

            phase = "opening connection";
            cancellationToken.ThrowIfCancellationRequested();
            connection.Open();
            return connection;
        }
        catch (OperationCanceledException) { connection.Dispose(); throw; }
        catch (Exception error)
        {
            connection.Dispose();
            var safe = ProviderErrors.Map(error, phase);
            if (mode == "azure-cli" && phase == "opening connection" && error is AdomdConnectionException)
                safe = new HostError(safe.Code, safe.Message + $" Authentication tenant: {(Tenant(builder["Data Source"].ToString()!) == null ? "Azure CLI default" : "endpoint-specified")}. Connection detail (redacted): " +
                    ProviderErrors.ConnectionDetail(error.Message, [accessToken ?? "", connectionString, builder["Data Source"].ToString()!]));
            throw safe;
        }
    }
}
