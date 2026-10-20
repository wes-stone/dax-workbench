using Azure.Core;
using Azure.Identity;
using System.Net;
using System.Net.Http.Headers;
using System.Text.Json;

namespace DaxWorkbench.Host;

internal sealed record PowerBiRestTransport(HttpClient Client, TokenCredential Credential);

public static class PowerBiRest
{
    public const int MaxResponseBytes = 16 * 1024 * 1024;
    public const string SchemaWarning = "Power BI REST executeQueries does not expose model schema, relationships, measures or declared column types. Schema discovery is unsupported; no XMLA fallback is attempted.";
    public const string InferenceWarning = "Column types are inferred from the full bounded REST JSON response, not model-declared types. Numeric JSON tokens are preserved as exact strings (including scientific notation); integer/decimal mixtures infer Decimal, not a guaranteed model or .NET decimal precision. Strings are never inferred as dates; incompatible mixed types and all-null columns are Variant.";
    public const string CancellationWarning = "Power BI REST cancellation or timeout stops the local HTTP wait only. Server execution may continue; executeQueries provides no server cancellation guarantee.";
    public const string LimitsWarning = "Power BI REST executeQueries supports one query/table, with service limits of 100000 rows, 1000000 values and 15 MB. The companion also enforces local row/serialized-byte limits and a 16 MiB HTTP response bound. REST success is not XMLA success.";

    internal static void AddWarnings(QueryResult result)
    {
        result.Warnings.Add(InferenceWarning);
        result.Warnings.Add(LimitsWarning);
        result.Warnings.Add(CancellationWarning);
    }

    internal static void ValidateRequest(JsonElement request)
    {
        var tokens = ReadOnlyDax.Validate(request.Required("query", 1_500_000));
        if (ReadOnlyDax.Parameters(request).Count != 0 || tokens.Any(t => t.Kind == "symbol" && t.Text == "@"))
            throw new HostError("REST_PARAMETERS_UNSUPPORTED", "Power BI REST executeQueries does not support native parameters. No parameter substitution or query rewriting is performed.");
        if (tokens.Count(t => t.Kind == "word" && t.Text.Equals("EVALUATE", StringComparison.OrdinalIgnoreCase)) != 1)
            throw new HostError("REST_MULTIPLE_EVALUATE_UNSUPPORTED", "Power BI REST executeQueries supports exactly one EVALUATE statement and one result table.");
    }

    internal static HttpClientHandler CreateHandler() => new()
    {
        AllowAutoRedirect = false,
        UseCookies = false,
        AutomaticDecompression = DecompressionMethods.None
    };

