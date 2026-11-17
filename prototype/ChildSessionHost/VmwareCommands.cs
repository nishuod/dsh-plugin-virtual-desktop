using System.ComponentModel;
using System.Diagnostics;
using System.Globalization;
using System.Text;
using System.Text.Json.Serialization;

// This is an application-specific protocol. Callers never supply an executable
// or an arbitrary argument vector.
internal static class VmwareCommands
{
    private const int DiagnosticLimit = 4096;
    private const int ListOutputLimit = 65536;
    private const int EvidenceLimit = 16;
    private static readonly StringComparer Paths = StringComparer.OrdinalIgnoreCase;

    [JsonUnmappedMemberHandling(JsonUnmappedMemberHandling.Disallow)]
    internal sealed record Request(int Version, string Id, string Nonce, string Kind, string VmwarePath,
        int VmwarePid, string VmwareBirth, string VmwareHwnd, string Command, string? VmxPath, int TimeoutMs);

    internal sealed record ProcessCheck(int Pid, string VmxPath, long? CpuMs);
    internal sealed record Evidence(string[] VmrunList, ProcessCheck[] ProcessCheck);
    internal sealed record Receipt(string Status, string State, string Message, string? Vmx,
        [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] int? RunningCount,
        [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] int? VmPid,
        int? ExitCode, int ChildSessionId, Evidence Evidence, long ElapsedMs, string[] Argv,
        int? VmrunPid, string Stdout, string Stderr,
        [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] string? Code,
        bool FallbackAllowed);

    private sealed record Output(string Text, bool Truncated);
    private sealed record Execution(int ExitCode, Output Stdout, Output Stderr);
    private sealed record Observation(string[] Listed, VmwareProcessEvidence.Snapshot Processes);
    private sealed class CommandFailure(string code, string message, bool fallbackAllowed = false) : Exception(message)
    {
        public string Code { get; } = code;
        public bool FallbackAllowed { get; } = fallbackAllowed;
    }

