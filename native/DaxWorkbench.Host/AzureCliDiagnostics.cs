using Azure.Core;
using Azure.Identity;
using System.ComponentModel;
using System.Globalization;
using System.Text.RegularExpressions;

namespace DaxWorkbench.Host;

internal sealed record AzureCliEnvironment(bool AzureConfigDirOverridePresent, bool HomeOverridePresent,
    bool PathPresent, bool CliLauncherOnPath, bool CliLauncherProbeComplete)
{
    internal static AzureCliEnvironment Capture(Func<string, string?>? readEnvironment = null, Func<string, bool>? fileExists = null)
    {
        readEnvironment ??= Environment.GetEnvironmentVariable;
        fileExists ??= File.Exists;
        var config = !string.IsNullOrEmpty(readEnvironment("AZURE_CONFIG_DIR"));
        var home = !string.IsNullOrEmpty(readEnvironment("HOME"));
        var path = readEnvironment("PATH");
        if (string.IsNullOrEmpty(path)) return new(config, home, false, false, true);
        if (path.Length > 32768) return new(config, home, true, false, false);
        var directories = path.Split(';');
        var complete = directories.Length <= 256;
        var found = false;
        foreach (var item in directories.Take(256))
        {
            var directory = item.Trim().Trim('"');
            // Probe only explicit local-drive PATH entries; never traverse a
            // network path, expand variables, enumerate directories or run az.
            if (directory.Length < 3 || !char.IsAsciiLetter(directory[0]) || directory[1] != ':' || directory[2] != '\\' ||
                directory.Contains('%') || directory.Length > 4096)
            {
                complete = false;
                continue;
            }
            try
            {
                foreach (var launcher in new[] { "az.cmd", "az.exe", "az.bat" })
                    found |= fileExists(Path.Combine(directory, launcher));
            }
            catch { complete = false; }
        }
        return new(config, home, true, found, complete);
    }
}

internal static class AzureCliDiagnostics
{
    private static readonly Regex Aadsts = new(@"\bAADSTS([0-9]{4,12})\b",
        RegexOptions.IgnoreCase | RegexOptions.CultureInvariant | RegexOptions.NonBacktracking, TimeSpan.FromMilliseconds(100));
    private static readonly Regex ExitCode = new(@"\b(?:exit code|exited with code|exitCode)\s*[:=]?\s*(-?[0-9]{1,10})\b",
        RegexOptions.IgnoreCase | RegexOptions.CultureInvariant | RegexOptions.NonBacktracking, TimeSpan.FromMilliseconds(100));
    private static readonly Regex InvalidRequestParameter = new(@"\bAADSTS901001:\s*Invalid request\.\s+The\s+(?:(?<name>[A-Za-z][A-Za-z0-9_-]{0,63})|'(?<name>[A-Za-z][A-Za-z0-9_-]{0,63})'|""(?<name>[A-Za-z][A-Za-z0-9_-]{0,63})"")\s+request parameter value [^\r\n]*? is invalid\.",
        RegexOptions.IgnoreCase | RegexOptions.CultureInvariant | RegexOptions.NonBacktracking, TimeSpan.FromMilliseconds(100));
    private static readonly HashSet<string> AllowedParameterNames = new(StringComparer.OrdinalIgnoreCase)
    {
        "scope", "scopes", "resource", "client_id", "client_secret", "client_assertion", "client_assertion_type",
        "correlation_id", "correlationId", "client-request-id", "client_request_id", "request_id", "tenant", "tenant_id", "tenantId",
        "grant_type", "redirect_uri", "response_type", "response_mode", "code", "code_verifier", "code_challenge",
        "code_challenge_method", "refresh_token", "requested_token_use", "assertion", "claims", "prompt", "login_hint",
        "domain_hint", "nonce", "state", "username", "password", "id_token_hint", "request", "request_uri"
    };

    internal static AccessToken GetToken(TokenCredential credential, TokenRequestContext request, CancellationToken token)
    {
        try { return credential.GetToken(request, token); }
        catch (OperationCanceledException) when (token.IsCancellationRequested) { throw; }
        catch (Exception error) { throw Map(error); }
    }

    internal static async ValueTask<AccessToken> GetTokenAsync(TokenCredential credential, TokenRequestContext request,
        CancellationToken boundedToken, CancellationToken callerToken)
    {
        try { return await credential.GetTokenAsync(request, boundedToken).ConfigureAwait(false); }
        catch (OperationCanceledException) when (callerToken.IsCancellationRequested) { throw; }
        catch (Exception error) { throw Map(error, rest: true, deadlineExpired: boundedToken.IsCancellationRequested); }
    }

