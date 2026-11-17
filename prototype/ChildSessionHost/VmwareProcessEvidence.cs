using System.ComponentModel;
using System.Diagnostics;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Text;
using Microsoft.Win32.SafeHandles;

internal static class VmwareProcessEvidence
{
    private const uint QueryLimitedInformation = 0x1000;
    private const uint Synchronize = 0x00100000;
    private const uint WaitTimeout = 258;
    private const int MaxCommandLineBytes = 65536;
    private const int MaxPath = 1024;
    private static readonly StringComparer Paths = StringComparer.OrdinalIgnoreCase;
    private static readonly Lazy<NtQueryProcess?> QueryCommandLine = new(ResolveQuery);

    internal sealed record ObservedProcess(int Pid, int Session, string VmxPath, long Birth, long CpuMs);
    internal sealed record Snapshot(ObservedProcess[] Processes, bool Complete);

    internal sealed class Owner : IDisposable
    {
        private readonly SafeProcessHandle handle;
        private readonly nint hwnd;
        private readonly int pid;
        private readonly int session;

        internal Owner(int pid, string? hwndText, string? birth, int session, string executable)
        {
            if (pid <= 0 || session <= 0 || birth is not { Length: 16 } ||
                !ulong.TryParse(hwndText, NumberStyles.None, CultureInfo.InvariantCulture, out var address) || address == 0)
                throw new UnauthorizedAccessException("VMware owner identity is missing.");
            hwnd = unchecked((nint)address);
            this.pid = pid;
            this.session = session;
            handle = OpenProcess(QueryLimitedInformation | Synchronize, false, pid);
            try
            {
                RequireCurrent();
                if (!GetProcessTimes(handle, out var creation, out _, out _, out _) ||
                    !string.Equals(Convert.ToHexString(BitConverter.GetBytes(creation)), birth, StringComparison.OrdinalIgnoreCase) ||
                    !Paths.Equals(CanonicalFile(ImagePath(handle), ".exe"), executable))
                    throw new UnauthorizedAccessException("VMware owner process identity has changed.");
            }
            catch
            {
                handle.Dispose();
                throw;
            }
        }

        internal void RequireCurrent()
        {
            if (handle.IsInvalid || WaitForSingleObject(handle, 0) != WaitTimeout ||
                !ProcessIdToSessionId(pid, out var actualSession) || actualSession != session ||
                GetWindowThreadProcessId(hwnd, out var windowPid) == 0 || windowPid != pid)
                throw new UnauthorizedAccessException("VMware owner window or verified child session has changed.");
        }

        public void Dispose() => handle.Dispose();
    }

    internal static Snapshot Observe(string installDirectory, CancellationToken token)
    {
        var output = new List<ObservedProcess>();
        var complete = true;
        var processes = Process.GetProcessesByName("vmware-vmx");
        try
        {
            foreach (var process in processes)
            {
                token.ThrowIfCancellationRequested();
                try
                {
                    using var handle = OpenProcess(QueryLimitedInformation | Synchronize, false, process.Id);
                    if (handle.IsInvalid)
                    {
                        if (!process.HasExited) complete = false;
                        continue;
                    }
                    if (WaitForSingleObject(handle, 0) != WaitTimeout) continue;
                    var executable = CanonicalFile(ImagePath(handle), ".exe");
                    if (!IsExpectedVmxBinary(executable, installDirectory) ||
                        !ProcessIdToSessionId(process.Id, out var session))
                    {
                        complete = false;
                        continue;
                    }
                    var path = VmxArgument(handle);
                    if (!GetProcessTimes(handle, out var birth, out _, out var kernel, out var user))
                    {
                        complete = false;
                        continue;
                    }
                    var cpuMs = (kernel + user) / TimeSpan.TicksPerMillisecond;
                    if (WaitForSingleObject(handle, 0) != WaitTimeout) continue;
                    output.Add(new ObservedProcess(process.Id, (int)session, path, birth, cpuMs));
                }
                catch (Exception error) when (error is Win32Exception or IOException or InvalidOperationException or UnauthorizedAccessException or ArgumentException)
                {
                    complete = false;
                }
            }
        }
        finally
        {
            foreach (var process in processes) process.Dispose();
        }
        return new Snapshot(output.ToArray(), complete);
    }

    private static bool IsExpectedVmxBinary(string path, string installDirectory) =>
        Paths.Equals(path, Path.Combine(installDirectory, "vmware-vmx.exe")) ||
        Paths.Equals(path, Path.Combine(installDirectory, "x64", "vmware-vmx.exe"));