    internal static async Task RunAsync(JsonElement request, PowerBiRestProfile profile, QueryResult result,
        ResultEmitter emitter, ProtocolWriter writer, CancellationToken token, PowerBiRestTransport? transport = null)
    {
        ValidateRequest(request);
        var timeout = request.Integer("timeoutSeconds", 30, 1, 600);
        using var deadline = CancellationTokenSource.CreateLinkedTokenSource(token);
        deadline.CancelAfter(TimeSpan.FromSeconds(timeout));
        var boundedToken = deadline.Token;
        using var ownedClient = transport == null ? new HttpClient(CreateHandler()) { Timeout = TimeSpan.FromSeconds(timeout) } : null;
        var client = transport?.Client ?? ownedClient!;
        var credential = transport?.Credential ?? new AzureCliCredential(new AzureCliCredentialOptions
        {
            TenantId = profile.TenantId,
            ProcessTimeout = TimeSpan.FromSeconds(Math.Min(20, timeout))
        });
        try
        {
            boundedToken.ThrowIfCancellationRequested();
            var accessToken = await AzureCliDiagnostics.GetTokenAsync(credential, new TokenRequestContext([PowerBiRestProfile.Scope]), boundedToken, token).ConfigureAwait(false);
            boundedToken.ThrowIfCancellationRequested();
            using var message = new HttpRequestMessage(HttpMethod.Post, profile.Endpoint);
            message.Headers.Authorization = new AuthenticationHeaderValue("Bearer", accessToken.Token);
            message.Headers.Accept.Add(new MediaTypeWithQualityHeaderValue("application/json"));
            message.Content = new ByteArrayContent(Json.Bytes(new
            {
                queries = new[] { new { query = request.Required("query", 1_500_000) } },
                serializerSettings = new { includeNulls = true }
            }));
            message.Content.Headers.ContentType = new MediaTypeHeaderValue("application/json");
            writer.Write(new { @event = "query.progress", runId = result.RunId, status = "executing" });
            using var response = await client.SendAsync(message, HttpCompletionOption.ResponseHeadersRead, boundedToken).ConfigureAwait(false);
            if (response.StatusCode != HttpStatusCode.OK) throw HttpError(response.StatusCode);
            if (response.Content.Headers.ContentLength > MaxResponseBytes) throw ResponseTooLarge();
            await using var stream = await response.Content.ReadAsStreamAsync(boundedToken).ConfigureAwait(false);
            var body = await ReadBoundedAsync(stream, boundedToken).ConfigureAwait(false);
            using var document = JsonDocument.Parse(body, new JsonDocumentOptions { MaxDepth = 64 });
            var rows = ReadRows(document.RootElement);
            if (rows.GetArrayLength() > 100000)
                throw new HostError("REST_SERVICE_LIMIT", "The REST response exceeds the 100000-row service limit; it was discarded.");
            var names = new List<string>();
            var indexes = new Dictionary<string, int>(StringComparer.Ordinal);
            var types = new List<string?>();
            long values = 0;
            foreach (var row in rows.EnumerateArray())
            {
                boundedToken.ThrowIfCancellationRequested();
                RequireObject(row);
                var seen = new HashSet<string>(StringComparer.Ordinal);
                foreach (var field in row.EnumerateObject())
                {
                    boundedToken.ThrowIfCancellationRequested();
                    if (!seen.Add(field.Name)) throw InvalidResponse();
                    if (++values > 1000000)
                        throw new HostError("REST_SERVICE_LIMIT", "The REST response exceeds the 1000000-value service limit; it was discarded.");
                    if (!indexes.TryGetValue(field.Name, out var index))
                    {
                        if (names.Count == 1024)
                            throw new HostError("SCHEMA_TOO_LARGE", "REST result tables support at most 1024 distinct columns.");
                        index = names.Count;
                        indexes.Add(field.Name, index);
                        names.Add(field.Name);
                        types.Add(null);
                    }
                    var type = TypeOf(field.Value);
                    if (type != null)
                        types[index] = types[index] == null || types[index] == type ? type
                            : types[index] is "Int64" or "Decimal" && type is "Int64" or "Decimal" ? "Decimal" : "Variant";
                }
            }
            boundedToken.ThrowIfCancellationRequested();
            emitter.Begin(names.Select((name, index) => new Column($"column-{index}", name, types[index] ?? "Variant")).ToList());
            writer.Write(new { @event = "query.progress", runId = result.RunId, status = "streaming" });
            foreach (var row in rows.EnumerateArray())
            {
                boundedToken.ThrowIfCancellationRequested();
                var encoded = new object?[names.Count];
                foreach (var field in row.EnumerateObject())
                    encoded[indexes[field.Name]] = Encode(field.Value);
                if (!emitter.Add(encoded)) break;
            }
            emitter.Flush();
        }
        catch (OperationCanceledException) when (!token.IsCancellationRequested)
        {
            throw new HostError("REST_TIMEOUT", "The Power BI REST operation exceeded its local time limit. Server execution may continue.");
        }
        catch (JsonException) { throw InvalidResponse(); }
        catch (HttpRequestException)
        {
            throw new HostError("REST_TRANSPORT_ERROR", "The Power BI REST HTTP request failed. No provider response text is included and no retry was attempted.");
        }
        catch (IOException)
        {
            throw new HostError("REST_TRANSPORT_ERROR", "The Power BI REST response could not be read completely. No retry was attempted.");
        }
    }

    internal static async Task<byte[]> ReadBoundedAsync(Stream stream, CancellationToken token)
    {
        using var body = new MemoryStream();
        var buffer = new byte[8192];
        while (true)
        {
            token.ThrowIfCancellationRequested();
            // Read at most one overflow sentinel byte, never store it in the body.
            var count = await stream.ReadAsync(buffer.AsMemory(0, (int)Math.Min(buffer.Length, MaxResponseBytes - body.Length + 1)), token).ConfigureAwait(false);
            if (count == 0) return body.ToArray();
            if (body.Length + count > MaxResponseBytes) throw ResponseTooLarge();
            body.Write(buffer, 0, count);
        }
    }