    internal static async Task<Receipt> Execute(Request request, int session, Action requireBridge, CancellationToken revoked)
    {
        var clock = Stopwatch.StartNew();
        var argv = Array.Empty<string>();
        string? vmx = null;
        int? vmrunPid = null;
        var mutationStarted = false;
        Execution? execution = null;
        Observation? observation = null;
        using var deadline = CancellationTokenSource.CreateLinkedTokenSource(revoked);
        var token = deadline.Token;

        Receipt Result(string status, string state, string message, string? code = null, bool fallbackAllowed = false)
        {
            var evidence = VisibleEvidence(observation, session, vmx);
            var vmPid = vmx is not null && evidence.ProcessCheck.Length == 1 ? evidence.ProcessCheck[0].Pid : (int?)null;
            // vmrun list may contain VMs from other sessions. Expose only rows
            // corroborated by the verified child VMX process inventory.
            var stdout = request.Command == "list" && observation is not null
                ? string.Join("\n", new[] { $"Total verified child VMs: {evidence.VmrunList.Length}" }.Concat(evidence.VmrunList))
                : request.Command == "list" ? "" : execution?.Stdout.Text ?? "";
            var runningCount = state == "listed" ? evidence.VmrunList.Length : (int?)null;
            return new Receipt(status, state, Limit(message, 1000), vmx, runningCount, vmPid, execution?.ExitCode,
                session, evidence, clock.ElapsedMilliseconds, argv, vmrunPid, Limit(stdout, DiagnosticLimit),
                Limit(execution?.Stderr.Text ?? "", DiagnosticLimit), code, fallbackAllowed);
        }

        try
        {
            ValidateRequest(request);
            deadline.CancelAfter(request.TimeoutMs);
            var vmware = RequireCanonical(request.VmwarePath, ".exe");
            if (!Paths.Equals(Path.GetFileName(vmware), "vmware.exe"))
                throw new CommandFailure("wrong-application", "The authenticated owner is not VMware Workstation.");
            var installDirectory = Path.GetDirectoryName(vmware)!;
            using var owner = new VmwareProcessEvidence.Owner(request.VmwarePid, request.VmwareHwnd,
                request.VmwareBirth, session, vmware);
            void Guard()
            {
                token.ThrowIfCancellationRequested();
                requireBridge();
                owner.RequireCurrent();
            }
            Guard();
            if (request.Command != "list")
                vmx = RequireCanonical(request.VmxPath!, ".vmx");
            argv = Arguments(request.Command, vmx);
            var expectedVmrun = Path.Combine(installDirectory, "vmrun.exe");
            if (!File.Exists(expectedVmrun))
            {
                var processes = VmwareProcessEvidence.Observe(installDirectory, token);
                var fallback = vmx is not null && processes.Complete &&
                    (request.Command == "start"
                        ? !processes.Processes.Any(p => Paths.Equals(p.VmxPath, vmx))
                        : processes.Processes.Count(p => Paths.Equals(p.VmxPath, vmx)) == 1 &&
                          processes.Processes.Any(p => Paths.Equals(p.VmxPath, vmx) && p.Session == session));
                Guard();
                return Result("failed", "unknown", "vmrun.exe is missing beside the verified Workstation installation.",
                    "vmrun-missing", fallback);
            }
            var vmrun = RequireCanonical(expectedVmrun, ".exe");

            async Task<Execution> List(bool topLevel)
            {
                Guard();
                var result = await Run(vmrun, installDirectory, Arguments("list", null), session, Guard,
                    pid => { if (topLevel) vmrunPid = pid; }, token);
                if (topLevel) execution = result;
                return result;
            }

            Observation Observe(Execution list)
            {
                Guard();
                if (list.ExitCode != 0) throw new CommandFailure(Classify(list, "list-failed"), "vmrun list did not provide a usable inventory.");
                var paths = ParseList(list.Stdout);
                var processes = VmwareProcessEvidence.Observe(installDirectory, token);
                Guard();
                return new Observation(paths, processes);
            }

            observation = Observe(await List(request.Command == "list"));
            if (request.Command == "list")
            {
                var evidence = VisibleEvidence(observation, session, null);
                var complete = observation.Processes.Complete &&
                    observation.Listed.All(path => Matching(observation, path).Length == 1) &&
                    observation.Processes.Processes.Where(p => p.Session == session).All(p => Listed(observation, p.VmxPath)) &&
                    evidence.VmrunList.Length == observation.Processes.Processes.Count(p => p.Session == session);
                return complete
                    ? Result("confirmed", "listed", $"Verified {evidence.VmrunList.Length} running VM(s) in the child session.")
                    : Result("unknown", "unknown", "Some vmrun or process entries could not be attributed. Only corroborated child VMs are shown.", "unverified-vm-process");
            }

            var target = vmx!;
            var before = Matching(observation, target);
            var wasListed = Listed(observation, target);
            if (before.Any(process => process.Session != session))
                return Result("failed", "unknown", "The VM belongs to another Windows session.", "foreign-session");
            if (!observation.Processes.Complete || before.Length > 1 || wasListed != (before.Length == 1))
                return Result("failed", "unknown", "vmrun and the process inventory do not identify a unique VM in this child session.", "unverified-vm-process");
            if (request.Command == "start" && before.Length == 1)
                return Result("confirmed", "running", "The VM was already verified running in this child session.");
            if (request.Command != "start" && before.Length == 0)
                return Result("failed", "unknown", "This command requires a verified running VM in this child session.", "vm-not-running");

            var dispatchTime = DateTime.UtcNow;
            execution = await Run(vmrun, installDirectory, argv, session, () =>
            {
                RequireCanonical(target, ".vmx");
                var current = VmwareProcessEvidence.Observe(installDirectory, token);
                var matches = current.Processes.Where(process => Paths.Equals(process.VmxPath, target)).ToArray();
                var sameTarget = current.Complete && matches.Length == before.Length &&
                    (matches.Length == 0 || (matches[0].Session == session && matches[0].Pid == before[0].Pid &&
                      matches[0].Birth == before[0].Birth));
                if (!sameTarget)
                    throw new CommandFailure("vm-process-changed", "The target VM process changed before dispatch.");
                Guard();
            }, pid =>
            {
                vmrunPid = pid;
                mutationStarted = true;
            }, token);

            if (execution.ExitCode != 0)
            {
                var code = Classify(execution, "vmrun-failed");
                observation = null;
                try { observation = Observe(await List(false)); }
                catch (Exception error) when (!revoked.IsCancellationRequested && error is
                    (CommandFailure or OperationCanceledException or IOException or Win32Exception or UnauthorizedAccessException))
                {
                    // Keep the actual vmrun error even if the follow-up inventory is unavailable.
                }
                return Result("unknown", "unknown", "vmrun returned an error after dispatch. Inspect the current VM state before taking another action.",
                    code);
            }

            while (true)
            {
                observation = Observe(await List(false));
                var after = Matching(observation, target);
                var isListed = Listed(observation, target);
                if (after.Any(process => process.Session != session))
                    return Result("unknown", "unknown", "A VM process in another Windows session was observed after dispatch.", "foreign-session");
                if (observation.Processes.Complete)
                {
                    if (request.Command == "start" && isListed && after.Length == 1)
                        return Result("confirmed", "running", "vmrun list and the child VMX process both confirm that the VM is running.");
                    if (request.Command == "stop" && !isListed && after.Length == 0)
                        return Result("confirmed", "stopped", "vmrun list and the child process inventory both confirm that the VM stopped.");
                    if (request.Command == "suspend" && !isListed && after.Length == 0 && HasFreshSuspendState(target, dispatchTime))
                        return Result("confirmed", "suspended", "The VM left the running inventory and wrote a fresh suspend checkpoint.");
                    if (request.Command == "reset" && isListed && after.Length == 1)
                        return Result("unknown", "unknown", "vmrun accepted reset and the VM is running. These observations cannot verify a guest reboot.", "guest-reboot-unverified");
                }
                await Task.Delay(750, token);
            }
        }
        catch (OperationCanceledException)
        {
            var revokedByPeer = revoked.IsCancellationRequested;
            return Result(mutationStarted ? "unknown" : "failed", "unknown",
                revokedByPeer ? "The VMware command authorization was revoked." : "VMware command verification reached its time limit.",
                revokedByPeer ? "revoked" : "timeout");
        }
        catch (CommandFailure error)
        {
            return Result(mutationStarted ? "unknown" : "failed", "unknown", error.Message, error.Code,
                !mutationStarted && error.FallbackAllowed);
        }
        catch (UnauthorizedAccessException error)
        {
            return Result(mutationStarted ? "unknown" : "failed", "unknown", error.Message, "auth-required");
        }
        catch (Win32Exception error) when (error.NativeErrorCode is 5 or 740)
        {
            return Result(mutationStarted ? "unknown" : "failed", "unknown", error.Message, "auth-required");
        }
        catch (IOException error)
        {
            var sharingViolation = (error.HResult & 0xffff) is 32 or 33;
            return Result(mutationStarted ? "unknown" : "failed", "unknown", error.Message, sharingViolation ? "vmx-locked" : "path-unavailable");
        }
        catch (Exception error) when (error is InvalidDataException or ArgumentException or Win32Exception or InvalidOperationException)
        {
            return Result(mutationStarted ? "unknown" : "failed", "unknown", error.Message, "vm-command-refused");
        }
    }

