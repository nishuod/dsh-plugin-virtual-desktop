using System.Runtime.InteropServices;

internal sealed class Viewer : Form
{
    private readonly StatusFile status;
    private readonly bool logoffOnClose;
    private readonly RdpControl rdp = new() { Dock = DockStyle.Fill };
    private readonly System.Windows.Forms.Timer sessionProbe = new() { Interval = 200 };
    private DateTimeOffset probeDeadline;
    private uint? childSessionId;
    private int? disconnectReason;
    private bool closing;

    public bool Failed { get; private set; }
    public event Action<uint>? SessionVerified;
    public event Action<string>? SessionStopped;

    public Viewer(StatusFile status, bool logoffOnClose)
    {
        this.status = status;
        this.logoffOnClose = logoffOnClose;
        Text = "Harness — Windows Child Session";
        ClientSize = new Size(1024, 640);
        StartPosition = FormStartPosition.CenterScreen;
        Controls.Add(rdp);
        rdp.LoginComplete += OnLoginComplete;
        rdp.Disconnected += OnDisconnected;
        rdp.FatalError += code => Fail($"Windows RDP reported fatal error {code}.");
        sessionProbe.Tick += (_, _) => ProbeSession();
    }

    protected override void OnShown(EventArgs e)
    {
        base.OnShown(e);
        try
        {
            if (Sessions.GetChildId() is not null)
                throw new InvalidOperationException("The current Windows session already has a child session.");
            status.Write("connecting");
            rdp.Connect();
        }
        catch (Exception error)
        {
            Fail(error.Message);
        }
    }

    private void OnLoginComplete()
    {
        if (closing || Failed)
            return;
        probeDeadline = DateTimeOffset.UtcNow.AddSeconds(5);
        ProbeSession();
        if (!Failed && childSessionId is null)
            sessionProbe.Start();
    }

    private void ProbeSession()
    {
        try
        {
            var id = Sessions.GetChildId();
            if (id is null)
            {
                if (DateTimeOffset.UtcNow >= probeDeadline)
                    Fail("Windows did not report a child session ID after login.");
                return;
            }
            if (id == 0 || id == status.ParentSessionId)
                throw new InvalidOperationException("Windows reported an invalid child session ID.");
            childSessionId = id;
            sessionProbe.Stop();
            status.Write("logged_in", childSessionId);
            SessionVerified?.Invoke(id.Value);
        }
        catch (Exception error)
        {
            Fail(error.Message);
        }
    }

    private void OnDisconnected(int reason)
    {
        disconnectReason = reason;
        sessionProbe.Stop();
        if (!closing && !Failed)
        {
            var message = $"Windows RDP disconnected ({reason}).";
            status.Write("disconnected", childSessionId, message, reason);
            SessionStopped?.Invoke(message);
        }
    }

    private void Fail(string message)
    {
        if (Failed)
            return;
        Failed = true;
        sessionProbe.Stop();
        status.Write("error", childSessionId, message, disconnectReason);
        SessionStopped?.Invoke(message);
        if (!closing)
            BeginInvoke((Action)Close);
    }

    protected override void OnFormClosing(FormClosingEventArgs e)
    {
        base.OnFormClosing(e);
        if (e.Cancel || closing)
            return;
        closing = true;
        sessionProbe.Stop();
        try
        {
            if (logoffOnClose && childSessionId is uint id && Sessions.GetChildId() == id)
                Sessions.Logoff(id);
        }
        catch (Exception error)
        {
            Fail(error.Message);
        }
        finally
        {
            rdp.Disconnect();
            if (!Failed)
                status.Write("closed", childSessionId, disconnectReason: disconnectReason);
        }
    }

    protected override void Dispose(bool disposing)
    {
        if (disposing)
            sessionProbe.Dispose();
        base.Dispose(disposing);
    }
}

internal sealed class RdpControl() : AxHost("A0C63C30-F08D-4AB4-907C-34905D770C7D")
{
    internal const int RequestedDesktopWidth = 1920;
    internal const int RequestedDesktopHeight = 1080;

    private static readonly Guid EventInterface = new("336D5562-EFA8-482E-8CB3-C5C0FC7A7DB6");
    private object? eventSource;
    private Action? loginCompleteSink;
    private Action<int>? disconnectedSink;
    private Action<int>? fatalErrorSink;

    public event Action? LoginComplete;
    public event Action<int>? Disconnected;
    public event Action<int>? FatalError;

    public bool IsConnected => GetOcx() is IRdpClient client && client.Connected == 1;

