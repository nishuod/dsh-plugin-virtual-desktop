using System;
using System.Drawing;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Windows.Forms;

public class DesktopFixture : Form {
  TextBox input = new TextBox();
  Label label = new Label();
  Panel target = new Panel();
  Panel scroll = new Panel();
  Label firstScrollRow;
  int clicks, doubles, rights, wheels, drags;
  int enters, escapes, ctrlKeys;
  Point minimizePoint;
  bool dragging;
  Point anchor;
  string path = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "fixture-state.json");
  string commandToken = "";
  Timer commandTimer = new Timer();
  [STAThread] public static void Main() { Application.EnableVisualStyles(); Application.Run(new DesktopFixture()); }
#if CAPTION
  [StructLayout(LayoutKind.Sequential)]
  struct NativeRect { public int Left, Top, Right, Bottom; }
  [DllImport("dwmapi.dll")]
  static extern int DwmGetWindowAttribute(IntPtr window, int attribute, out NativeRect result, int size);
  [DllImport("user32.dll")]
  static extern IntPtr SendMessage(IntPtr window, int message, IntPtr wParam, IntPtr lParam);

  string CaptionProbe() {
    if (WindowState != FormWindowState.Normal) return "";
    NativeRect bounds;
    if (DwmGetWindowAttribute(Handle, 9, out bounds, Marshal.SizeOf(typeof(NativeRect))) != 0) return "";
    for (int y = bounds.Top + 12; y < bounds.Top + 30; y += 4) {
      for (int x = bounds.Right - 36; x > bounds.Right - 230; x -= 2) {
        Func<int, int> hit = p => SendMessage(Handle, 0x84, IntPtr.Zero, (IntPtr)((p & 0xffff) | ((y & 0xffff) << 16))).ToInt32();
        // Stay away from the edge of the real caption hit region.
        if (hit(x) != 8 || hit(x - 10) != 8 || hit(x + 10) != 8) continue;
        return String.Format(",\"captionMinX\":{0},\"captionMinY\":{1},\"captionHit\":8,\"dwmX\":{2},\"dwmY\":{3},\"dwmWidth\":{4},\"dwmHeight\":{5}",
          x,y,bounds.Left,bounds.Top,bounds.Right-bounds.Left,bounds.Bottom-bounds.Top);
      }
    }
    return "";
  }
