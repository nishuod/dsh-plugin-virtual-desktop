using System.Diagnostics;
using System.IO.Pipes;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;

// Runs on the logged-in child's original STA thread, before the Node environment
// is reduced. Its private endpoint only admits the exact bridge process it owns.
internal sealed class AppBroker : IDisposable
{
    private readonly string name = $"DSH.AppBroker.{Guid.NewGuid():N}";
    private readonly string nonce = Convert.ToHexString(RandomNumberGenerator.GetBytes(32)).ToLowerInvariant();
    private readonly NamedPipeServerStream pipe;
    private readonly CancellationTokenSource lifetime = new();
    private readonly Control dispatcher = new() { Visible = false };
    private readonly int session = Process.GetCurrentProcess().SessionId;
    private readonly JsonSerializerOptions json = new(JsonSerializerDefaults.Web);
    public AppBroker() { pipe = LocalPipe.Create(name); _ = dispatcher.Handle; }
    public void Configure(ProcessStartInfo start)
    {
        start.Environment["DSH_APP_PIPE"] = @"\\.\pipe\" + name;
        start.Environment["DSH_APP_NONCE"] = nonce;
        start.Environment["DSH_APP_PID"] = Environment.ProcessId.ToString();
    }
    public int Run(Process bridge)
    {
        var service = Task.Run(() => Serve(bridge));
        _ = Task.Run(async () => {
            await bridge.WaitForExitAsync();
            if (!dispatcher.IsDisposed) dispatcher.BeginInvoke((Action)Application.ExitThread);
        });
        Application.Run();
        lifetime.Cancel();
        pipe.Dispose();
        try { service.Wait(TimeSpan.FromSeconds(2)); } catch { }
        return bridge.HasExited ? bridge.ExitCode : 1;
    }
    private async Task Serve(Process bridge)
    {
        var token = lifetime.Token;
        try
        {
            while (!token.IsCancellationRequested && !bridge.HasExited)
            {
                await pipe.WaitForConnectionAsync(token);
                try
                {
                    if (LocalPipe.ClientProcessId(pipe) != bridge.Id || LocalPipe.ClientSessionId(pipe) != session)
                        throw new UnauthorizedAccessException("Application launch peer is not the owned child bridge.");
                    using var requestTimeout = CancellationTokenSource.CreateLinkedTokenSource(token);
                    requestTimeout.CancelAfter(TimeSpan.FromSeconds(12));
                    var reader = new BoundedLineReader(pipe, 8192);
                    var line = await reader.ReadAsync(requestTimeout.Token);
                    if (line is null) throw new InvalidDataException("Invalid application broker request.");
                    using var document = JsonDocument.Parse(line);
                    var root = document.RootElement;
                    if (root.GetProperty("version").GetInt32() != 1 || root.GetProperty("nonce").GetString() != nonce ||
                        root.GetProperty("id").GetString() is not { } id || !Guid.TryParse(id, out _))
                        throw new UnauthorizedAccessException("Application broker authentication failed.");
                    object reply;
                    try
                    {
                        object value;
                        if (root.TryGetProperty("kind", out var kind))
                        {
                            if (kind.GetString() != "vmware-command")
                                throw new InvalidDataException("Unknown application broker request kind.");
                            var request = root.Deserialize<VmwareCommands.Request>(json) ?? throw new InvalidDataException("Invalid VMware command request.");
                            value = await Command(request, reader, bridge, token);
                        }
                        else
                        {
                            var request = root.Deserialize<Request>(json) ?? throw new InvalidDataException("Invalid application launch request.");
                            value = await DispatchLaunch(request, bridge, requestTimeout.Token);
                        }
                        reply = new { version = 1, id, ok = true, value };
                    }
                    catch (Exception error) { reply = new { version = 1, id, ok = false, error = error.Message }; }
                    // DisconnectNamedPipe discards unread bytes. The bridge closes after
                    // parsing the reply. Give it a bounded opportunity to consume the line.
                    using var delivery = CancellationTokenSource.CreateLinkedTokenSource(token);
                    delivery.CancelAfter(TimeSpan.FromSeconds(5));
                    var response = Encoding.UTF8.GetBytes(JsonSerializer.Serialize(reply, json) + "\n");
                    await pipe.WriteAsync(response, delivery.Token);
                    if (await reader.ReadAsync(delivery.Token) is not null)
                        throw new InvalidDataException("Only one application broker request is allowed per connection.");
                }
                catch (Exception) when (!token.IsCancellationRequested) { /* Disconnect malformed or cancelled peer requests. */ }
                finally { if (pipe.IsConnected) pipe.Disconnect(); }
            }
        }
        catch (Exception) when (token.IsCancellationRequested) { }
        catch { if (!dispatcher.IsDisposed) dispatcher.BeginInvoke((Action)Application.ExitThread); }
    }
    private async Task<object> DispatchLaunch(Request request, Process bridge, CancellationToken token)
    {
        var completion = new TaskCompletionSource<object>(TaskCreationOptions.RunContinuationsAsynchronously);
        dispatcher.BeginInvoke((Action)(() =>
        {
            try
            {
                token.ThrowIfCancellationRequested();
                RequireBridge(bridge);
                completion.SetResult(Launch(request));
            }
            catch (Exception error) { completion.SetException(error); }
        }));
        return await completion.Task.WaitAsync(token);
    }