    public void Connect()
    {
        var stage = "AxHost.GetOcx";
        try
        {
            var control = GetOcx();
            stage = "QueryInterface(IMsRdpClient10)";
            var client = (IRdpClient)control;
            stage = "IMsRdpClient.Server";
            client.Server = "localhost";
            stage = "IMsRdpClient.DesktopWidth";
            client.DesktopWidth = RequestedDesktopWidth;
            stage = "IMsRdpClient.DesktopHeight";
            client.DesktopHeight = RequestedDesktopHeight;

            stage = "QueryInterface(IMsRdpExtendedSettings)";
            var settings = (IRdpExtendedSettings)control;
            stage = "IMsRdpExtendedSettings.ConnectToChildSession";
            object childSession = true;
            settings.SetProperty("ConnectToChildSession", ref childSession);
            settings.GetProperty("ConnectToChildSession", out var configuredChildSession);
            if (configuredChildSession is not true)
                throw new InvalidOperationException("RDP did not retain the local child-session setting.");

            // A child-session pointer update must not reposition the parent's physical cursor.
            // This is independent of the per-user minimized-output compatibility setting.
            stage = "IMsRdpExtendedSettings.IgnoreServerGeneratedMouseMoves";
            object ignorePointerUpdates = true;
            settings.SetProperty("IgnoreServerGeneratedMouseMoves", ref ignorePointerUpdates);
            settings.GetProperty("IgnoreServerGeneratedMouseMoves", out var configuredPointerPolicy);
            if (configuredPointerPolicy is not true)
                throw new InvalidOperationException("RDP did not retain the isolated pointer policy.");

            stage = "IMsRdpClient6.AdvancedSettings7";
            var advanced = (IRdpAdvancedSettings)client.AdvancedSettings7;
            stage = "IMsRdpClientAdvancedSettings6.EnableCredSspSupport";
            advanced.EnableCredSspSupport = true;
            stage = "IMsRdpClientAdvancedSettings5.RedirectClipboard";
            advanced.RedirectClipboard = false;
            stage = "IMsRdpClientAdvancedSettings.RedirectDrives";
            advanced.RedirectDrives = false;
            stage = "IMsRdpClientAdvancedSettings2.EnableAutoReconnect";
            advanced.EnableAutoReconnect = false;
            stage = "QueryInterface(IMsTscAx)";
            var connection = (IRdpConnection)control;
            stage = "IMsTscAx.Connect";
            connection.Connect();
        }
        catch (Exception error)
        {
            throw new InvalidOperationException($"{stage} failed (0x{error.HResult:X8}): {error.Message}", error);
        }
    }

    public void Disconnect()
    {
        try
        {
            var control = GetOcx();
            if (control is IRdpClient client && client.Connected != 0)
                ((IRdpConnection)control).Disconnect();
        }
        catch (COMException)
        {
            // Disposing AxHost also releases the connection control.
        }
    }

    protected override void CreateSink()
    {
        eventSource = GetOcx();
        loginCompleteSink = () => LoginComplete?.Invoke();
        disconnectedSink = reason => Disconnected?.Invoke(reason);
        fatalErrorSink = code => FatalError?.Invoke(code);
        ComEventsHelper.Combine(eventSource, EventInterface, 3, loginCompleteSink);
        ComEventsHelper.Combine(eventSource, EventInterface, 4, disconnectedSink);
        ComEventsHelper.Combine(eventSource, EventInterface, 10, fatalErrorSink);
    }

    protected override void DetachSink()
    {
        if (eventSource is null)
            return;
        ComEventsHelper.Remove(eventSource, EventInterface, 3, loginCompleteSink!);
        ComEventsHelper.Remove(eventSource, EventInterface, 4, disconnectedSink!);
        ComEventsHelper.Remove(eventSource, EventInterface, 10, fatalErrorSink!);
        eventSource = null;
    }
}

[ComImport]
[Guid("7ED92C39-EB38-4927-A70A-708AC5A59321")]
[InterfaceType(ComInterfaceType.InterfaceIsIDispatch)]
internal interface IRdpClient
{
    [DispId(1)] string Server { set; }
    [DispId(6)] short Connected { get; }
    [DispId(12)] int DesktopWidth { set; }
    [DispId(13)] int DesktopHeight { set; }
    [DispId(507)] object AdvancedSettings7 { [return: MarshalAs(UnmanagedType.IDispatch)] get; }
}

[ComImport]
[Guid("8C11EFAE-92C3-11D1-BC1E-00C04FA31489")]
[InterfaceType(ComInterfaceType.InterfaceIsDual)]
internal interface IRdpConnection
{
    // Skip the 26 IMsTscAx methods before Connect in the native dual interface.
    void _VtblGap1_26();
    void Connect();
    void Disconnect();
}

[ComImport]
[Guid("222C4B5D-45D9-4DF0-A7C6-60CF9089D285")]
[InterfaceType(ComInterfaceType.InterfaceIsIDispatch)]
internal interface IRdpAdvancedSettings
{
    [DispId(17)] bool EnableCredSspSupport { set; }
    [DispId(191)] bool RedirectDrives { set; }
    [DispId(206)] bool EnableAutoReconnect { set; }
    [DispId(213)] bool RedirectClipboard { set; }
}

[ComImport]
[Guid("302D8188-0052-4807-806A-362B628F9AC5")]
[InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
internal interface IRdpExtendedSettings
{
    // The first vtable entry is put_Property and takes a pointer to a VARIANT.
    void SetProperty([MarshalAs(UnmanagedType.BStr)] string name,
        [In, MarshalAs(UnmanagedType.Struct)] ref object value);
    void GetProperty([MarshalAs(UnmanagedType.BStr)] string name,
        [MarshalAs(UnmanagedType.Struct)] out object value);
}
