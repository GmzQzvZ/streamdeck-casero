# Envía comandos multimedia SOLO a la ventana de Spotify (WM_APPCOMMAND).
# No afecta a navegadores ni a otros reproductores.
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;

public class SP {
    delegate bool EnumProc(IntPtr h, IntPtr l);
    [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc p, IntPtr l);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr h, StringBuilder s, int n);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
    [DllImport("user32.dll")] static extern IntPtr SendMessage(IntPtr h, uint m, IntPtr w, IntPtr l);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);

    public static bool Cmd(int cmd) {
        HashSet<uint> pids = new HashSet<uint>();
        foreach (Process p in Process.GetProcessesByName("Spotify")) pids.Add((uint)p.Id);
        if (pids.Count == 0) return false;

        IntPtr found = IntPtr.Zero;
        EnumWindows(delegate (IntPtr h, IntPtr l) {
            uint pid; GetWindowThreadProcessId(h, out pid);
            if (!pids.Contains(pid)) return true;
            if (!IsWindowVisible(h)) return true;
            StringBuilder c = new StringBuilder(256); GetClassName(h, c, 256);
            string cls = c.ToString();
            if (cls.StartsWith("Chrome_WidgetWin_", StringComparison.Ordinal)) {
                found = h;
                return false;
            }
            return true;
        }, IntPtr.Zero);

        if (found == IntPtr.Zero) return false;
        SendMessage(found, 0x319, found, (IntPtr)(cmd << 16));
        return true;
    }
}
'@

while ($true) {
    $line = [Console]::In.ReadLine()
    if ($line -eq $null) { break }
    $ok = [SP]::Cmd([int]$line)
    [Console]::Out.WriteLine($(if ($ok) { 'OK' } else { 'NOSPOTIFY' }))
    [Console]::Out.Flush()
}
