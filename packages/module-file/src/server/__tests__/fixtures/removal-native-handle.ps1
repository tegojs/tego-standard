$ErrorActionPreference = 'Stop'
# Test-only dependency characterization. No delete disposition, path mutation or cleanup.
Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;
public static class RemovalHandleFixture {
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  private static extern SafeFileHandle CreateFileW(string name, uint access, uint share,
    IntPtr security, uint disposition, uint flags, IntPtr template);
  public static SafeFileHandle Open(string name, bool directory) {
    // Directories allow child I/O, but deny DELETE sharing on the directory itself.
    // The file requests READ/DELETE access, shares only READ and never deletes.
    uint access = directory ? 0x80u : 0x80010000u;
    uint share = directory ? 3u : 1u;
    uint flags = 0x00200000u | (directory ? 0x02000000u : 0u);
    SafeFileHandle handle = CreateFileW(name, access, share, IntPtr.Zero, 3, flags, IntPtr.Zero);
    if (handle.IsInvalid) {
      int code = Marshal.GetLastWin32Error();
      handle.Dispose();
      throw new Win32Exception(code);
    }
    return handle;
  }
}
'@
$handles = [System.Collections.Generic.List[System.IDisposable]]::new()
try {
  foreach ($item in ($env:TEGO_HANDLE_FIXTURE_DIRECTORIES | ConvertFrom-Json)) {
    $handles.Add([RemovalHandleFixture]::Open($item, $true))
  }
  $handles.Add([RemovalHandleFixture]::Open($env:TEGO_HANDLE_FIXTURE_FILE, $false))
  [Console]::Out.WriteLine('held')
  [Console]::Out.Flush()
  if ([Console]::In.ReadLine() -ne 'release') { throw 'Missing explicit fixture release' }
} catch {
  $cause = $_.Exception
  while ($null -ne $cause.InnerException) { $cause = $cause.InnerException }
  if ($cause -is [System.ComponentModel.Win32Exception]) {
    [Console]::Out.WriteLine('rejected:' + $cause.NativeErrorCode)
    [Console]::Out.Flush()
  } else { throw }
} finally {
  for ($index = $handles.Count - 1; $index -ge 0; $index--) { $handles[$index].Dispose() }
}