    private static void ValidateRequest(Request request)
    {
        var validTimeout = request.Command switch
        {
            "list" => request.TimeoutMs == 10000,
            "start" => request.TimeoutMs is >= 30000 and <= 180000,
            "stop" => request.TimeoutMs is >= 15000 and <= 60000,
            "suspend" or "reset" => request.TimeoutMs is >= 10000 and <= 30000,
            _ => false
        };
        if (!validTimeout || (request.Command == "list") != (request.VmxPath is null))
            throw new CommandFailure("invalid-command", "Invalid VMware command, target, or time limit.");
    }

    private static string[] Arguments(string command, string? vmx) => command switch
    {
        "list" when vmx is null => ["-T", "ws", "list"],
        "start" when vmx is not null => ["-T", "ws", "start", vmx, "nogui"],
        "stop" or "suspend" or "reset" when vmx is not null => ["-T", "ws", command, vmx],
        _ => throw new CommandFailure("invalid-command", "Unsupported VMware argument template.")
    };

    private static string RequireCanonical(string path, string extension)
    {
        var canonical = VmwareProcessEvidence.CanonicalFile(path, extension);
        if (!Paths.Equals(path.Replace('/', '\\'), canonical))
            throw new CommandFailure("path-changed", "The authorized file path changed or resolves through an alias.");
        return canonical;
    }

