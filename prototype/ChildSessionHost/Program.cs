using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text.Json;

internal static class Program
{
    [STAThread]
    private static int Main(string[] args)
    {
        if (args.Length == 3 && args[0] == "--reset-owned")
            return OwnedSessionRecovery.Run(args[1], args[2]);

        if (args.Length == 2 && args[0] == "--broker")
            return ChildSessionBroker.Run(args[1]);

        if (args.Length == 5 && args[0] == "--bridge-config")
            return ChildSessionBroker.StartBridge(args[1], args[2], args[3], args[4]);

        if (args.Length == 5 && args[0] == "--start-probe")
            return StartProbe(args[1], args[2], args[3], args[4]);

        if (args.Length is < 2 or > 3 || args[0] != "--status-file" ||
            !Path.IsPathFullyQualified(args[1]) ||
            (args.Length == 3 && args[2] != "--logoff-on-close"))
        {
            return 2;
        }

        using var current = Process.GetCurrentProcess();
        var status = new StatusFile(args[1], current.SessionId);
        try
        {
            status.Write("starting");
            using var instance = new Mutex(false, @"Local\DSHarness.ChildSessionHost");
            if (!instance.WaitOne(0))
                throw new InvalidOperationException("A Harness Child Session viewer is already running.");
            try
            {
                if (Sessions.GetChildId() is not null)
                    throw new InvalidOperationException("The current Windows session already has a child session.");

                ApplicationConfiguration.Initialize();
                using var viewer = new Viewer(status, args.Length == 3);
                Application.Run(viewer);
                return viewer.Failed ? 1 : 0;
            }
            finally
            {
                instance.ReleaseMutex();
            }
        }
        catch (Exception error)
        {
            status.Write("error", message: error.Message);
            return 1;
        }
    }

    private static int StartProbe(string node, string bootstrap, string parent, string evidence)
    {
        using var current = Process.GetCurrentProcess();
        if (!int.TryParse(parent, out var parentSession) || parentSession <= 0 ||
            current.SessionId == 0 || current.SessionId == parentSession ||
            !Path.IsPathFullyQualified(node) || !Path.IsPathFullyQualified(bootstrap) ||
            !Path.IsPathFullyQualified(evidence) || !Directory.Exists(evidence))
            return 2;

        var start = new ProcessStartInfo(node) { UseShellExecute = false, CreateNoWindow = true };
        start.ArgumentList.Add(bootstrap);
        start.ArgumentList.Add(parent);
        start.ArgumentList.Add(evidence);
        using var worker = Process.Start(start);
        if (worker is null)
            return 1;
        worker.WaitForExit();
        return worker.ExitCode;
    }
}

internal sealed class StatusFile(string path, int parentSessionId)
{
    public int ParentSessionId { get; } = parentSessionId;

    public void Write(string state, uint? childSessionId = null, string? message = null,
        int? disconnectReason = null)
    {
        var contents = JsonSerializer.Serialize(new
        {
            state,
            parentSessionId = ParentSessionId,
            childSessionId,
            processId = Environment.ProcessId,
            message,
            disconnectReason,
            updatedAt = DateTimeOffset.UtcNow
        });
        var temporary = $"{path}.{Environment.ProcessId}.tmp";
        File.WriteAllText(temporary, contents);
        File.Move(temporary, path, overwrite: true);
    }
}

internal static class Sessions
{
    internal sealed record DisplayResolution(int Width, int Height);

    public static uint? GetChildId()
    {
        if (WTSGetChildSessionId(out var id))
            return id == uint.MaxValue ? null : id;

        var error = Marshal.GetLastWin32Error();
        if (error == 1168 && id == uint.MaxValue) // ERROR_NOT_FOUND
            return null;
        throw new Win32Exception(error, $"Could not query the Windows child session (Win32 {error}).");
    }

    public static void Logoff(uint sessionId)
    {
        if (!WTSLogoffSession(IntPtr.Zero, sessionId, false))
            throw new Win32Exception(Marshal.GetLastWin32Error(), "Could not log off the Windows child session.");
    }

    public static DisplayResolution? GetClientDisplay(uint sessionId)
    {
        // WTSClientDisplay reports the display associated with the RDP session.
        // The caller supplies the authenticated child ID, never a window or form size.
        const int wtsClientDisplay = 15;
        if (!WTSQuerySessionInformationW(IntPtr.Zero, sessionId, wtsClientDisplay, out var buffer, out var bytes))
            return null;
        if (buffer == IntPtr.Zero)
            return null;
        try
        {
            // WTS_CLIENT_DISPLAY consists of three DWORDs: width, height, color depth.
            if (bytes < 12)
                return null;
            var width = Marshal.ReadInt32(buffer, 0);
            var height = Marshal.ReadInt32(buffer, 4);
            return width is > 0 and <= 32768 && height is > 0 and <= 32768
                ? new DisplayResolution(width, height)
                : null;
        }
        finally
        {
            WTSFreeMemory(buffer);
        }
    }

    [DllImport("wtsapi32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool WTSGetChildSessionId(out uint sessionId);

    [DllImport("wtsapi32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool WTSLogoffSession(IntPtr server, uint sessionId, [MarshalAs(UnmanagedType.Bool)] bool wait);

    [DllImport("wtsapi32.dll", ExactSpelling = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool WTSQuerySessionInformationW(IntPtr server, uint sessionId, int infoClass, out IntPtr buffer,
        out uint bytesReturned);

    [DllImport("wtsapi32.dll", ExactSpelling = true)]
    private static extern void WTSFreeMemory(IntPtr buffer);
}
