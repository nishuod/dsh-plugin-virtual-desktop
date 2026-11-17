using System.Diagnostics;
using System.IO.Pipes;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

internal sealed class ChildSessionBroker(string runDirectory, int parentSessionId)
{
    private const int StartupSeconds = 60;
    private const int MaxConfigBytes = 16 * 1024;
    private const string PipePrefix = @"\\.\pipe\";
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);
    private static readonly byte[] Newline = [(byte)'\n'];
    private static readonly string[] WorkerEnvironment =
        ["SystemRoot", "WINDIR", "TEMP", "TMP", "USERPROFILE", "LOCALAPPDATA", "APPDATA"];

    private readonly CancellationTokenSource stopping = new();
    private readonly TaskCompletionSource<uint> session = new(TaskCreationOptions.RunContinuationsAsynchronously);
    private readonly string nonce = Convert.ToHexString(RandomNumberGenerator.GetBytes(32)).ToLowerInvariant();
    private readonly string pipeName = $"DSH.ChildSession.{Guid.NewGuid():N}";
    private readonly Stream stdout = Console.OpenStandardOutput();
    private readonly object bindingGate = new();
    private string? failure;
    private string? shortcutPath;
    private bool bindingWritten;

    public static int Run(string directory)
    {
        try
        {
            var run = GetRunDirectory(directory);
            using var current = Process.GetCurrentProcess();
            if (current.SessionId <= 0)
                throw new InvalidOperationException("The broker must run in an interactive parent session.");
            return new ChildSessionBroker(run, current.SessionId).RunViewer();
        }
        catch (Exception error)
        {
            WriteEvent(Console.OpenStandardOutput(), new { @event = "error", message = error.Message,
                reason = "child-session-unavailable", association = error is ActiveChildSessionException ? "active" : "unknown", retryAfterMs = 500, nextTool = "desktop_get_task_status" });
            return 1;
        }
    }

    private int RunViewer()
    {
        using var instance = new Mutex(false, @"Local\DSHarness.ChildSessionHost");
        if (!TakeMutex(instance))
            throw new ActiveChildSessionException("A Harness Child Session viewer is already running; reuse its owning connection.");

        Task? transport = null;
        try
        {
            _ = ReadConfig(runDirectory);
            OwnedSessionRecovery.ValidateConfig(runDirectory);
            if (File.Exists(BindingPath))
                throw new InvalidOperationException("The broker run directory already has a session binding.");
            if (Sessions.GetChildId() is not null)
                throw new InvalidOperationException("The current Windows session already has a child session.");

            OwnedSessionRecovery.RecordStart(runDirectory, parentSessionId, nonce);
            using var endpoint = LocalPipe.Create(pipeName);
            try
            {
                shortcutPath = StartupLink.Create(runDirectory, nonce, parentSessionId);
                ApplicationConfiguration.Initialize();
                var status = new StatusFile(Path.Combine(runDirectory, "viewer-status.json"), parentSessionId);
                status.Write("starting");
                using var viewer = new Viewer(status, logoffOnClose: true);
                viewer.SessionVerified += id => {
                    OwnedSessionRecovery.Record(runDirectory, parentSessionId, id);
                    session.TrySetResult(id);
                };
                viewer.SessionStopped += message =>
                {
                    Stop(message);
                    endpoint.Dispose();
                };
                viewer.FormClosing += (_, _) =>
                {
                    if (!stopping.IsCancellationRequested)
                        Stop("The Child Session preview was closed.");
                    endpoint.Dispose();
                };
                viewer.Shown += (_, _) => transport = Task.Run(() => RunTransport(viewer, endpoint));
                Application.Run(viewer);
            }
            finally
            {
                Stop();
                endpoint.Dispose();
                transport?.Wait(TimeSpan.FromSeconds(2));
            }
        }
        catch (Exception error)
        {
            Stop(error.Message);
        }
        finally
        {
            // Viewer close submits an asynchronous WTS logoff. Keep our instance mutex until
            // Windows has removed this exact verified association, so an immediate next
            // broker cannot collide with the child session that is still signing out.
            if (session.Task.IsCompletedSuccessfully)
            {
                var owned = session.Task.Result;
                var joining = Stopwatch.StartNew();
                try
                {
                    while (Sessions.GetChildId() == owned && joining.Elapsed.TotalSeconds < 8)
                        Thread.Sleep(50);
                    if (Sessions.GetChildId() == owned)
                        Stop("The previous Windows child session is still signing out. Retry after the cleanup completes.");
                }
                catch (Exception error) { Stop(error.Message); }
            }
            RemoveShortcut();
            lock (bindingGate)
            {
                if (bindingWritten)
                    RemoveFile(BindingPath);
            }
            instance.ReleaseMutex();
        }

        if (failure is not { } message)
            return 0;
        if (Monitor.TryEnter(stdout, TimeSpan.FromSeconds(1)))
        {
            try
            {
                WriteEvent(stdout, new { @event = "error", message, reason = "child-session-unavailable",
                    association = session.Task.IsCompletedSuccessfully ? "orphan" : "unknown", retryAfterMs = 500, nextTool = "desktop_reset_child_session" });
            }
            finally
            {
                Monitor.Exit(stdout);
            }
        }
        return 1;
    }

    private async Task RunTransport(Viewer viewer, NamedPipeServerStream endpoint)
    {
        var token = stopping.Token;
        using var startup = CancellationTokenSource.CreateLinkedTokenSource(token);
        startup.CancelAfter(TimeSpan.FromSeconds(StartupSeconds));
        try
        {
            var parent = new BoundedLineReader(Console.OpenStandardInput());
            var child = new BoundedLineReader(endpoint);
            var firstParentLine = Task.Run(() => parent.ReadAsync(token), token);
            var authenticate = Authenticate(endpoint, child, startup.Token);
            var first = await Task.WhenAny(firstParentLine, authenticate).WaitAsync(token);
            if (first == firstParentLine && await firstParentLine is null)
                return;

            var childId = await authenticate;
            RemoveShortcut();
            token.ThrowIfCancellationRequested();
            if (Sessions.GetChildId() != childId)
                throw new InvalidOperationException("The Windows child-session binding was lost during startup.");
            var actualDisplay = Sessions.GetClientDisplay(childId);
            WriteEvent(stdout, new
            {
                @event = "ready", parentSessionId, childSessionId = childId,
                pipDisplay = new
                {
                    requested = new Sessions.DisplayResolution(RdpControl.RequestedDesktopWidth, RdpControl.RequestedDesktopHeight),
                    actual = actualDisplay,
                    source = "wts-client-display",
                    sampledAt = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()
                }
            });

            var sending = RelayToChild(firstParentLine, parent, endpoint, childId, token);
            var receiving = RelayToParent(child, token);
            var finished = await Task.WhenAny(sending, receiving).WaitAsync(token);
            await finished;
        }
        catch (Exception) when (token.IsCancellationRequested)
        {
            // A viewer or another transport direction already revoked this run.
        }
        catch (OperationCanceledException)
        {
            Stop("The child-session bridge did not authenticate before the startup deadline.");
        }
        catch (Exception error)
        {
            Stop(error.Message);
        }
        finally
        {
            Stop();
            endpoint.Dispose();
            if (viewer.IsHandleCreated && !viewer.IsDisposed)
            {
                try { viewer.BeginInvoke((Action)viewer.Close); }
                catch (InvalidOperationException) { }
            }
        }
    }

    private async Task<uint> Authenticate(NamedPipeServerStream endpoint, BoundedLineReader child,
        CancellationToken token)
    {
        var expected = await session.Task.WaitAsync(token);
        if (expected == 0 || expected == parentSessionId || Sessions.GetChildId() != expected)
            throw new InvalidOperationException("Windows did not confirm the expected child-session binding.");

        var binding = new Binding(1, PipePrefix + pipeName, parentSessionId, expected, nonce);
        var temporary = $"{BindingPath}.{nonce}.tmp";
        lock (bindingGate)
        {
            token.ThrowIfCancellationRequested();
            try
            {
                File.WriteAllBytes(temporary, JsonSerializer.SerializeToUtf8Bytes(binding, Json));
                File.Move(temporary, BindingPath);
                bindingWritten = true;
            }
            finally
            {
                File.Delete(temporary);
            }
        }

        await endpoint.WaitForConnectionAsync(token);
        if (LocalPipe.ClientSessionId(endpoint) != expected)
            throw new UnauthorizedAccessException("Named-pipe client is outside the verified child session.");

        var line = await child.ReadAsync(token) ??
            throw new EndOfStreamException("The child bridge closed before authentication.");
        var hello = JsonSerializer.Deserialize<Hello>(line, Json);
        if (hello is null || hello.Version != 1 || hello.SessionId != expected || !MatchesNonce(hello.Nonce, nonce))
            throw new UnauthorizedAccessException("The child bridge authentication failed.");
        return expected;
    }

    private static async Task RelayToChild(Task<byte[]?> first, BoundedLineReader parent,
        Stream endpoint, uint childId, CancellationToken token)
    {
        var line = await first;
        while (line is not null)
        {
            token.ThrowIfCancellationRequested();
            if (Sessions.GetChildId() != childId)
                throw new InvalidOperationException("The Windows child-session binding was lost.");
            await endpoint.WriteAsync(line, token);
            await endpoint.WriteAsync(Newline, token);
            line = await parent.ReadAsync(token);
        }
    }

    private async Task RelayToParent(BoundedLineReader child, CancellationToken token)
    {
        while (await child.ReadAsync(token) is { } line)
        {
            token.ThrowIfCancellationRequested();
            WriteLine(stdout, line);
        }
        throw new EndOfStreamException("The child-session bridge disconnected.");
    }

    public static int StartBridge(string directory, string nonce, string parent, string broker)
    {
        try
        {
            var run = GetRunDirectory(directory);
            if (!ValidNonce(nonce) || !int.TryParse(parent, out var parentId) || parentId <= 0 ||
                !int.TryParse(broker, out var brokerId) || brokerId <= 0)
                return 2;
            using var current = Process.GetCurrentProcess();
            if (current.SessionId <= 0 || current.SessionId == parentId)
                return 2;

            using var brokerProcess = Process.GetProcessById(brokerId);
            if (brokerProcess.SessionId != parentId)
                return 2;

            var bindingPath = Path.Combine(run, "broker-binding.json");
            var clock = Stopwatch.StartNew();
            while (!File.Exists(bindingPath))
            {
                if (brokerProcess.HasExited || clock.Elapsed.TotalSeconds >= StartupSeconds)
                    return 1;
                Thread.Sleep(100);
            }
            var binding = ReadSmallJson<Binding>(bindingPath);
            if (binding.Version != 1 || binding.ParentSessionId != parentId ||
                binding.ChildSessionId != current.SessionId || !MatchesNonce(binding.Nonce, nonce) ||
                brokerProcess.HasExited)
                return 2;

            var config = ReadConfig(run);
            var start = new ProcessStartInfo(config.NodePath)
            {
                UseShellExecute = false,
                CreateNoWindow = true,
                WorkingDirectory = run
            };
            start.ArgumentList.Add(config.BridgePath);
            start.ArgumentList.Add(run);
            start.Environment.Clear();
            foreach (var key in WorkerEnvironment)
            {
                if (Environment.GetEnvironmentVariable(key) is { } value)
                    start.Environment[key] = value;
            }
            if (config.ElectronNode)
                start.Environment["ELECTRON_RUN_AS_NODE"] = "1";
            using var applications = new AppBroker();
            applications.Configure(start);
            using var worker = Process.Start(start);
            if (worker is null)
                return 1;
            if (worker.SessionId != current.SessionId)
            {
                worker.Kill(entireProcessTree: true);
                return 2;
            }
            return applications.Run(worker);
        }
        catch (Exception)
        {
            return 1;
        }
    }

    private string BindingPath => Path.Combine(runDirectory, "broker-binding.json");

    private static bool TakeMutex(Mutex mutex)
    {
        try { return mutex.WaitOne(0); }
        catch (AbandonedMutexException) { return true; }
    }

    private void Stop(string? message = null)
    {
        if (message is not null)
            Interlocked.CompareExchange(ref failure, message, null);
        stopping.Cancel();
    }

    private void RemoveShortcut()
    {
        if (Volatile.Read(ref shortcutPath) is { } path && RemoveFile(path))
            Interlocked.CompareExchange(ref shortcutPath, null, path);
    }

    private bool RemoveFile(string path)
    {
        for (var attempt = 0; ; attempt++)
        {
            try
            {
                File.Delete(path);
                return true;
            }
            catch (IOException error) when (attempt < 4 && (error.HResult & 0xffff) is 32 or 33)
            {
                Thread.Sleep(50);
            }
            catch (Exception error) when (error is IOException or UnauthorizedAccessException)
            {
                Stop($"Could not remove {Path.GetFileName(path)}: {error.Message}");
                return false;
            }
        }
    }

    private static string GetRunDirectory(string path)
    {
        if (!IsLocalPath(path) || !Directory.Exists(path))
            throw new ArgumentException("The broker requires an existing absolute local run directory.");
        return Path.TrimEndingDirectorySeparator(Path.GetFullPath(path));
    }

    private static Config ReadConfig(string directory)
    {
        var config = ReadSmallJson<Config>(Path.Combine(directory, "broker-config.json"));
        if (config.Version != 1 || !IsLocalPath(config.NodePath) || !IsLocalPath(config.BridgePath) ||
            !File.Exists(config.NodePath) || !File.Exists(config.BridgePath))
            throw new InvalidDataException("Invalid child-session broker configuration.");
        return config;
    }

    private static T ReadSmallJson<T>(string path)
    {
        using var file = File.OpenRead(path);
        if (file.Length > MaxConfigBytes)
            throw new InvalidDataException("The child-session configuration is too large.");
        return JsonSerializer.Deserialize<T>(file, Json) ??
            throw new InvalidDataException("Invalid child-session configuration.");
    }

    private static bool IsLocalPath(string? path) => path is not null &&
        Path.IsPathFullyQualified(path) && Path.GetPathRoot(path) is { Length: 3 } root && root[1] == ':';

    private static bool ValidNonce(string? value) => value is { Length: 64 } &&
        value.All(ch => ch is >= '0' and <= '9' or >= 'a' and <= 'f');

    private static bool MatchesNonce(string? actual, string expected) => ValidNonce(actual) &&
        CryptographicOperations.FixedTimeEquals(Encoding.ASCII.GetBytes(actual!), Encoding.ASCII.GetBytes(expected));

    private static void WriteEvent(Stream stream, object value) =>
        WriteLine(stream, JsonSerializer.SerializeToUtf8Bytes(value, Json));

    private static void WriteLine(Stream stream, byte[] line)
    {
        lock (stream)
        {
            stream.Write(line);
            stream.Write(Newline);
            stream.Flush();
        }
    }

    private sealed record Config(int Version, string NodePath, string BridgePath, bool ElectronNode);
    private sealed record Binding(int Version, string PipePath, int ParentSessionId, uint ChildSessionId, string Nonce);
    private sealed record Hello(int Version, string Nonce, uint SessionId);
}

internal sealed class BoundedLineReader(Stream stream, int maxLineBytes = 2 * 1024 * 1024)
{
    private readonly byte[] buffer = new byte[8192];
    private int start;
    private int end;

    public async Task<byte[]?> ReadAsync(CancellationToken token)
    {
        using var line = new MemoryStream();
        while (true)
        {
            if (start == end)
            {
                var count = await stream.ReadAsync(buffer.AsMemory(), token);
                start = 0;
                end = count;
                if (end == 0)
                    return line.Length == 0 ? null : throw new EndOfStreamException("Incomplete broker protocol line.");
            }

            var newline = Array.IndexOf(buffer, (byte)'\n', start, end - start);
            var length = (newline == -1 ? end : newline) - start;
            if (line.Length + length > maxLineBytes)
                throw new InvalidDataException("Broker protocol line exceeds its size limit.");
            line.Write(buffer, start, length);
            start += length;
            if (newline != -1)
            {
                start++;
                if (line.Length == 0)
                    throw new InvalidDataException("Empty broker protocol line.");
                return line.ToArray();
            }
        }
    }
}

internal sealed class ActiveChildSessionException(string message) : Exception(message);
