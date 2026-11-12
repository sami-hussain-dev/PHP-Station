// PHP Station shutdown guard.
// A tiny window-less helper (compiled by PHP Station with the .NET Framework csc.exe that ships with
// Windows) that waits for Windows shutdown / restart / sign-out. When that starts it:
//   1. asks Windows to wait ("PHP Station: DB servers are being stopped safely"),
//   2. sets the MariaDB/MySQL named event MySQLShutdown<pid> of every DB server listed by PHP Station
//      (the server's own clean-shutdown signal: no password, no kill),
//   3. waits until those processes have exited (at most 90 s), then lets Windows continue.
// It only signals pids from PHP Station's list that are still mysqld.exe / mariadbd.exe.
// Usage: PHPStationGuard.exe "<PHP Station data folder>"
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Windows.Forms;

static class Native {
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern bool ShutdownBlockReasonCreate(IntPtr hWnd, string reason);
  [DllImport("user32.dll")] public static extern bool ShutdownBlockReasonDestroy(IntPtr hWnd);
  [DllImport("kernel32.dll")] public static extern bool SetProcessShutdownParameters(uint level, uint flags);
}

class GuardWindow : NativeWindow {
  const int WM_QUERYENDSESSION = 0x0011;
  const int WM_ENDSESSION = 0x0016;
  readonly string dataDir;
  readonly string listFile;
  readonly string logFile;
  readonly object gate = new object();
  Thread worker;

  public GuardWindow(string dataDir) {
    this.dataDir = dataDir;
    listFile = Path.Combine(dataDir, "guard", "dbs.txt");
    logFile = Path.Combine(dataDir, "logs", "guard.log");
    CreateHandle(new CreateParams());
    Log("guard started (pid " + Process.GetCurrentProcess().Id + ")");
  }

  void Log(string text) {
    try {
      Directory.CreateDirectory(Path.GetDirectoryName(logFile));
      File.AppendAllText(logFile, DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss") + " " + text + "\r\n", Encoding.UTF8);
    } catch { }
  }

  // "pid<TAB>label" lines written by PHP Station
  List<KeyValuePair<int, string>> ReadList() {
    var list = new List<KeyValuePair<int, string>>();
    try {
      foreach (var line in File.ReadAllLines(listFile, Encoding.UTF8)) {
        var parts = line.Split('\t');
        int pid;
        if (parts.Length >= 1 && int.TryParse(parts[0].Trim(), out pid) && pid > 0)
          list.Add(new KeyValuePair<int, string>(pid, parts.Length > 1 ? parts[1] : ""));
      }
    } catch { }
    return list;
  }

  static bool IsDbProcess(Process p) {
    try {
      var n = p.ProcessName.ToLowerInvariant();
      return n == "mysqld" || n == "mariadbd";
    } catch { return false; }
  }

  void StopAll() {
    var waiting = new List<Process>();
    foreach (var item in ReadList()) {
      Process p;
      try { p = Process.GetProcessById(item.Key); } catch { continue; }
      if (!IsDbProcess(p)) continue;
      try {
        var ev = EventWaitHandle.OpenExisting("MySQLShutdown" + item.Key);
        ev.Set();
        ev.Close();
        waiting.Add(p);
        Log("shutdown event set: pid " + item.Key + " " + item.Value);
      } catch (Exception e) {
        Log("could not signal pid " + item.Key + " " + item.Value + ": " + e.Message);
      }
    }
    var until = DateTime.UtcNow.AddSeconds(90);
    foreach (var p in waiting) {
      var left = (int)Math.Max(0, (until - DateTime.UtcNow).TotalMilliseconds);
      try {
        if (p.WaitForExit(left)) Log("stopped cleanly: pid " + p.Id);
        else Log("still running after 90 s: pid " + p.Id);
      } catch { }
    }
  }

  void Begin(string why) {
    lock (gate) {
      if (worker != null) return;
      Native.ShutdownBlockReasonCreate(Handle, "PHP Station: DB servers safely band ho rahe hain / stopping DB servers safely");
      Log("session ending (" + why + "): stopping DB servers");
      worker = new Thread(StopAll);
      worker.IsBackground = false;
      worker.Start();
    }
  }

  protected override void WndProc(ref Message m) {
    if (m.Msg == WM_QUERYENDSESSION) {
      Begin("query");
      m.Result = (IntPtr)1; // allow, but the block reason keeps Windows waiting until we are done
      return;
    }
    if (m.Msg == WM_ENDSESSION) {
      if (m.WParam != IntPtr.Zero) {
        Begin("end");
        Thread w;
        lock (gate) { w = worker; }
        if (w != null) w.Join(95000);
        Native.ShutdownBlockReasonDestroy(Handle);
        Log("done, Windows may continue");
      } else {
        // shutdown was cancelled: nothing more to do (servers that already stopped stay stopped)
        lock (gate) { worker = null; }
        Native.ShutdownBlockReasonDestroy(Handle);
        Log("session end cancelled");
      }
      m.Result = IntPtr.Zero;
      return;
    }
    base.WndProc(ref m);
  }
}

static class Program {
  [STAThread]
  static int Main(string[] args) {
    if (args.Length < 1 || !Directory.Exists(args[0])) return 2;
    bool created;
    using (var mutex = new Mutex(true, "Local\\DevPanelShutdownGuard", out created)) {
      if (!created) return 0; // already running for this user
      // ask to be told early (before ordinary apps) so the DB servers get the most time
      Native.SetProcessShutdownParameters(0x3FF, 0);
      var w = new GuardWindow(args[0]);
      // a named event lets PHP Station end the guard (setting turned off)
      var quit = new EventWaitHandle(false, EventResetMode.AutoReset, "Local\\DevPanelShutdownGuardQuit");
      ThreadPool.RegisterWaitForSingleObject(quit, (s, t) => Application.Exit(), null, -1, true);
      Application.Run();
      GC.KeepAlive(w);
      GC.KeepAlive(mutex);
    }
    return 0;
  }
}
