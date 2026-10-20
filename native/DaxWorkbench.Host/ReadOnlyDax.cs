using DaxWorkbench.Shared;
using System.Text.Json;

namespace DaxWorkbench.Host;

public static class ReadOnlyDax
{
    public sealed record Token(string Text, string Kind);
    public static List<Token> Validate(string query)
    {
        try { return DaxReadOnlyGate.Validate(query).Select(t => new Token(t.Text, t.Kind)).ToList(); }
        catch (DaxGateError error) { throw new HostError(error.Code, error.Message); }
    }
    public static bool IsDemo(List<Token> tokens) =>
        tokens.Count == 2 && tokens[0].Text.Equals("EVALUATE", StringComparison.OrdinalIgnoreCase) &&
        tokens[1].Kind == "identifier" && tokens[1].Text.Equals("Demo Sales", StringComparison.OrdinalIgnoreCase);

    public static List<Token> Lex(string text)
    {
        try { return DaxReadOnlyGate.Lex(text).Select(t => new Token(t.Text, t.Kind)).ToList(); }
        catch (DaxGateError error) { throw new HostError(error.Code, error.Message); }
    }
    public static Dictionary<string, object?> Parameters(JsonElement request)
    {
        var result = new Dictionary<string, object?>();
        if (!request.TryGetProperty("parameters", out var parameters)) return result;
        if (parameters.ValueKind != JsonValueKind.Object) throw new HostError("INVALID_PARAMS", "parameters must be an object.");
        foreach (var property in parameters.EnumerateObject())
        {
            var name = property.Name;
            if (name.Length is < 1 or > 128 || !(char.IsAsciiLetter(name[0]) || name[0] == '_') ||
                name.Any(c => !char.IsAsciiLetterOrDigit(c) && c != '_'))
                throw new HostError("INVALID_PARAMS", "Parameter names must be simple identifiers without @.");
            result[name] = property.Value.ValueKind switch
            {
                JsonValueKind.Null => null,
                JsonValueKind.String => property.Value.GetString(),
                JsonValueKind.True => true,
                JsonValueKind.False => false,
                JsonValueKind.Number when property.Value.TryGetInt64(out var n) => n,
                JsonValueKind.Number when property.Value.TryGetDecimal(out var d) => d,
                _ => throw new HostError("INVALID_PARAMS", "Only finite primitive parameter values are supported.")
            };
            if (result.Count > 256) throw new HostError("INVALID_PARAMS", "Too many query parameters.");
        }
        return result;
    }
}