#endif
  public DesktopFixture() {
    Text = "DSH Desktop Test Fixture"; Size = new Size(900,680); StartPosition=FormStartPosition.Manual;Location=new Point(250,100);
#if WIDE
    Location=new Point(0,0);Size=new Size(1920,859);
#elif CAPTION
    Location=new Point(128,128);Size=new Size(1359,859);
#endif
    KeyPreview=true;
    KeyDown+=(s,e)=>{if(e.KeyCode==Keys.Enter)enters++;if(e.KeyCode==Keys.Escape)escapes++;if(e.Control&&e.KeyCode==Keys.K)ctrlKeys++;Save();};
    Font=new Font("Microsoft YaHei UI",11); BackColor=Color.FromArgb(239,242,255);
    var heading=new Label {Text="DSH 受控测试窗口 — 仅用于验证桌面工具",Location=new Point(24,18),AutoSize=true};Controls.Add(heading);
    input.Name="fixtureText";input.AccessibleName="测试文本输入框";input.Multiline=true;input.SetBounds(24,62,600,90);Controls.Add(input);
    var button=new Button {Text="增加计数",AccessibleName="增加计数",Location=new Point(650,62),Size=new Size(180,70)};
#if WIDE
    button.Left=1600;
#endif
    button.Click+=(s,e)=>{clicks++;Save();};Controls.Add(button);
    label.SetBounds(24,172,800,35);Controls.Add(label);
    target.SetBounds(24,225,220,90);target.BackColor=Color.FromArgb(165,177,245);target.AccessibleName="拖拽和鼠标测试区域";
    target.Controls.Add(new Label {Text="右键 / 双击 / 拖拽此色块",Dock=DockStyle.Fill,TextAlign=ContentAlignment.MiddleCenter,Enabled=false});
    target.MouseDoubleClick+=(s,e)=>{doubles++;Save();};
    target.MouseClick+=(s,e)=>{if(e.Button==MouseButtons.Right){rights++;Save();}};
    target.MouseDown+=(s,e)=>{if(e.Button==MouseButtons.Left){dragging=true;anchor=e.Location;target.Capture=true;}};
    target.MouseMove+=(s,e)=>{if(dragging&&(Math.Abs(e.X-anchor.X)+Math.Abs(e.Y-anchor.Y)>6)){target.Left+=e.X-anchor.X;target.Top+=e.Y-anchor.Y;Save();}};
    target.MouseUp+=(s,e)=>{if(dragging){dragging=false;target.Capture=false;drags++;Save();}};Controls.Add(target);
    scroll.SetBounds(24,360,800,230);scroll.AutoScroll=true;scroll.BackColor=Color.White;scroll.AccessibleName="滚动测试区域";
    for(int n=0;n<20;n++) {
      var row = new Label {
        Text=String.Format("滚动内容 · 第 {0:00} 行", n+1),
        Location=new Point(12,n*42), Size=new Size(600,35),
        BackColor=n%2==0 ? Color.FromArgb(228,235,255) : Color.FromArgb(243,235,255)
      };
      scroll.Controls.Add(row);
      if(n==0) firstScrollRow=row;
    }
    scroll.MouseWheel+=(s,e)=>{wheels++;SaveAfterScroll();};
    scroll.Scroll+=(s,e)=>SaveAfterScroll();Controls.Add(scroll);
    input.TextChanged+=(s,e)=>Save();LocationChanged+=(s,e)=>Save();SizeChanged+=(s,e)=>Save();Shown+=(s,e)=>Save();
    var minimize=new Button {Text="最小化目标",Location=new Point(900,62),Size=new Size(180,70)};
    minimize.Click+=(s,e)=>{WindowState=FormWindowState.Minimized;Save();};Controls.Add(minimize);
    minimizePoint=minimize.PointToScreen(new Point(90,35));
    // Test executable only: mutate this exact process after a captured frame,
    // independently of the plugin's input path. No command/path/argument execution.
    commandTimer.Interval=100;
    commandTimer.Tick+=(s,e)=>ReadFixtureCommand();
    Shown+=(s,e)=>commandTimer.Start();
    FormClosed+=(s,e)=>commandTimer.Dispose();
  }
  void ReadFixtureCommand() {
    string commandPath=Path.Combine(AppDomain.CurrentDomain.BaseDirectory,"fixture-command.json");
    try {
      if(!File.Exists(commandPath))return;
      string text=File.ReadAllText(commandPath);
      if(text.Length>256)return;
      var match=System.Text.RegularExpressions.Regex.Match(text,
        "^\\{\"pid\":([0-9]{1,10}),\"token\":\"([a-f0-9-]{36})\",\"action\":\"(minimize|resize|show-password)\"\\}$");
      int pid;Guid token;
      if(!match.Success||!Int32.TryParse(match.Groups[1].Value,out pid)||pid!=System.Diagnostics.Process.GetCurrentProcess().Id||
        !Guid.TryParseExact(match.Groups[2].Value,"D",out token)||match.Groups[2].Value==commandToken)return;
      commandToken=match.Groups[2].Value;
      File.Delete(commandPath);
      if(match.Groups[3].Value=="minimize")WindowState=FormWindowState.Minimized;
      else if(match.Groups[3].Value=="resize")Size=new Size(1000,720);
      else {
        var password = new TextBox { Name="evalPassword", AccessibleName="Synthetic eval password",
          UseSystemPasswordChar=true, Text="LocalFixtureOnly", Location=new Point(310,245), Width=230 };
        Controls.Add(password);
      }
      Save();
    }catch(IOException){}
  }
  void SaveAfterScroll() {
    // Read the layout after the standard WinForms scroll message has finished.
    BeginInvoke((MethodInvoker)Save);
  }
  string Escape(string value){return value.Replace("\\","\\\\").Replace("\"","\\\"").Replace("\r","\\r").Replace("\n","\\n");}
  void Save(){
    label.Text=String.Format("点击 {0} · 双击 {1} · 右键 {2} · 滚轮 {3} · 拖拽/释放 {4} · Enter {5} · Esc {6} · Ctrl {7}",clicks,doubles,rights,wheels,drags,enters,escapes,ctrlKeys);
    var textPoint=input.PointToScreen(new Point(input.Width/2,input.Height/2));
    var buttonPoint=Controls[2].PointToScreen(new Point(90,35));
    var targetPoint=target.PointToScreen(new Point(target.Width/2,target.Height/2));
    var scrollPoint=scroll.PointToScreen(new Point(400,110));
    var viewport=scroll.PointToScreen(Point.Empty);
    int scrollOffsetY=-scroll.AutoScrollPosition.Y;
    int scrollFirstRowY=firstScrollRow.PointToScreen(Point.Empty).Y-viewport.Y;
    string json=String.Format("{{\"pid\":{0},\"text\":\"{1}\",\"clicks\":{2},\"doubles\":{3},\"rights\":{4},\"wheels\":{5},\"drags\":{6},\"windowX\":{7},\"windowY\":{8},\"textX\":{9},\"textY\":{10},\"buttonX\":{11},\"buttonY\":{12},\"targetX\":{13},\"targetY\":{14},\"scrollX\":{15},\"scrollY\":{16},\"scrollOffsetY\":{17},\"scrollFirstRowY\":{18},\"scrollViewX\":{19},\"scrollViewY\":{20},\"scrollViewWidth\":{21},\"scrollViewHeight\":{22}}}",
      System.Diagnostics.Process.GetCurrentProcess().Id,Escape(input.Text),clicks,doubles,rights,wheels,drags,Left,Top,textPoint.X,textPoint.Y,buttonPoint.X,buttonPoint.Y,targetPoint.X,targetPoint.Y,scrollPoint.X,scrollPoint.Y,
      scrollOffsetY,scrollFirstRowY,viewport.X,viewport.Y,scroll.ClientSize.Width,scroll.ClientSize.Height);
    minimizePoint=Controls[Controls.Count-1].PointToScreen(new Point(90,35));
    json=json.Substring(0,json.Length-1)+String.Format(",\"windowWidth\":{0},\"windowHeight\":{1},\"enters\":{2},\"escapes\":{3},\"ctrlKeys\":{4},\"minimizeX\":{5},\"minimizeY\":{6},\"minimized\":{7},\"commandToken\":\"{8}\"}}",Width,Height,enters,escapes,ctrlKeys,minimizePoint.X,minimizePoint.Y,WindowState==FormWindowState.Minimized?"true":"false",commandToken);
#if CAPTION
    json=json.Substring(0,json.Length-1)+CaptionProbe()+"}";
#endif
    try {File.WriteAllText(path,json,new UTF8Encoding(false));}catch(IOException){}
  }
}