    private async Task<object> Command(VmwareCommands.Request request, BoundedLineReader reader, Process bridge, CancellationToken token)
    {
        // One request per authenticated pipe connection. EOF or any further request revokes this command.
        using var command = CancellationTokenSource.CreateLinkedTokenSource(token);
        using var monitor = CancellationTokenSource.CreateLinkedTokenSource(token);
        var watch = WatchPeer(reader, command, monitor.Token);
        try
        {
            return await VmwareCommands.Execute(request, session, () => RequireBridge(bridge), command.Token);
        }
        finally
        {
            monitor.Cancel();
            await watch;
        }
    }

    private static async Task WatchPeer(BoundedLineReader reader, CancellationTokenSource command, CancellationToken token)
    {
        try { await reader.ReadAsync(token); }
        catch (OperationCanceledException) when (token.IsCancellationRequested) { return; }
        catch (IOException) { }
        catch (InvalidDataException) { }
        catch (ObjectDisposedException) { }
        if (!token.IsCancellationRequested) command.Cancel();
    }

    private void RequireBridge(Process bridge)
    {
        if (bridge.HasExited || bridge.SessionId != session) throw new UnauthorizedAccessException("Child bridge identity has been revoked.");
    }

    private object Launch(Request request)
    {
        var path = request.Path;
        if (string.IsNullOrEmpty(path) || path.Length > 1024 || !Path.IsPathFullyQualified(path) ||
            Path.GetPathRoot(path) is not { Length: 3 } || path[1] != ':' || path[2..].Contains(':') ||
            path.Any(ch => char.IsControl(ch) || ch is '"' or '<' or '>' or '|' or '?' or '*') ||
            !path.EndsWith(".exe", StringComparison.OrdinalIgnoreCase) || !File.Exists(path))
            throw new InvalidDataException("An existing absolute local .exe path is required.");
        // open uses ShellExecuteExW on this STA thread. No command interpreter,
        // no runas verb, no command-line parameters and no parent-session fallback.
        var start = new ProcessStartInfo(path) { UseShellExecute = true, Verb = "open", WorkingDirectory = Path.GetDirectoryName(path), WindowStyle = ProcessWindowStyle.Normal };
        using var process = Process.Start(start);
        if (process is null) throw new InvalidOperationException("Shell activation returned no process; inspect for an existing instance before retrying.");
        if (process.HasExited) throw new InvalidOperationException("Application launcher exited; no live process could be verified. Do not blindly retry.");
        if (process.SessionId != session) throw new InvalidOperationException("Application was activated outside the verified child session.");
        return new { path, pid = process.Id, sessionId = session, backend = "native-shell" };
    }
    public void Dispose() { lifetime.Cancel(); pipe.Dispose(); dispatcher.Dispose(); lifetime.Dispose(); }
    [JsonUnmappedMemberHandling(JsonUnmappedMemberHandling.Disallow)]
    private sealed record Request(int Version, string Id, string Nonce, string Path);
}
