using System.Data.Common;

namespace DaxWorkbench.Host;

public sealed class PowerBiRestProfile
{
    public const string Scope = "https://analysis.windows.net/powerbi/api/.default";
    public string? WorkspaceId { get; }
    public string DatasetId { get; }
    public string? TenantId { get; }
    public Uri Endpoint => new($"https://api.powerbi.com/v1.0/myorg/{(WorkspaceId == null ? "" : $"groups/{WorkspaceId}/")}datasets/{DatasetId}/executeQueries");
    private PowerBiRestProfile(string? workspaceId, string datasetId, string? tenantId)
    {
        WorkspaceId = workspaceId;
        DatasetId = datasetId;
        TenantId = tenantId;
    }
    public static PowerBiRestProfile Create(string workspaceId, string datasetId, string? tenantId = null, string authMode = "azure-cli")
    {
        if (authMode != "azure-cli")
            throw new HostError("INVALID_AUTH_MODE", "Power BI REST executeQueries requires explicit azure-cli authentication.");
        return new(Identifier(workspaceId), Identifier(datasetId), tenantId == null ? null : Identifier(tenantId));
    }
    public static PowerBiRestProfile CreateDataset(string datasetId) => new(null, Identifier(datasetId), null);
    private static string Identifier(string value)
    {
        if (value.Length != 36 || !Guid.TryParseExact(value, "D", out var id) || id == Guid.Empty)
            throw new HostError("INVALID_REST_ID", "Power BI REST workspaceId, datasetId and optional tenantId must be nonempty GUIDs in dashed format.");
        return id.ToString("D");
    }
    public string ConnectionString()
    {
        var builder = new DbConnectionStringBuilder
        {
            [NativeConnections.KindKey] = "powerbi-rest",
            ["DaxWorkbench Authentication"] = "azure-cli",
            ["Dataset ID"] = DatasetId
        };
        if (WorkspaceId != null) builder["Workspace ID"] = WorkspaceId;
        if (TenantId != null) builder["Tenant ID"] = TenantId;
        return builder.ConnectionString;
    }
    public static PowerBiRestProfile Read(string connectionString)
    {
        try
        {
            var builder = new DbConnectionStringBuilder { ConnectionString = connectionString };
            string[] allowed = [NativeConnections.KindKey, "DaxWorkbench Authentication", "Workspace ID", "Dataset ID", "Tenant ID"];
            if (builder.Keys.Cast<string>().Any(key => !allowed.Contains(key, StringComparer.OrdinalIgnoreCase)) ||
                !NativeConnections.IsPowerBiRest(connectionString) ||
                !builder.TryGetValue("Dataset ID", out var dataset))
                throw new HostError("INVALID_CONNECTION", "The protected Power BI REST profile is invalid.");
            if (!builder.TryGetValue("Workspace ID", out var workspace))
            {
                if (NativeConnections.Mode(connectionString) != "azure-cli" || builder.ContainsKey("Tenant ID"))
                    throw new HostError("INVALID_CONNECTION", "The dataset-only Power BI REST profile requires the current Azure CLI identity.");
                return CreateDataset(dataset.ToString()!);
            }
            return Create(workspace.ToString()!, dataset.ToString()!,
                builder.TryGetValue("Tenant ID", out var tenant) ? tenant.ToString() : null, NativeConnections.Mode(connectionString));
        }
        catch (HostError) { throw; }
        catch { throw new HostError("INVALID_CONNECTION", "The protected Power BI REST profile is invalid."); }
    }
}
