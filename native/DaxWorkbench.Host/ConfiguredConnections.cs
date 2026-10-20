using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using YamlDotNet.RepresentationModel;

namespace DaxWorkbench.Host;

public sealed record ConnectionDiscoveryIssue(string Name, string Code, string Message);
public sealed record ConnectionDiscovery(string Status, int Loaded, List<ConnectionDiscoveryIssue> Issues);
public sealed record ConfiguredConnectionResult(List<ConnectionDescriptor> Connections, ConnectionDiscovery Discovery);

public sealed partial class ConnectionRegistry
{
    private const string ConfiguredDirectoryKey = "native:configured-connections";
    private List<RegistryEntry> configured = [];
    private bool configuredRestored;
    public ConnectionDiscovery? ConfiguredDiscovery { get; private set; }

    private void RestoreConfigured()
    {
        lock (discoveryGate)
        {
            if (configuredRestored) return;
            configuredRestored = true;
            var record = Json.Element(store.Read(ConfiguredDirectoryKey)).GetProperty("value");
            if (record.ValueKind == JsonValueKind.Null) return;
            try { SyncConfigured(record.Required("directory"), remember: false); }
            catch (Exception error) when (error is HostError or IOException or UnauthorizedAccessException)
            {
                ConfiguredDiscovery = new("unavailable", 0,
                    [new("Configured profiles", "DISCOVERY_UNAVAILABLE", "The saved profile folder is unavailable. Refresh DAX MCP connections to retry.")]);
            }
        }
    }