    private static JsonElement ReadRows(JsonElement root)
    {
        CheckEnvelope(root);
        if (!root.TryGetProperty("results", out var results) || results.ValueKind != JsonValueKind.Array) throw InvalidResponse();
        foreach (var result in results.EnumerateArray())
        {
            CheckEnvelope(result);
            if (!result.TryGetProperty("tables", out var tables) || tables.ValueKind != JsonValueKind.Array) throw InvalidResponse();
            foreach (var table in tables.EnumerateArray()) CheckEnvelope(table);
        }
        if (results.GetArrayLength() != 1 || results[0].GetProperty("tables").GetArrayLength() != 1)
            throw new HostError("REST_RESULT_SHAPE_UNSUPPORTED", "Power BI REST must return exactly one result and one table. Response rows were discarded.");
        var onlyTable = results[0].GetProperty("tables")[0];
        if (!onlyTable.TryGetProperty("rows", out var rows) || rows.ValueKind != JsonValueKind.Array) throw InvalidResponse();
        return rows;
    }

    private static void CheckEnvelope(JsonElement element)
    {
        RequireObject(element);
        var seen = new HashSet<string>(StringComparer.Ordinal);
        foreach (var property in element.EnumerateObject())
        {
            if (!seen.Add(property.Name)) throw InvalidResponse();
            if (property.Name is "error" or "errors" && property.Value.ValueKind != JsonValueKind.Null)
                throw new HostError("REST_QUERY_ERROR", "Power BI REST returned a query error envelope, including possible service-limit or partial-result errors. Response rows were discarded; completeness is unknown.");
        }
    }
    private static void RequireObject(JsonElement value)
    {
        if (value.ValueKind != JsonValueKind.Object) throw InvalidResponse();
    }
    private static string? TypeOf(JsonElement value) => value.ValueKind switch
    {
        JsonValueKind.Null => null,
        JsonValueKind.String => "String",
        JsonValueKind.True or JsonValueKind.False => "Boolean",
        JsonValueKind.Number => value.TryGetInt64(out _) ? "Int64" : "Decimal",
        _ => throw new HostError("REST_CELL_UNSUPPORTED", "A REST result contains a non-primitive cell; nested JSON values are unsupported.")
    };
    private static object? Encode(JsonElement value) => value.ValueKind switch
    {
        JsonValueKind.Null => null,
        JsonValueKind.String => value.GetString(),
        JsonValueKind.True => true,
        JsonValueKind.False => false,
        // GetRawText avoids floating-point/decimal rounding and exponent overflow.
        JsonValueKind.Number => value.GetRawText(),
        _ => throw new HostError("REST_CELL_UNSUPPORTED", "A REST result contains a non-primitive cell; nested JSON values are unsupported.")
    };
    private static HostError InvalidResponse() => new("REST_INVALID_RESPONSE", "Power BI REST returned an invalid or incomplete executeQueries JSON envelope. Response rows were discarded.");
    private static HostError ResponseTooLarge() => new("REST_RESPONSE_TOO_LARGE", "Power BI REST exceeded the 16 MiB HTTP response bound. Response rows were discarded; completeness is unknown.");
    private static HostError HttpError(HttpStatusCode status) => (int)status switch
    {
        >= 300 and < 400 => new("REST_REDIRECT_BLOCKED", "Power BI REST returned a redirect. Redirects are disabled; no token was forwarded."),
        400 => new("REST_BAD_REQUEST", "Power BI REST rejected the query request. Check the DAX and executeQueries restrictions."),
        401 => new("REST_UNAUTHORIZED", "Power BI REST rejected the Azure CLI token. Check the existing identity and selected tenant."),
        403 => new("REST_FORBIDDEN", "Power BI REST denied executeQueries. Dataset read/build permissions, API consent or tenant executeQueries policy may be required."),
        404 => new("REST_NOT_FOUND", "The Power BI REST workspace or dataset was not found or is not visible to this identity."),
        429 => new("REST_THROTTLED", "Power BI REST throttled the request. No automatic retry was attempted."),
        _ => new("REST_HTTP_ERROR", "Power BI REST returned an unsuccessful HTTP status. No response body, provider message or automatic retry is included.")
    };
}
