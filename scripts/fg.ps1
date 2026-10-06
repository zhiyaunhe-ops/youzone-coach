# Bring the YonZone main window to the foreground (defeats renderer throttling).
[Console]::InputEncoding = [Console]::OutputEncoding = [Text.UTF8Encoding]::new()
Add-Type @'
using System;
using System.Runtime.InteropServices;
public class W {
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
}
'@
$p = Get-Process YonZone -ErrorAction Stop | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
[W]::ShowWindow($p.MainWindowHandle, 9) | Out-Null   # SW_RESTORE
[W]::SetForegroundWindow($p.MainWindowHandle) | Out-Null
Write-Output ("fg pid=" + $p.Id)
