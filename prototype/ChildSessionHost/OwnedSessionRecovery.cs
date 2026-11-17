using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text.Json;

/// <summary>Recovery accepts only a capability held by the creating plugin connection.
/// Never enumerate processes, kill by name, or log off an unproven Windows association.</summary>
internal static class OwnedSessionRecovery
{
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);
    private sealed record Config(string RecoveryToken);
    private sealed record Ownership(int Version, string Token, string Directory, int ParentSessionId,
        uint ChildSessionId, long LogonTime, int BrokerPid, long BrokerBirth, string Executable, string Nonce);

    internal static void ValidateConfig(string directory)
    {
        if (!Guid.TryParse(Read<Config>(Path.Combine(directory, "broker-config.json")).RecoveryToken, out _))
            throw new InvalidDataException("Missing recovery ownership capability.");
    }

    internal static void RecordStart(string directory, int parent, string nonce) => WriteRecord(directory, parent, 0, nonce);

    internal static void Record(string directory, int parent, uint child) =>
        WriteRecord(directory, parent, child, Read<Ownership>(Path.Combine(directory, "owned-session.json")).Nonce);

    private static void WriteRecord(string directory, int parent, uint child, string nonce)
    {
        using var broker = Process.GetCurrentProcess();
        var token = Read<Config>(Path.Combine(directory, "broker-config.json")).RecoveryToken;
        var record = new Ownership(1, token, Path.GetFullPath(directory), parent, child,
            child == 0 ? 0 : LogonTime(child), broker.Id, broker.StartTime.ToUniversalTime().Ticks, Environment.ProcessPath!, nonce);
        var path = Path.Combine(directory, "owned-session.json");
        File.WriteAllBytes(path + ".tmp", JsonSerializer.SerializeToUtf8Bytes(record, Json));
        File.Move(path + ".tmp", path, true);
    }

    internal static int Run(string directory, string token)
    {
        try
        {
            if (!Path.IsPathFullyQualified(directory) || !Guid.TryParse(token, out _))
                throw new InvalidDataException("Invalid owned recovery request.");
            directory = Path.GetFullPath(directory);
            if (new DirectoryInfo(directory).Attributes.HasFlag(FileAttributes.ReparsePoint))
                throw new InvalidDataException("Recovery refuses redirected run directories.");
            var config = Read<Config>(Path.Combine(directory, "broker-config.json"));
            if (config.RecoveryToken != token)
                throw new UnauthorizedAccessException("Recovery capability mismatch.");
            var path = Path.Combine(directory, "owned-session.json");
            // Startup may fail before this process creates any association. Never infer ownership.
            if (!File.Exists(path)) return 0;
            var owned = Read<Ownership>(path);
            using var current = Process.GetCurrentProcess();
            if (owned.Version != 1 || owned.Token != token || owned.ParentSessionId != current.SessionId ||
                owned.ParentSessionId <= 0 || owned.ChildSessionId == owned.ParentSessionId ||
                (owned.ChildSessionId != 0 && owned.LogonTime <= 0) || owned.Nonce.Length != 64 ||
                !owned.Nonce.All(ch => ch is >= '0' and <= '9' or >= 'a' and <= 'f') || !SamePath(owned.Directory, directory) ||
                !SamePath(owned.Executable, Environment.ProcessPath!))
                throw new UnauthorizedAccessException("The session is not owned by this plugin connection.");

            // A live original broker must be closed through its exact process handle by its owner.
            try
            {
                using var broker = Process.GetProcessById(owned.BrokerPid);
                if (broker.StartTime.ToUniversalTime().Ticks == owned.BrokerBirth)
                    throw new ActiveChildSessionException("The owned broker is active; close its connection first.");
            }
            catch (ArgumentException) { }

            using var gate = new Mutex(false, @"Local\DSHarness.ChildSessionHost");
            var taken = false;
            try
            {
                try { taken = gate.WaitOne(0); } catch (AbandonedMutexException) { taken = true; }
                if (!taken) throw new ActiveChildSessionException("A Child Session broker is active; no session was changed.");
                File.Delete(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Startup), $"DSHarness.ChildSession.{owned.Nonce}.lnk"));
                var associated = Sessions.GetChildId();
                if (associated is null) { File.Delete(path); return 0; }
                if (associated != owned.ChildSessionId || LogonTime(associated.Value) != owned.LogonTime)
                    throw new UnauthorizedAccessException("The current association belongs to another session; it was not changed.");
                // Repeat both checks immediately before the only destructive operation.
                if (Sessions.GetChildId() != owned.ChildSessionId || LogonTime(owned.ChildSessionId) != owned.LogonTime)
                    throw new UnauthorizedAccessException("The child-session identity changed before reset.");
                Sessions.Logoff(owned.ChildSessionId);
                var wait = Stopwatch.StartNew();
                while (Sessions.GetChildId() == owned.ChildSessionId && wait.Elapsed.TotalSeconds < 10)
                    Thread.Sleep(50);
                if (Sessions.GetChildId() == owned.ChildSessionId)
                    throw new IOException("The owned orphan is still signing out.");
                File.Delete(path);
                return 0;
            }
            finally { if (taken) gate.ReleaseMutex(); }
        }
        catch (Exception error)
        {
            Console.WriteLine(JsonSerializer.Serialize(new { @event = "error", message = error.Message,
                reason = "child-session-unavailable", association = error is ActiveChildSessionException ? "active" : error is UnauthorizedAccessException or InvalidDataException ? "unknown" : "orphan",
                nextTool = "desktop_get_task_status", retryAfterMs = 500 }, Json));
            return 1;
        }
    }

    private static T Read<T>(string path)
    {
        using var file = File.OpenRead(path);
        if (file.Length > 16384) throw new InvalidDataException("Oversized recovery record.");
        return JsonSerializer.Deserialize<T>(file, Json) ?? throw new InvalidDataException("Invalid recovery record.");
    }
    private static bool SamePath(string a, string b) => string.Equals(Path.GetFullPath(a), Path.GetFullPath(b), StringComparison.OrdinalIgnoreCase);

    // The logon timestamp prevents a recycled numeric WTS session ID from authorizing teardown.
    private static long LogonTime(uint id)
    {
        if (!WTSQuerySessionInformationW(IntPtr.Zero, id, 25, out var data, out var size))
            throw new InvalidOperationException("Cannot verify child-session logon identity.");
        try
        {
            if (data == IntPtr.Zero || size < Marshal.SizeOf<InfoEx>())
                throw new InvalidDataException("Missing child-session identity.");
            var info = Marshal.PtrToStructure<InfoEx>(data);
            if (info.Level != 1 || info.SessionId != id || info.LogonTime <= 0)
                throw new InvalidDataException("Invalid child-session identity.");
            return info.LogonTime;
        }
        finally { if (data != IntPtr.Zero) WTSFreeMemory(data); }
    }
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct InfoEx
    {
        public uint Level;
        private uint alignment;
        public uint SessionId;
        public int SessionState;
        public int SessionFlags;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 33)] public string StationName;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 21)] public string UserName;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 18)] public string DomainName;
        public long LogonTime;
        public long ConnectTime, DisconnectTime, LastInputTime, CurrentTime;
        public uint IncomingBytes, OutgoingBytes, IncomingFrames, OutgoingFrames, IncomingCompressedBytes, OutgoingCompressedBytes;
    }
    [DllImport("wtsapi32.dll", ExactSpelling = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool WTSQuerySessionInformationW(IntPtr server, uint id, int field, out IntPtr data, out uint bytes);
    [DllImport("wtsapi32.dll", ExactSpelling = true)]
    private static extern void WTSFreeMemory(IntPtr data);
}
