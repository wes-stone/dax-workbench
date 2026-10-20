using System;
using System.Collections.Generic;
using System.Text;

namespace DaxWorkbench.Shared
{
    public sealed class DaxGateError : Exception
    {
        public string Code { get; private set; }
        public DaxGateError(string code, string message) : base(message) { Code = code; }
    }
    public sealed class DaxToken
    {
        public string Text { get; private set; }
        public string Kind { get; private set; }
        public DaxToken(string text, string kind) { Text = text; Kind = kind; }
    }
    public static class DaxReadOnlyGate
    {
        private static readonly HashSet<string> Denied = new HashSet<string>(StringComparer.OrdinalIgnoreCase)
        {
            "SELECT", "CREATE", "ALTER", "DROP", "DELETE", "INSERT", "UPDATE", "MERGE", "EXEC",
            "EXECUTE", "CALL", "REFRESH", "PROCESS", "CLEAR", "CACHE", "BACKUP", "RESTORE",
            "ATTACH", "DETACH", "DISCOVER", "DRILLTHROUGH", "SESSION", "XMLA", "MDX"
        };
        public static List<DaxToken> Validate(string query)
        {
            var tokens = Lex(query);
            if (tokens.Count == 0 || tokens[0].Kind != "word" ||
                !(tokens[0].Text.Equals("EVALUATE", StringComparison.OrdinalIgnoreCase) || tokens[0].Text.Equals("DEFINE", StringComparison.OrdinalIgnoreCase)))
                throw DeniedQuery();
            var evaluate = false;
            foreach (var token in tokens)
            {
                if (token.Kind == "word")
                {
                    if (Denied.Contains(token.Text) || token.Text.Equals("INFO", StringComparison.OrdinalIgnoreCase) ||
                        token.Text.StartsWith("INFO.", StringComparison.OrdinalIgnoreCase)) throw DeniedQuery();
                    evaluate |= token.Text.Equals("EVALUATE", StringComparison.OrdinalIgnoreCase);
                }
                if (token.Kind == "symbol" && (token.Text == ";" || token.Text == "$" || token.Text == ":" || token.Text == "`")) throw DeniedQuery();
            }
            if (!evaluate) throw DeniedQuery();
            return tokens;
        }
        public static List<DaxToken> Lex(string text)
        {
            var result = new List<DaxToken>();
            for (var i = 0; i < text.Length;)
            {
                var c = text[i];
                if (char.IsWhiteSpace(c)) { i++; continue; }
                if (i + 1 < text.Length && ((c == '-' && text[i + 1] == '-') || (c == '/' && text[i + 1] == '/')))
                {
                    while (i < text.Length && text[i] != '\r' && text[i] != '\n') i++;
                    continue;
                }
                if (i + 1 < text.Length && c == '/' && text[i + 1] == '*')
                {
                    i += 2;
                    var closed = false;
                    while (i + 1 < text.Length)
                    {
                        if (text[i] == '*' && text[i + 1] == '/') { i += 2; closed = true; break; }
                        i++;
                    }
                    if (!closed) throw new DaxGateError("INVALID_DAX", "Unterminated DAX comment.");
                    continue;
                }
                if (c == '\'' || c == '"' || c == '[')
                {
                    var end = c == '[' ? ']' : c;
                    var value = new StringBuilder();
                    var closed = false;
                    i++;
                    while (i < text.Length)
                    {
                        if (text[i] == end)
                        {
                            if (i + 1 < text.Length && text[i + 1] == end) { value.Append(end); i += 2; continue; }
                            i++; closed = true; break;
                        }
                        value.Append(text[i++]);
                    }
                    if (!closed) throw new DaxGateError("INVALID_DAX", "Unterminated DAX string or identifier.");
                    result.Add(new DaxToken(value.ToString(), c == '"' ? "string" : "identifier"));
                    continue;
                }
                if (char.IsLetter(c) || c == '_')
                {
                    var start = i++;
                    while (i < text.Length && (char.IsLetterOrDigit(text[i]) || text[i] == '_' || text[i] == '.')) i++;
                    result.Add(new DaxToken(text.Substring(start, i - start), "word"));
                    continue;
                }
                if (char.IsControl(c)) throw new DaxGateError("INVALID_DAX", "Invalid control character in DAX.");
                result.Add(new DaxToken(c.ToString(), "symbol")); i++;
            }
            return result;
        }
        private static DaxGateError DeniedQuery() => new DaxGateError("READ_ONLY_DAX_REQUIRED",
            "Only read-only EVALUATE/DEFINE DAX is supported; INFO, MDX, XMLA and administrative commands are disabled.");
    }
}