    internal static HostError Map(Exception error, bool rest = false, bool deadlineExpired = false, AzureCliEnvironment? environment = null)
    {
        if (error is HostError known) return known;
        var chain = new List<Exception>();
        for (Exception? current = error; current != null && chain.Count < 8; current = current.InnerException) chain.Add(current);
        var messages = new List<string>();
        var invalidParameters = new List<string>();
        foreach (var exception in chain)
        {
            var message = exception.Message.Length > 16384 ? exception.Message[..16384] : exception.Message;
            var invalidCode = Aadsts.Matches(message).FirstOrDefault(match => match.Groups[1].Value == "901001");
            if (invalidCode == null) { messages.Add(message); continue; }
            // AADSTS901001 embeds the invalid VALUE in its sentence. Exclude
            // that suffix from all other text-derived diagnostics, too.
            messages.Add(message[..(invalidCode.Index + invalidCode.Length)]);
            var parameter = InvalidRequestParameter.Match(message);
            if (parameter.Success && parameter.Index == invalidCode.Index &&
                AllowedParameterNames.TryGetValue(parameter.Groups["name"].Value, out var allowed) &&
                !invalidParameters.Contains(allowed, StringComparer.Ordinal))
                invalidParameters.Add(allowed);
        }
        bool Has(string text) => messages.Any(message => message.Contains(text, StringComparison.OrdinalIgnoreCase));
        var aadsts = messages.SelectMany(message => Aadsts.Matches(message).Select(m => "AADSTS" + m.Groups[1].Value))
            .Distinct(StringComparer.Ordinal).Take(8).ToList();
        var exitCodes = messages.SelectMany(message => ExitCode.Matches(message).Select(m => m.Groups[1].Value))
            .Select(value => int.TryParse(value, NumberStyles.AllowLeadingSign, CultureInfo.InvariantCulture, out var code) ? (int?)code : null)
            .Where(code => code.HasValue).Select(code => code!.Value).Distinct().Take(8).ToList();
        var nativeErrors = chain.OfType<Win32Exception>().Select(e => e.NativeErrorCode).Distinct().Take(8).ToList();
        var code = "AZURE_CLI_FAILED";
        var hint = "Azure CLI token acquisition failed; the available evidence does not establish a login, permission or tenant problem.";
        if (aadsts.Contains("AADSTS901001", StringComparer.Ordinal))
        {
            code = "AZURE_CLI_AUTHENTICATION_FAILED";
            hint = "Azure CLI reported an invalid token request (AADSTS901001); this is not evidence that sign-in, permissions or tenant selection must change.";
        }
        else if (deadlineExpired || chain.Any(e => e is TimeoutException or OperationCanceledException) || Has("timed out"))
        {
            code = "AZURE_CLI_TIMEOUT";
            hint = "Azure CLI token acquisition reached a local deadline or reported a subprocess timeout.";
        }
        else if (chain.Any(e => e is Win32Exception { NativeErrorCode: 2 or 3 }) ||
            Has("Azure CLI not installed") || Has("'az' is not recognized") || Has("az: not found") || Has("az: command not found"))
        {
            code = "AZURE_CLI_NOT_FOUND";
            hint = "Azure CLI or its required launcher could not be located by the token subprocess.";
        }
        else if (Has("run 'az login'") || Has("run \"az login\"") || Has("run the 'az login'") ||
            Has("interactive sign-in") || Has("interactive authentication") || Has("user interaction") ||
            Has("MsalUiRequired") || aadsts.Any(code => code is "AADSTS50076" or "AADSTS50079" or "AADSTS70043" or "AADSTS700082" or "AADSTS700084"))
        {
            code = "AUTHENTICATION_REQUIRED";
            hint = "The existing Azure CLI session reported that authentication or user interaction is required; no sign-in or account change was attempted.";
        }
        else if (chain.Any(e => e is CredentialUnavailableException))
        {
            code = "AZURE_CLI_UNAVAILABLE";
            hint = "Azure CLI credentials were reported unavailable; this alone does not prove the CLI is missing or the account needs sign-in.";
        }
        else if (chain.Any(e => e is AuthenticationFailedException))
        {
            code = "AZURE_CLI_AUTHENTICATION_FAILED";
            hint = "The Azure CLI credential reported failure; no permission, account or tenant cause has been inferred.";
        }
        var snapshot = environment ?? AzureCliEnvironment.Capture();
        var types = string.Join(" -> ", chain.Select(e => new string(e.GetType().Name.Where(c => char.IsAsciiLetterOrDigit(c) || c == '_').Take(128).ToArray())).Distinct());
        static string Flag(bool value) => value ? "true" : "false";
        return new((rest ? "REST_" : "") + code,
            $"Failed during Azure CLI token acquisition. {hint} ExceptionTypes=[{types}]; AADSTSCodes=[{string.Join(",", aadsts)}]; " +
            $"InvalidRequestParameters=[{string.Join(",", invalidParameters)}]; " +
            $"ReportedExitCodes=[{string.Join(",", exitCodes)}]; NativeProcessErrorCodes=[{string.Join(",", nativeErrors)}]; " +
            $"AZURE_CONFIG_DIROverridePresent={Flag(snapshot.AzureConfigDirOverridePresent)}; HOMEOverridePresent={Flag(snapshot.HomeOverridePresent)}; " +
            $"PATHPresent={Flag(snapshot.PathPresent)}; CliLauncherOnPath={Flag(snapshot.CliLauncherOnPath)}; CliLauncherProbeComplete={Flag(snapshot.CliLauncherProbeComplete)}. " +
            "Empty code lists mean not exposed, not success. Native process errors are not exit codes. Launcher presence is a bounded local-PATH file check, not proof of executable resolution or successful invocation. No raw exception text or environment values are included.");
    }
}
