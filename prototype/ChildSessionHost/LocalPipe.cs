using System.ComponentModel;
using System.IO.Pipes;
using System.Runtime.InteropServices;
using System.Security.Principal;
using Microsoft.Win32.SafeHandles;

internal static class LocalPipe
{
    private const uint Duplex = 0x00000003;
    private const uint FirstInstance = 0x00080000;
    private const uint Overlapped = 0x40000000;
    private const uint RejectRemoteClients = 0x00000008;

    public static NamedPipeServerStream Create(string name)
    {
        using var identity = WindowsIdentity.GetCurrent();
        var sid = identity.User?.Value ?? throw new InvalidOperationException("Could not determine the Windows user SID.");
        if (!ConvertStringSecurityDescriptorToSecurityDescriptor($"O:{sid}D:P(A;;GA;;;{sid})", 1,
                out var descriptor, IntPtr.Zero))
            throw new Win32Exception(Marshal.GetLastWin32Error());
        try
        {
            var security = new SecurityAttributes { Length = Marshal.SizeOf<SecurityAttributes>(), Descriptor = descriptor };
            var handle = CreateNamedPipe(@"\\.\pipe\" + name, Duplex | FirstInstance | Overlapped,
                RejectRemoteClients, 1, 65536, 65536, 0, ref security);
            try
            {
                if (handle.IsInvalid)
                    throw new Win32Exception(Marshal.GetLastWin32Error());
                return new NamedPipeServerStream(PipeDirection.InOut, isAsync: true, isConnected: false, handle);
            }
            catch
            {
                handle.Dispose();
                throw;
            }
        }
        finally
        {
            _ = LocalFree(descriptor);
        }
    }

    public static uint ClientSessionId(NamedPipeServerStream pipe)
    {
        if (!GetNamedPipeClientSessionId(pipe.SafePipeHandle, out var id))
            throw new Win32Exception(Marshal.GetLastWin32Error());
        return id;
    }
    public static uint ClientProcessId(NamedPipeServerStream pipe)
    {
        if (!GetNamedPipeClientProcessId(pipe.SafePipeHandle, out var id))
            throw new Win32Exception(Marshal.GetLastWin32Error());
        return id;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct SecurityAttributes
    {
        public int Length;
        public IntPtr Descriptor;
        public int Inherit;
    }

    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool ConvertStringSecurityDescriptorToSecurityDescriptor(string sddl, uint revision,
        out IntPtr descriptor, IntPtr descriptorLength);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern SafePipeHandle CreateNamedPipe(string name, uint openMode, uint pipeMode,
        uint maxInstances, uint outputSize, uint inputSize, uint timeout, ref SecurityAttributes security);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetNamedPipeClientSessionId(SafePipeHandle pipe, out uint id);
    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetNamedPipeClientProcessId(SafePipeHandle pipe, out uint id);

    [DllImport("kernel32.dll")]
    private static extern IntPtr LocalFree(IntPtr pointer);
}
