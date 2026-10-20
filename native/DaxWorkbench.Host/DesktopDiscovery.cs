using System.Diagnostics;
using System.Management;
using System.Runtime.InteropServices;
using System.Security.Principal;
using System.Text;

namespace DaxWorkbench.Host;

public static class DesktopDiscovery
{
    public static List<RegistryEntry> Discover()
    {
        var result = new List<RegistryEntry>();
        try
        {
            var sid = WindowsIdentity.GetCurrent().User?.Value;
            using var searcher = new ManagementObjectSearcher(
                "SELECT ProcessId,ParentProcessId,CommandLine FROM Win32_Process WHERE Name='msmdsrv.exe'");
            searcher.Options.Timeout = TimeSpan.FromSeconds(5);
            using var processes = searcher.Get();
            foreach (ManagementObject engine in processes)
            {
                using (engine)
                {
                    try
                    {
                        if (!OwnedBy(engine, sid)) continue;
                        var parentId = Convert.ToInt32(engine["ParentProcessId"]);
                        using var parent = new ManagementObject($"Win32_Process.Handle='{parentId}'");
                        if (!OwnedBy(parent, sid) || !string.Equals(parent["Name"]?.ToString(), "PBIDesktop.exe", StringComparison.OrdinalIgnoreCase))
                            continue;
                        var args = ParseArguments(engine["CommandLine"]?.ToString() ?? "");
                        var index = Array.FindIndex(args, arg => arg.Equals("-s", StringComparison.OrdinalIgnoreCase));
                        if (index < 0 || index + 1 >= args.Length) continue;
                        var data = args[index + 1];
                        if (!Path.IsPathFullyQualified(data)) continue;
                        var candidates = new[] { Path.Combine(data, "msmdsrv.port.txt"), Path.Combine(data, "Data", "msmdsrv.port.txt") };
                        var port = candidates.Select(ReadPort).FirstOrDefault(p => p is > 0 and <= 65535);
                        if (port == 0) continue;
                        var pid = Convert.ToInt32(engine["ProcessId"]);
                        using var process = Process.GetProcessById(pid);
                        var id = $"desktop:{pid}:{port}:{process.StartTime.ToUniversalTime().Ticks}";
                        result.Add(ConnectionRegistry.Create($"Power BI Desktop (PID {pid})",
                            $"Data Source=localhost:{port};Integrated Security=SSPI", "desktop", id));
                    }
                    catch { /* A process can exit or deny access during discovery. */ }
                }
            }
        }
        catch { /* WMI may be unavailable; no broad filesystem/process scan fallback. */ }
        return result;
    }
    public static bool IsStillAvailable(string id)
    {
        var pieces = id.Split(':');
        if (pieces.Length != 4 || !int.TryParse(pieces[1], out var pid) || !long.TryParse(pieces[3], out var ticks)) return false;
        try
        {
            using var process = Process.GetProcessById(pid);
            return process.ProcessName.Equals("msmdsrv", StringComparison.OrdinalIgnoreCase) &&
                   process.StartTime.ToUniversalTime().Ticks == ticks && !process.HasExited;
        }
        catch { return false; }
    }
    private static bool OwnedBy(ManagementObject process, string? sid)
    {
        using var output = process.InvokeMethod("GetOwnerSid", null, null);
        return sid != null && Convert.ToUInt32(output?["ReturnValue"]) == 0 &&
               string.Equals(output?["Sid"]?.ToString(), sid, StringComparison.Ordinal);
    }
    private static int ReadPort(string path)
    {
        if (!File.Exists(path)) return 0;
        var info = new FileInfo(path);
        if (info.Length is < 1 or > 128 || (info.Attributes & FileAttributes.ReparsePoint) != 0) return 0;
        var bytes = File.ReadAllBytes(path);
        var text = bytes.Contains((byte)0) ? Encoding.Unicode.GetString(bytes) : Encoding.UTF8.GetString(bytes);
        return int.TryParse(text.Trim('\uFEFF', '\0', ' ', '\r', '\n'), out var port) ? port : 0;
    }
    private static string[] ParseArguments(string command)
    {
        var pointer = CommandLineToArgvW(command, out var count);
        if (pointer == IntPtr.Zero) return [];
        try
        {
            var args = new string[count];
            for (var i = 0; i < count; i++) args[i] = Marshal.PtrToStringUni(Marshal.ReadIntPtr(pointer, i * IntPtr.Size)) ?? "";
            return args;
        }
        finally { LocalFree(pointer); }
    }
    [DllImport("shell32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr CommandLineToArgvW(string commandLine, out int count);
    [DllImport("kernel32.dll")]
    private static extern IntPtr LocalFree(IntPtr handle);
}