    private static string[] ParseList(Output output)
    {
        var lines = output.Text.Split(['\r', '\n'], StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
        const string prefix = "Total running VMs:";
        if (output.Truncated || lines.Length == 0 || !lines[0].StartsWith(prefix, StringComparison.Ordinal) ||
            !int.TryParse(lines[0][prefix.Length..].Trim(), NumberStyles.None, CultureInfo.InvariantCulture, out var count) ||
            count != lines.Length - 1 || count > 256)
            throw new CommandFailure("unverified-vm-list", "vmrun list output could not be verified.");
        var paths = lines.Skip(1).Select(path => VmwareProcessEvidence.CanonicalFile(path, ".vmx")).ToArray();
        if (paths.Distinct(Paths).Count() != paths.Length)
            throw new CommandFailure("unverified-vm-list", "vmrun listed the same VM path more than once.");
        return paths;
    }

    private static bool Listed(Observation observation, string path) => observation.Listed.Contains(path, Paths);

    private static VmwareProcessEvidence.ObservedProcess[] Matching(Observation observation, string path) =>
        observation.Processes.Processes.Where(process => Paths.Equals(process.VmxPath, path)).ToArray();

    private static Evidence VisibleEvidence(Observation? observation, int session, string? vmx)
    {
        if (observation is null) return new Evidence([], []);
        var processes = observation.Processes.Processes
            .Where(process => process.Session == session && (vmx is null ? Listed(observation, process.VmxPath) : Paths.Equals(process.VmxPath, vmx)))
            .Take(EvidenceLimit)
            .Select(process => new ProcessCheck(process.Pid, process.VmxPath, process.CpuMs))
            .ToArray();
        var listed = vmx is not null
            ? observation.Listed.Where(path => Paths.Equals(vmx, path) && !Matching(observation, path).Any(process => process.Session != session))
            : processes.Select(process => process.VmxPath).Distinct(Paths);
        return new Evidence(listed.Take(EvidenceLimit).ToArray(), processes);
    }

    private static async Task<Execution> Run(string vmrun, string installDirectory, string[] argv, int session,
        Action guard, Action<int> onStarted, CancellationToken token)
    {
        RequireCanonical(vmrun, ".exe");
        var start = new ProcessStartInfo(vmrun)
        {
            UseShellExecute = false,
            CreateNoWindow = true,
            WorkingDirectory = installDirectory,
            RedirectStandardOutput = true,
            RedirectStandardError = true
        };
        foreach (var argument in argv) start.ArgumentList.Add(argument);
        guard();
        using var process = Process.Start(start) ?? throw new CommandFailure("vmrun-start-failed", "vmrun did not create a process.");
        onStarted(process.Id);
        try
        {
            if (process.SessionId != session)
                throw new CommandFailure("foreign-session", "vmrun was not created in the verified child session.");
            var stdout = ReadOutput(process.StandardOutput, ListOutputLimit, token);
            var stderr = ReadOutput(process.StandardError, DiagnosticLimit, token);
            await Task.WhenAll(process.WaitForExitAsync(token), stdout, stderr);
            return new Execution(process.ExitCode, await stdout, await stderr);
        }
        catch
        {
            // Only the process this call created. A VMX may already have been
            // started by Workstation. Its power state is never changed here.
            try { if (!process.HasExited) process.Kill(entireProcessTree: false); }
            catch (Exception error) when (error is InvalidOperationException or Win32Exception) { }
            throw;
        }
    }

    private static async Task<Output> ReadOutput(StreamReader reader, int limit, CancellationToken token)
    {
        var buffer = new char[4096];
        var text = new StringBuilder();
        var truncated = false;
        while (await reader.ReadAsync(buffer.AsMemory(), token) is var count && count != 0)
        {
            var kept = Math.Min(count, limit - text.Length);
            text.Append(buffer, 0, kept);
            truncated |= kept != count;
        }
        return new Output(text.ToString(), truncated);
    }

    private static string Classify(Execution execution, string fallback)
    {
        var text = execution.Stdout.Text + "\n" + execution.Stderr.Text;
        if (text.Contains("locked", StringComparison.OrdinalIgnoreCase) ||
            text.Contains("already in use", StringComparison.OrdinalIgnoreCase)) return "vmx-locked";
        if (text.Contains("password", StringComparison.OrdinalIgnoreCase) ||
            text.Contains("encrypt", StringComparison.OrdinalIgnoreCase) ||
            text.Contains("authentication", StringComparison.OrdinalIgnoreCase)) return "auth-required";
        return fallback;
    }

    private static bool HasFreshSuspendState(string vmx, DateTime dispatchTime)
    {
        try
        {
            using var file = new FileStream(vmx, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete);
            if (file.Length > 262144) return false;
            using var reader = new StreamReader(file);
            var buffer = new char[262145];
            var length = reader.ReadBlock(buffer);
            if (length == buffer.Length) return false;
            var directory = Path.GetDirectoryName(vmx)!;
            foreach (var line in new string(buffer, 0, length).Split('\n'))
            {
                var assignment = line.Split('=', 2);
                if (assignment.Length != 2 || !Paths.Equals(assignment[0].Trim(), "checkpoint.vmState")) continue;
                var state = assignment[1].Trim().Trim('"');
                if (string.IsNullOrEmpty(state)) return false;
                var fileName = VmwareProcessEvidence.CanonicalFile(Path.Combine(directory, state), ".vmss");
                var details = new FileInfo(fileName);
                return Paths.Equals(details.DirectoryName, directory) && details.Length > 0 &&
                    details.LastWriteTimeUtc >= dispatchTime.AddSeconds(-2);
            }
        }
        catch (Exception error) when (error is IOException or InvalidDataException or UnauthorizedAccessException or Win32Exception or ArgumentException) { }
        return false;
    }

    private static string Limit(string value, int limit) => value[..Math.Min(value.Length, limit)];
}
