using System.Data.Common;

namespace DaxWorkbench.Host;

public sealed record ConnectionProperty(string Name, string Value, bool Redacted);
public sealed record ConnectionDetails(string ConnectionId, string Source, string Authentication,
    string? ConnectionString, List<ConnectionProperty> Properties, string Notice);

public sealed partial class ConnectionRegistry
{
    public ConnectionDetails Inspect(string id)
    {
        if (id == DemoId)
            return new(id, "Built-in demo", "None", null, [],
                "Synthetic data only. This profile has no server or connection string.");
        var entry = Resolve(id)!;
        var saved = store.Connections().Any(item => item.Id == id);
        var source = saved ? "Saved Workbench profile" : entry.Kind == "desktop" ? "Power BI Desktop discovery" : "DAX MCP configuration";
        var text = entry.ConnectionString();
        var mode = NativeConnections.Mode(text);
        var builder = entry.Kind == "windows-msolap" ? WindowsMsolapNative.ReadProfile(text)
            : new DbConnectionStringBuilder { ConnectionString = text };
        builder.Remove(NativeConnections.KindKey);
        builder.Remove("DaxWorkbench Authentication");
        var properties = RedactedProperties(builder);
        if (entry.Kind == "powerbi-rest")
        {
            var rest = PowerBiRestProfile.Read(text);
            properties.Insert(0, new("Endpoint", rest.Endpoint.AbsoluteUri, false));
            return new(id, source, "Azure CLI (current signed-in account)", null, properties,
                "REST uses these IDs and the fixed Execute Queries endpoint, not an XMLA connection string. No token is retrieved when inspecting settings.");
        }
        var display = new DbConnectionStringBuilder();
        foreach (var property in properties) display[property.Name] = property.Value;
        return new(id, source, mode == "azure-cli" ? "Azure CLI (current signed-in account)" : "Connection string / provider identity",
            display.ConnectionString, properties,
            "Registered native configuration, with credentials and unrecognized property values redacted. Provider defaults are not inferred. Runtime query limits and no-prompt policy still apply.");
    }

    internal static List<ConnectionProperty> RedactedProperties(DbConnectionStringBuilder builder)
    {
        string[] visible = ["Data Source", "Initial Catalog", "Cube", "Provider", "Integrated Security",
            "Application Name", "Connect Timeout", "Connection Timeout", "Persist Security Info",
            "ReadWriteMode", "Locale Identifier", "Workspace ID", "Dataset ID", "Tenant ID"];
        var result = new List<ConnectionProperty>();
        foreach (string key in builder.Keys)
        {
            var value = builder[key].ToString() ?? "";
            var redacted = !visible.Contains(key, StringComparer.OrdinalIgnoreCase);
            if (redacted) value = "[REDACTED]";
            else if (key.Equals("Data Source", StringComparison.OrdinalIgnoreCase))
            {
                // Endpoint URLs can carry credentials outside the usual Password property.
                if (Uri.TryCreate(value, UriKind.Absolute, out var uri) && !uri.IsFile
                    && (uri.UserInfo.Length > 0 || uri.Query.Length > 0 || uri.Fragment.Length > 0))
                {
                    var address = new UriBuilder(uri) { UserName = "", Password = "", Query = "", Fragment = "" };
                    value = address.Uri.AbsoluteUri;
                    redacted = true;
                }
            }
            result.Add(new(key, value, redacted));
        }
        return result;
    }
}