    public ConfiguredConnectionResult SyncConfigured(string directory, bool remember = true)
    {
        lock (discoveryGate)
        {
            // Read local configuration only; discovery must never contact a model or a network share.
            if (!Path.IsPathFullyQualified(directory) || directory.StartsWith(@"\\", StringComparison.Ordinal)
                || new DriveInfo(Path.GetPathRoot(directory)!).DriveType == DriveType.Network)
                throw new HostError("INVALID_DIRECTORY", "Configured connections require an absolute local folder, not a network share.");
            if (!Directory.Exists(directory))
                throw new HostError("INVALID_DIRECTORY", "The configured DAX MCP profile folder is unavailable on this host.");
            for (var parent = new DirectoryInfo(directory); parent != null; parent = parent.Parent)
                if ((parent.Attributes & FileAttributes.ReparsePoint) != 0)
                    throw new HostError("INVALID_DIRECTORY", "Linked configured-profile folders are not supported.");
            var files = Directory.EnumerateFiles(directory)
                .Where(file => Path.GetExtension(file).Equals(".yaml", StringComparison.OrdinalIgnoreCase)
                    || Path.GetExtension(file).Equals(".yml", StringComparison.OrdinalIgnoreCase))
                .Where(file => !Path.GetFileNameWithoutExtension(file).EndsWith(".data_dictionary", StringComparison.OrdinalIgnoreCase)
                    && !Path.GetFileNameWithoutExtension(file).Equals("sample_connection", StringComparison.OrdinalIgnoreCase))
                .Order(StringComparer.OrdinalIgnoreCase).Take(101).ToList();
            if (files.Count > 100) throw new HostError("IMPORT_LIMIT", "Discover at most 100 configured YAML profiles at once.");
            var entries = new List<RegistryEntry>();
            var issues = new List<ConnectionDiscoveryIssue>();
            var saved = store.Connections().ToDictionary(entry => entry.Id, StringComparer.Ordinal);
            var duplicates = files.GroupBy(Path.GetFileNameWithoutExtension, StringComparer.OrdinalIgnoreCase)
                .Where(group => group.Count() > 1).Select(group => group.Key).ToHashSet(StringComparer.OrdinalIgnoreCase);
            long total = 0;
            var loaded = 0;
            foreach (var file in files)
            {
                var name = Path.GetFileNameWithoutExtension(file);
                try
                {
                    ValidateName(name);
                    if (duplicates.Contains(name)) throw new HostError("DUPLICATE_PROFILE", "Duplicate profile filename.");
                    var info = new FileInfo(file);
                    if ((info.Attributes & FileAttributes.ReparsePoint) != 0)
                        throw new HostError("INVALID_DIRECTORY", "Linked configured profiles are not supported.");
                    total += info.Length;
                    if (info.Length > 1_048_576 || total > 8_388_608)
                        throw new HostError("IMPORT_LIMIT", "Configured profiles exceed the discovery size limit.");
                    var yaml = new YamlStream();
                    using var reader = new StreamReader(file);
                    yaml.Load(reader);
                    if (yaml.Documents.Count != 1 || yaml.Documents[0].RootNode is not YamlMappingNode node)
                        throw new HostError("INVALID_BUNDLE", "A configured profile must contain one mapping.");
                    var hash = Hash(Path.GetFullPath(file).ToUpperInvariant() + "\n" + name);
                    var type = Scalar(node, "transport")?.ToLowerInvariant() ?? "msolap";
                    RegistryEntry entry;
                    if (type == "powerbi_rest")
                    {
                        if ((Scalar(node, "auth_mode") ?? "azure_cli") != "azure_cli"
                            || (Scalar(node, "api_base_url") ?? "https://api.powerbi.com/v1.0/myorg").TrimEnd('/') != "https://api.powerbi.com/v1.0/myorg"
                            || !string.IsNullOrWhiteSpace(Scalar(node, "impersonated_user_name")))
                            throw new HostError("UNSUPPORTED_REST_PROFILE", "This REST authentication, endpoint or impersonation is unsupported.");
                        var profile = PowerBiRestProfile.CreateDataset(Scalar(node, "dataset_id") ?? "");
                        var bytes = Encoding.UTF8.GetBytes(profile.ConnectionString());
                        try { entry = new("configured:powerbi-rest:" + hash, name, "powerbi-rest", profile.DatasetId, LocalStore.Protect(bytes)); }
                        finally { CryptographicOperations.ZeroMemory(bytes); }
                    }
                    else if (type == "msolap")
                    {
                        entry = Create(name, Scalar(node, "connection_string") ?? "", kind: "windows-msolap", id: "import:windows-msolap:" + hash);
                        // Explicitly imported provider/authentication choices take precedence over auto-discovery.
                        if (saved.TryGetValue(entry.Id, out var existing)
                            || saved.TryGetValue("import:" + hash, out existing) && existing.Kind != "rest")
                            entry = existing;
                    }
                    else throw new HostError("UNSUPPORTED_BUNDLE", "This configured transport is unsupported.");
                    entries.Add(entry);
                    loaded++;
                }
                catch (Exception error) when (error is HostError or YamlDotNet.Core.YamlException or IOException or UnauthorizedAccessException or ArgumentException)
                {
                    var code = error is HostError host ? host.Code : "INVALID_BUNDLE";
                    var safeName = name.Length <= 200 && !name.Any(char.IsControl) ? name : "Invalid profile filename";
                    issues.Add(new(safeName, code, code switch
                    {
                        "UNSUPPORTED_REST_PROFILE" => "REST requires the configured Azure CLI identity and public endpoint, without impersonation. No authentication fallback was attempted.",
                        "DUPLICATE_PROFILE" => "Both YAML extensions define this name. Keep one profile to avoid ambiguity.",
                        "IMPORT_LIMIT" => "This profile exceeds the bounded discovery size limit.",
                        _ => "This profile could not be loaded by the native reader. Mock, invalid and unsupported profiles are not executable."
                    }));
                }
            }
            if (remember)
            {
                var record = Json.Element(store.Read(ConfiguredDirectoryKey));
                if (record.GetProperty("value").ValueKind == JsonValueKind.Null
                    || record.GetProperty("value").Required("directory") != directory)
                    store.Write(ConfiguredDirectoryKey, record.GetProperty("revision").GetInt64(), Json.Element(new { directory }));
            }
            configured = entries;
            configuredRestored = true;
            ConfiguredDiscovery = new(issues.Count == 0 ? "ready" : "partial", loaded, issues);
            return new(List(), ConfiguredDiscovery);
        }
    }
}