    internal static string CanonicalFile(string? path, string extension)
    {
        if (string.IsNullOrEmpty(path) || path.Length > MaxPath || !Path.IsPathFullyQualified(path) ||
            Path.GetPathRoot(path) is not { Length: 3 } || path[1] != ':' || path[2..].Contains(':') ||
            path.Any(ch => char.IsControl(ch) || ch is '"' or '<' or '>' or '|' or '?' or '*') ||
            !Paths.Equals(Path.GetExtension(path), extension))
            throw new InvalidDataException("An absolute local file path with the required extension is required.");
        var fullPath = Path.GetFullPath(path);
        if (GetDriveTypeW(Path.GetPathRoot(fullPath)!) != 3)
            throw new InvalidDataException("Only files on fixed local Windows drives are allowed.");
        using var handle = File.OpenHandle(fullPath, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete);
        var finalPath = new StringBuilder(MaxPath + 6);
        var size = GetFinalPathNameByHandleW(handle, finalPath, (uint)finalPath.Capacity, 0);
        if (size == 0) throw new Win32Exception(Marshal.GetLastWin32Error());
        var canonical = finalPath.ToString();
        if (size >= finalPath.Capacity || !canonical.StartsWith(@"\\?\", StringComparison.Ordinal) ||
            canonical.Length < 7 || canonical[5] != ':' ||
            GetDriveTypeW(canonical.Substring(4, 3)) != 3 ||
            !Paths.Equals(Path.GetExtension(canonical), extension))
            throw new InvalidDataException("The file resolves outside a supported local drive.");
        return canonical[4..];
    }

    private static string ImagePath(SafeProcessHandle process)
    {
        var path = new StringBuilder(MaxPath + 1);
        var length = (uint)path.Capacity;
        if (!QueryFullProcessImageNameW(process, 0, path, ref length))
            throw new Win32Exception(Marshal.GetLastWin32Error());
        return path.ToString();
    }

    private static string VmxArgument(SafeProcessHandle process)
    {
        var query = QueryCommandLine.Value ?? throw new InvalidOperationException("Process command-line verification is unavailable.");
        var buffer = Marshal.AllocHGlobal(MaxCommandLineBytes);
        try
        {
            const int processCommandLineInformation = 60;
            if (query(process, processCommandLineInformation, buffer, MaxCommandLineBytes, out var returned) < 0 ||
                returned <= Marshal.SizeOf<UnicodeString>() || returned > MaxCommandLineBytes)
                throw new InvalidOperationException("The VMX command line could not be queried.");
            var command = Marshal.PtrToStructure<UnicodeString>(buffer);
            var offset = command.Buffer.ToInt64() - buffer.ToInt64();
            if (command.Length == 0 || command.Length % 2 != 0 || offset < Marshal.SizeOf<UnicodeString>() ||
                offset > returned - command.Length)
                throw new InvalidDataException("Invalid VMX command line.");
            var commandLine = Marshal.PtrToStringUni(command.Buffer, command.Length / 2)!;
            var argv = CommandLineToArgvW(commandLine, out var count);
            if (argv == nint.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
            try
            {
                var matches = new List<string>();
                for (var index = 1; index < count; index++)
                {
                    var argument = Marshal.PtrToStringUni(Marshal.ReadIntPtr(argv, index * nint.Size));
                    if (argument?.EndsWith(".vmx", StringComparison.OrdinalIgnoreCase) == true)
                        matches.Add(CanonicalFile(argument, ".vmx"));
                }
                if (matches.Count != 1) throw new InvalidDataException("The VMX process does not identify a unique configuration file.");
                return matches[0];
            }
            finally { LocalFree(argv); }
        }
        finally { Marshal.FreeHGlobal(buffer); }
    }

    private static NtQueryProcess? ResolveQuery()
    {
        // Dynamically resolve this Windows-specific information class. Unavailability
        // leaves process ownership unverified and therefore blocks power commands.
        if (!NativeLibrary.TryLoad(Path.Combine(Environment.SystemDirectory, "ntdll.dll"), out var dll))
            return null;
        return NativeLibrary.TryGetExport(dll, "NtQueryInformationProcess", out var query)
            ? Marshal.GetDelegateForFunctionPointer<NtQueryProcess>(query) : null;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct UnicodeString
    {
        public ushort Length;
        public ushort MaximumLength;
        public nint Buffer;
    }

    [UnmanagedFunctionPointer(CallingConvention.Winapi)]
    private delegate int NtQueryProcess(SafeProcessHandle process, int informationClass, nint buffer, int size, out int returned);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern SafeProcessHandle OpenProcess(uint access, [MarshalAs(UnmanagedType.Bool)] bool inherit, int pid);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint WaitForSingleObject(SafeProcessHandle handle, uint milliseconds);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool ProcessIdToSessionId(int pid, out uint sessionId);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetProcessTimes(SafeProcessHandle process, out long creation, out long exit, out long kernel, out long user);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool QueryFullProcessImageNameW(SafeProcessHandle process, uint flags, StringBuilder path, ref uint size);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = true)]
    private static extern uint GetFinalPathNameByHandleW(SafeFileHandle file, StringBuilder path, uint size, uint flags);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, ExactSpelling = true)]
    private static extern uint GetDriveTypeW(string rootPath);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern uint GetWindowThreadProcessId(nint hwnd, out uint pid);

    [DllImport("shell32.dll", CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = true)]
    private static extern nint CommandLineToArgvW(string commandLine, out int count);

    [DllImport("kernel32.dll", ExactSpelling = true)]
    private static extern nint LocalFree(nint pointer);
}
