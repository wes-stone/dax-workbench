using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Microsoft.Data.Sqlite;

namespace DaxWorkbench.Host;

public sealed class LocalStore
{
    private readonly string connectionString;
    private static readonly byte[] Entropy = Encoding.UTF8.GetBytes("DaxWorkbench.Native.Store.v1");
    public LocalStore(string artifacts)
    {
        if (!Path.IsPathFullyQualified(artifacts)) throw new HostError("INVALID_ARTIFACTS", "--artifacts requires an absolute directory.");
        Directory.CreateDirectory(artifacts);
        connectionString = new SqliteConnectionStringBuilder
        {
            DataSource = Path.Combine(artifacts, "workbench.sqlite3"),
            Mode = SqliteOpenMode.ReadWriteCreate, Pooling = false, DefaultTimeout = 5
        }.ToString();
        using var db = Open();
        using var command = db.CreateCommand();
        command.CommandText = """
            PRAGMA journal_mode=WAL;
            CREATE TABLE IF NOT EXISTS records (
              key TEXT PRIMARY KEY, revision INTEGER NOT NULL, payload BLOB NOT NULL
            );
            CREATE TABLE IF NOT EXISTS connections (
              id TEXT PRIMARY KEY, name TEXT NOT NULL, kind TEXT NOT NULL,
              model TEXT, secret BLOB NOT NULL
            );
            """;
        command.ExecuteNonQuery();
    }
    private SqliteConnection Open()
    {
        var connection = new SqliteConnection(connectionString);
        connection.Open();
        return connection;
    }
    internal static byte[] Protect(byte[] value) => ProtectedData.Protect(value, Entropy, DataProtectionScope.CurrentUser);
    internal static byte[] Unprotect(byte[] value) => ProtectedData.Unprotect(value, Entropy, DataProtectionScope.CurrentUser);
    public object Read(string key)
    {
        CheckKey(key);
        using var db = Open();
        using var command = db.CreateCommand();
        command.CommandText = "SELECT revision,payload FROM records WHERE key=$key";
        command.Parameters.AddWithValue("$key", key);
        using var reader = command.ExecuteReader();
        if (!reader.Read()) return new { value = (object?)null, revision = 0 };
        var plaintext = Unprotect((byte[])reader[1]);
        try
        {
            using var document = JsonDocument.Parse(plaintext);
            return new { value = document.RootElement.Clone(), revision = reader.GetInt64(0) };
        }
        finally { CryptographicOperations.ZeroMemory(plaintext); }
    }
    public object Write(string key, long expectedRevision, JsonElement value)
    {
        CheckKey(key);
        if (expectedRevision < 0 || expectedRevision >= 9_007_199_254_740_991L)
            throw new HostError("INVALID_PARAMS", "Invalid expectedRevision.");
        if (value.ValueKind != JsonValueKind.Object && value.ValueKind != JsonValueKind.Null)
            throw new HostError("INVALID_PARAMS", "Stored value must be an object or null.");
        var plaintext = Json.Bytes(value);
        if (plaintext.Length > 1_500_000) throw new HostError("STORE_TOO_LARGE", "Stored value exceeds the 1.5 MB limit.");
        byte[] payload;
        try { payload = Protect(plaintext); }
        finally { CryptographicOperations.ZeroMemory(plaintext); }
        using var db = Open();
        using var transaction = db.BeginTransaction(deferred: false);
        using var command = db.CreateCommand();
        command.Transaction = transaction;
        command.CommandText = expectedRevision == 0
            ? "INSERT INTO records(key,revision,payload) VALUES($key,1,$payload) ON CONFLICT(key) DO NOTHING"
            : "UPDATE records SET revision=revision+1,payload=$payload WHERE key=$key AND revision=$expected";
        command.Parameters.AddWithValue("$key", key);
        command.Parameters.AddWithValue("$payload", payload);
        if (expectedRevision != 0) command.Parameters.AddWithValue("$expected", expectedRevision);
        if (command.ExecuteNonQuery() != 1) throw new HostError("STORE_CONFLICT", "The saved state changed. Read the latest revision and retry.");
        transaction.Commit();
        return new { revision = expectedRevision + 1 };
    }
    public List<RegistryEntry> Connections()
    {
        using var db = Open();
        using var command = db.CreateCommand();
        command.CommandText = "SELECT id,name,kind,model,secret FROM connections ORDER BY name,id";
        using var reader = command.ExecuteReader();
        var result = new List<RegistryEntry>();
        while (reader.Read())
            result.Add(new(reader.GetString(0), reader.GetString(1), reader.GetString(2),
                reader.IsDBNull(3) ? null : reader.GetString(3), (byte[])reader[4]));
        return result;
    }
    public void AddConnections(IEnumerable<RegistryEntry> entries)
    {
        using var db = Open();
        using var transaction = db.BeginTransaction(deferred: false);
        foreach (var entry in entries)
        {
            using var command = db.CreateCommand();
            command.Transaction = transaction;
            command.CommandText = """
                INSERT INTO connections(id,name,kind,model,secret) VALUES($id,$name,$kind,$model,$secret)
                ON CONFLICT(id) DO UPDATE SET name=excluded.name,kind=excluded.kind,model=excluded.model,secret=excluded.secret
                """;
            command.Parameters.AddWithValue("$id", entry.Id);
            command.Parameters.AddWithValue("$name", entry.Name);
            command.Parameters.AddWithValue("$kind", entry.Kind);
            command.Parameters.AddWithValue("$model", (object?)entry.Model ?? DBNull.Value);
            command.Parameters.AddWithValue("$secret", entry.Secret);
            command.ExecuteNonQuery();
        }
        transaction.Commit();
    }
    private static void CheckKey(string key)
    {
        if (key.Length is < 1 or > 256 || key.Any(char.IsControl))
            throw new HostError("INVALID_PARAMS", "Invalid store key.");
    }
}
