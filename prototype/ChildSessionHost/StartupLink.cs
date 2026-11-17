using System.Runtime.InteropServices;

internal static class StartupLink
{
    public static string Create(string runDirectory, string nonce, int parentSessionId)
    {
        var startup = Environment.GetFolderPath(Environment.SpecialFolder.Startup);
        if (!Directory.Exists(startup))
            throw new InvalidOperationException("Could not locate the current user's Startup folder.");
        var path = Path.Combine(startup, $"DSHarness.ChildSession.{nonce}.lnk");
        if (File.Exists(path))
            throw new IOException("The broker startup shortcut already exists.");
        var shellType = Type.GetTypeFromProgID("WScript.Shell", throwOnError: true)!;
        var shell = Activator.CreateInstance(shellType)!;
        try
        {
            dynamic shortcut = ((dynamic)shell).CreateShortcut(path);
            try
            {
                shortcut.TargetPath = Environment.ProcessPath ??
                    throw new InvalidOperationException("Could not locate the Child Session host executable.");
                shortcut.WorkingDirectory = runDirectory;
                // Escape a trailing backslash before the closing command-line quote.
                var escapedDirectory = Path.EndsInDirectorySeparator(runDirectory) ? runDirectory + "\\" : runDirectory;
                shortcut.Arguments = $"--bridge-config \"{escapedDirectory}\" {nonce} {parentSessionId} {Environment.ProcessId}";
                shortcut.Save();
            }
            finally
            {
                Marshal.ReleaseComObject(shortcut);
            }
            if (!File.Exists(path))
                throw new IOException("The broker startup shortcut could not be created.");
            return path;
        }
        catch
        {
            File.Delete(path);
            throw;
        }
        finally
        {
            Marshal.ReleaseComObject(shell);
        }
    }
}
