using System.Data.Common;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using YamlDotNet.RepresentationModel;

namespace DaxWorkbench.Host;

public sealed record RegistryEntry(string Id, string Name, string Kind, string? Model, byte[] Secret)
{
    public string ConnectionString()
    {
        var plaintext = LocalStore.Unprotect(Secret);
        try { return Encoding.UTF8.GetString(plaintext); }
        finally { CryptographicOperations.ZeroMemory(plaintext); }
    }
    public ConnectionDescriptor Descriptor() => new(Id, Name, Kind, Model, ConnectionRegistry.Capabilities(Kind), NativeConnections.Mode(ConnectionString()));
}

public sealed partial class ConnectionRegistry(LocalStore store)
{
    public const string DemoId = "demo:contoso";
    private readonly object discoveryGate = new();
    private List<RegistryEntry> discovered = [];
    public static Dictionary<string, Capability> Capabilities(string kind)
    {
        if (kind == "windows-msolap")
            return new()
            {
                ["query"] = new("supported", "Explicit x64 CLR4 OS-provider execution with prompting disabled and a shared read-only DAX guard. Requires installed MSOLAP and an existing usable provider session. Native parameters are unsupported."),
                ["schema"] = new("supported", "Fixed read-only TMSCHEMA table/column/measure/relationship discovery, with reader MDSCHEMA attribute/level fallback. Returned coverage explicitly identifies unavailable hidden fields, types, relationships and builder dependencies/hierarchies. No data samples or arbitrary DMV/XMLA commands."),
                ["diagnostics"] = new("unsupported", "Windows MSOLAP server timings and query plans are not exposed."),
                ["traces"] = new("unsupported", "Windows MSOLAP trace sessions are disabled."),
                ["cache"] = new("unsupported", "Windows MSOLAP cache mutation is disabled."),
                ["vpax"] = new("unsupported", "VPAX/model storage metadata is not available in the reader transport."),
                ["modelWrites"] = new("unsupported", "Model writes, XMLA commands and administrative queries are blocked.")
            };
        if (kind == "powerbi-rest")
            return new()
            {
                ["query"] = new("supported", "Explicit Power BI REST executeQueries, not XMLA: one EVALUATE/table, no native parameters; service limits 100000 rows, 1000000 values and 15 MB; local limits also apply."),
                ["schema"] = new("unsupported", PowerBiRest.SchemaWarning),
                ["diagnostics"] = new("unsupported", "Power BI REST executeQueries does not expose server timings or query plans."),
                ["traces"] = new("unsupported", "Power BI REST executeQueries does not expose trace sessions."),
                ["cache"] = new("unsupported", "Power BI REST executeQueries does not support cache mutation."),
                ["vpax"] = new("unsupported", "Power BI REST executeQueries does not expose VPAX/model storage metadata."),
                ["modelWrites"] = new("unsupported", "Power BI REST connection supports read-only executeQueries only; model writes, XMLA and administration are unavailable.")
            };
        var supported = kind is "msolap" or "desktop" or "synthetic";
        var reason = kind == "synthetic" ? Demo.Limitation
            : supported ? "Read-only ADOMD execution; authentication and model access are checked only on explicit use."
            : "REST-only connection is unsupported by the native ADOMD companion.";
        return new()
        {
            ["query"] = new(supported ? "supported" : "unsupported", reason),
            ["schema"] = new(supported ? "supported" : "unsupported", reason),
            ["diagnostics"] = new("unsupported", "Native diagnostics are not implemented in protocol v1."),
            ["traces"] = new("unsupported", "Trace sessions are disabled in this release."),
            ["cache"] = new("unsupported", "Cache mutation is disabled in this release."),
            ["vpax"] = new("unsupported", "VPAX is not implemented in this release."),
            ["modelWrites"] = new("unsupported", "Model writes and raw XMLA are disabled.")
        };
    }
    public List<ConnectionDescriptor> List()
    {
        RestoreConfigured();
        var result = new List<ConnectionDescriptor>
        {
            new(DemoId, "Contoso (synthetic demo)", "synthetic", "Demo Sales", Capabilities("synthetic"))
        };
        result.AddRange(store.Connections().Select(e => e.Descriptor()));
        lock (discoveryGate)
        {
            result.AddRange(discovered.Select(e => e.Descriptor()));
            var saved = result.Select(e => e.Id).ToHashSet(StringComparer.Ordinal);
            result.AddRange(configured.Where(e => !saved.Contains(e.Id)).Select(e => e.Descriptor()));
        }
        return result;
    }
    public RegistryEntry? Resolve(string id)
    {
        if (id == DemoId) return null;
        RestoreConfigured();
        RegistryEntry? entry;
        lock (discoveryGate) entry = discovered.FirstOrDefault(e => e.Id == id);
        entry ??= store.Connections().FirstOrDefault(e => e.Id == id);
        lock (discoveryGate) entry ??= configured.FirstOrDefault(e => e.Id == id);
        if (entry == null) throw new HostError("CONNECTION_NOT_FOUND", "The selected connection is unavailable.");
        if (entry.Kind == "rest") throw new HostError("UNSUPPORTED_CONNECTION", "REST-only connections cannot execute through ADOMD.");
        if (entry.Kind == "desktop" && !DesktopDiscovery.IsStillAvailable(entry.Id))
            throw new HostError("CONNECTION_UNAVAILABLE", "The discovered Power BI Desktop instance has closed or changed.");
        return entry;
    }
    public ConnectionDescriptor Add(string name, string connectionString, string authMode = "connection-string")
    {
        var entry = Create(name, connectionString, authMode: authMode);
        store.AddConnections([entry]);
        return entry.Descriptor();
    }
    public ConnectionDescriptor Add(JsonElement parameters)
    {
        var kind = parameters.TryGetProperty("kind", out _) ? parameters.Required("kind", 30) : "msolap";
        var authMode = parameters.TryGetProperty("authMode", out _) ? parameters.Required("authMode", 30) : "connection-string";
        if (kind == "windows-msolap")
        {
            string[] allowedWindows = ["kind", "name", "connectionString", "authMode"];
            var keys = new HashSet<string>(StringComparer.Ordinal);
            foreach (var property in parameters.EnumerateObject())
                if (!allowedWindows.Contains(property.Name, StringComparer.Ordinal) || !keys.Add(property.Name))
                    throw new HostError("INVALID_PARAMS", "Windows MSOLAP accepts only kind, name, connectionString and authMode.");
            var entry = Create(parameters.Required("name", 200), parameters.Required("connectionString", 32768), kind: kind, authMode: authMode);
            store.AddConnections([entry]);
            return entry.Descriptor();
        }
        if (kind == "msolap")
            return Add(parameters.Required("name", 200), parameters.Required("connectionString", 32768), authMode);
        if (kind != "powerbi-rest")
            throw new HostError("UNSUPPORTED_CONNECTION", "Register msolap, windows-msolap or powerbi-rest explicitly.");
        string[] allowed = ["kind", "name", "workspaceId", "datasetId", "tenantId", "authMode"];
        var seen = new HashSet<string>(StringComparer.Ordinal);
        foreach (var property in parameters.EnumerateObject())
            if (!allowed.Contains(property.Name, StringComparer.Ordinal) || !seen.Add(property.Name))
                throw new HostError("INVALID_PARAMS", "Power BI REST accepts only kind, name, workspaceId, datasetId, optional tenantId and authMode; duplicate fields are not allowed.");
        return AddPowerBiRest(parameters.Required("name", 200), parameters.Required("workspaceId", 36),
            parameters.Required("datasetId", 36),
            parameters.TryGetProperty("tenantId", out _) ? parameters.Required("tenantId", 36) : null, authMode);
    }
    public ConnectionDescriptor AddPowerBiRest(string name, string workspaceId, string datasetId, string? tenantId = null, string authMode = "azure-cli")
    {
        ValidateName(name);
        var profile = PowerBiRestProfile.Create(workspaceId, datasetId, tenantId, authMode);
        var bytes = Encoding.UTF8.GetBytes(profile.ConnectionString());
        try
        {
            var entry = new RegistryEntry("named:" + Guid.NewGuid().ToString("N"), name, "powerbi-rest", profile.DatasetId, LocalStore.Protect(bytes));
            store.AddConnections([entry]);
            return entry.Descriptor();
        }
        finally { CryptographicOperations.ZeroMemory(bytes); }
    }
    private static void ValidateName(string name)
    {
        if (name.Length is < 1 or > 200 || name.Any(char.IsControl))
            throw new HostError("INVALID_PARAMS", "Connection names must contain 1–200 printable characters.");
    }
    internal static RegistryEntry Create(string name, string connectionString, string kind = "msolap", string? id = null, string authMode = "connection-string")
    {
        ValidateName(name);
        if (kind == "windows-msolap")
        {
            var profile = WindowsMsolapNative.CreateProfile(connectionString, authMode);
            var builder = WindowsMsolapNative.ReadProfile(profile);
            var model = builder.TryGetValue("Initial Catalog", out var catalog) ? catalog.ToString() : null;
            var bytes = Encoding.UTF8.GetBytes(profile);
            try { return new(id ?? "named:" + Guid.NewGuid().ToString("N"), name, kind, model, LocalStore.Protect(bytes)); }
            finally { CryptographicOperations.ZeroMemory(bytes); }
        }
        try
        {
            var builder = new DbConnectionStringBuilder { ConnectionString = connectionString };
            if (!builder.TryGetValue("Data Source", out var source) || string.IsNullOrWhiteSpace(source.ToString()))
                throw new HostError("INVALID_CONNECTION", "An ADOMD connection requires Data Source.");
            if (builder.TryGetValue("Provider", out var provider) &&
                !provider.ToString()!.StartsWith("MSOLAP", StringComparison.OrdinalIgnoreCase))
                throw new HostError("UNSUPPORTED_CONNECTION", "Only MSOLAP/ADOMD connections are supported.");
            builder.Remove("Provider");
            builder["Application Name"] = "DaxWorkbench.Native";
            builder["ReadWriteMode"] = "ReadOnly";
            builder["Connect Timeout"] = 15;
            builder["Persist Security Info"] = false;
            NativeConnections.Configure(builder, authMode);
            var model = builder.TryGetValue("Initial Catalog", out var catalog) ? catalog.ToString() : null;
            var bytes = Encoding.UTF8.GetBytes(builder.ConnectionString);
            try
            {
                return new(id ?? "named:" + Guid.NewGuid().ToString("N"), name, kind, model, LocalStore.Protect(bytes));
            }
            finally { CryptographicOperations.ZeroMemory(bytes); }
        }
        catch (HostError) { throw; }
        catch { throw new HostError("INVALID_CONNECTION", "The supplied connection string could not be parsed."); }
    }
    public List<ConnectionDescriptor> Discover()
    {
        var entries = DesktopDiscovery.Discover();
        lock (discoveryGate) discovered = entries;
        return List();
    }
    public List<ConnectionDescriptor> Import(string directory, string? connectionName = null, string authMode = "connection-string", string kind = "msolap")
    {
        if (kind is not "msolap" and not "windows-msolap")
            throw new HostError("UNSUPPORTED_CONNECTION", "Import kind must be msolap or explicit windows-msolap; REST imports remain unsupported placeholders.");
        if (kind == "windows-msolap" && authMode != "connection-string")
            throw new HostError("INVALID_AUTH_MODE", "Windows MSOLAP import supports only connection-string authentication.");
        if (!Path.IsPathFullyQualified(directory) || !Directory.Exists(directory))
            throw new HostError("INVALID_DIRECTORY", "Select an existing absolute YAML bundle directory.");
        var info = new DirectoryInfo(directory);
        if ((info.Attributes & FileAttributes.ReparsePoint) != 0)
            throw new HostError("INVALID_DIRECTORY", "Linked import directories are not supported.");
        var files = Directory.EnumerateFiles(directory)
            .Where(p => Path.GetExtension(p).Equals(".yaml", StringComparison.OrdinalIgnoreCase) ||
                        Path.GetExtension(p).Equals(".yml", StringComparison.OrdinalIgnoreCase))
            .Where(p => connectionName != null
                ? Path.GetFileNameWithoutExtension(p).Equals(connectionName, StringComparison.OrdinalIgnoreCase)
                : !Path.GetFileNameWithoutExtension(p).EndsWith(".data_dictionary", StringComparison.OrdinalIgnoreCase))
            .Order(StringComparer.OrdinalIgnoreCase).Take(101).ToList();
        if (files.Count == 0) throw new HostError("IMPORT_EMPTY", "No matching connection bundles were found in the selected directory.");
        if (files.Count > 100) throw new HostError("IMPORT_LIMIT", "Import at most 100 YAML files at once.");
        var entries = new List<RegistryEntry>();
        long total = 0;
        foreach (var file in files)
        {
            var fi = new FileInfo(file);
            if ((fi.Attributes & FileAttributes.ReparsePoint) != 0)
                throw new HostError("INVALID_DIRECTORY", "Linked YAML files are not supported.");
            total += fi.Length;
            if (fi.Length > 1_048_576 || total > 8_388_608)
                throw new HostError("IMPORT_LIMIT", "YAML bundle size exceeds the import limit.");
            try
            {
                var yaml = new YamlStream();
                using var reader = new StreamReader(file);
                yaml.Load(reader);
                if (yaml.Documents.Count != 1 || yaml.Documents[0].RootNode is not YamlMappingNode root)
                    throw new HostError("INVALID_BUNDLE", "A YAML bundle must contain one mapping document.");
                var nodes = BundleConnections(root, Path.GetFileNameWithoutExtension(file));
                foreach (var (name, node) in nodes)
                {
                    if (entries.Count >= 500) throw new HostError("IMPORT_LIMIT", "At most 500 connections may be imported.");
                    var type = Scalar(node, "transport", "type", "kind", "connection_type")?.ToLowerInvariant() ?? "msolap";
                    var actualName = Scalar(node, "name") ?? name;
                    var identity = (kind == "windows-msolap" ? "import:windows-msolap:" : "import:") + Hash(Path.GetFullPath(file).ToUpperInvariant() + "\n" + actualName);
                    if (type.Contains("rest", StringComparison.Ordinal) || type is "powerbi" or "powerbi_api")
                    {
                        if (kind == "windows-msolap") throw new HostError("UNSUPPORTED_BUNDLE", "REST bundles cannot be imported as Windows MSOLAP.");
                        entries.Add(new(identity, actualName, "rest", null, LocalStore.Protect([])));
                        continue;
                    }
                    if (type is not "msolap" and not "adomd" and not "xmla" and not "ssas")
                        throw new HostError("UNSUPPORTED_BUNDLE", "The YAML bundle uses an unsupported connection type.");
                    var connection = Scalar(node, "connection_string", "connectionString");
                    if (connection == null && Child(node, "connection") is YamlScalarNode scalar) connection = scalar.Value;
                    if (connection == null && Child(node, "connection") is YamlMappingNode nested)
                        connection = Scalar(nested, "connection_string", "connectionString");
                    if (string.IsNullOrWhiteSpace(connection))
                        throw new HostError("INVALID_BUNDLE", "An MSOLAP YAML connection requires connection_string.");
                    entries.Add(Create(actualName, connection, kind: kind, id: identity, authMode: authMode));
                }
            }
            catch (HostError) { throw; }
            catch { throw new HostError("INVALID_BUNDLE", "A YAML bundle could not be imported. No connections were changed."); }
        }
        if (entries.Select(e => e.Id).Distinct().Count() != entries.Count)
            throw new HostError("INVALID_BUNDLE", "A bundle contains duplicate connection names.");
        store.AddConnections(entries);
        return List();
    }
    private static IEnumerable<(string Name, YamlMappingNode Node)> BundleConnections(YamlMappingNode root, string fallback)
    {
        var connections = Child(root, "connections");
        if (connections is YamlSequenceNode list)
        {
            foreach (var node in list.Children)
            {
                if (node is not YamlMappingNode mapping) throw new HostError("INVALID_BUNDLE", "Connections must be mappings.");
                yield return (Scalar(mapping, "name") ?? fallback, mapping);
            }
        }
        else if (connections is YamlMappingNode map)
        {
            foreach (var pair in map.Children)
            {
                if (pair.Key is not YamlScalarNode key || pair.Value is not YamlMappingNode mapping)
                    throw new HostError("INVALID_BUNDLE", "Named connections must be mappings.");
                yield return (key.Value ?? fallback, mapping);
            }
        }
        else if (Child(root, "connection") is YamlMappingNode nested)
        {
            var combined = new YamlMappingNode();
            foreach (var pair in root.Children) combined.Children[pair.Key] = pair.Value;
            foreach (var pair in nested.Children)
                if (!combined.Children.ContainsKey(pair.Key)) combined.Children[pair.Key] = pair.Value;
            yield return (Scalar(root, "name") ?? Scalar(nested, "name") ?? fallback, combined);
        }
        else yield return (Scalar(root, "name") ?? fallback, root);
    }
    private static YamlNode? Child(YamlMappingNode node, string name) =>
        node.Children.TryGetValue(new YamlScalarNode(name), out var child) ? child : null;
    private static string? Scalar(YamlMappingNode node, params string[] names) =>
        names.Select(name => Child(node, name)).OfType<YamlScalarNode>().Select(n => n.Value).FirstOrDefault();
    public static string Hash(string value) => Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(value))).ToLowerInvariant();
    public static string LockIdentity(string id, string? connectionString)
    {
        if (id == DemoId) return id;
        if (NativeConnections.IsPowerBiRest(connectionString))
        {
            var profile = PowerBiRestProfile.Read(connectionString!);
            return "powerbi-rest\n" + profile.WorkspaceId + "\n" + profile.DatasetId;
        }
        var builder = new DbConnectionStringBuilder { ConnectionString = connectionString! };
        var source = builder["Data Source"].ToString()!.Trim().TrimEnd('/').ToLowerInvariant();
        if (source.StartsWith("127.0.0.1:", StringComparison.Ordinal)) source = "localhost:" + source[10..];
        var catalog = builder.TryGetValue("Initial Catalog", out var value) ? value.ToString()!.Trim().ToLowerInvariant() : "";
        return source + "\n" + catalog;
    }
}
