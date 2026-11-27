$ErrorActionPreference = 'Stop'
# Test-only dependency characterization. No delete disposition, path mutation or cleanup.
Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Globalization;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;
public static class RemovalHandleFixture {
  [StructLayout(LayoutKind.Sequential)]
  private struct HandleInfo {
    public uint Attributes, CreationLow, CreationHigh, AccessLow, AccessHigh, WriteLow, WriteHigh;
    public uint Volume, SizeHigh, SizeLow, Links, IndexHigh, IndexLow;
  }
  [StructLayout(LayoutKind.Sequential)]
  private struct BasicInfo {
    public long Creation, Access, Write, Change;
    public uint Attributes;
  }
  public sealed class Snapshot {
    public string dev, ino, birthtimeNs, mtimeNs, ctimeNs, size, nlink;
    public bool directory, reparse;
  }
  [DllImport("kernel32.dll", SetLastError=true)]
  [return: MarshalAs(UnmanagedType.Bool)]
  private static extern bool GetFileInformationByHandle(SafeFileHandle handle, out HandleInfo info);
  [DllImport("kernel32.dll", SetLastError=true)]
  [return: MarshalAs(UnmanagedType.Bool)]
  private static extern bool GetFileInformationByHandleEx(SafeFileHandle handle, int kind,
    out BasicInfo info, uint size);
  private static string Number(ulong value) { return value.ToString(CultureInfo.InvariantCulture); }
  private static string Epoch(long value) {
    return (((decimal)value - 116444736000000000m) * 100m).ToString("0", CultureInfo.InvariantCulture);
  }
  public static Snapshot Inspect(SafeFileHandle handle) {
    HandleInfo info;
    if (!GetFileInformationByHandle(handle, out info)) throw new Win32Exception(Marshal.GetLastWin32Error());
    BasicInfo basic;
    if (!GetFileInformationByHandleEx(handle, 0, out basic, (uint)Marshal.SizeOf<BasicInfo>()))
      throw new Win32Exception(Marshal.GetLastWin32Error());
    return new Snapshot {
      dev = Number(info.Volume), ino = Number(((ulong)info.IndexHigh << 32) | info.IndexLow),
      birthtimeNs = Epoch(basic.Creation), mtimeNs = Epoch(basic.Write), ctimeNs = Epoch(basic.Change),
      size = Number(((ulong)info.SizeHigh << 32) | info.SizeLow), nlink = Number(info.Links),
      directory = (info.Attributes & 0x10u) != 0, reparse = (info.Attributes & 0x400u) != 0
    };
  }
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
function Read-NativeObservation {
  $directories = @()
  for ($index = 0; $index -lt $handles.Count - 1; $index++) {
    $directories += [RemovalHandleFixture]::Inspect($handles[$index])
  }
  return @{ directories = $directories; file = [RemovalHandleFixture]::Inspect($handles[$handles.Count - 1]) } | ConvertTo-Json -Depth 4 -Compress
}
try {
  foreach ($item in ($env:TEGO_HANDLE_FIXTURE_DIRECTORIES | ConvertFrom-Json)) {
    $handles.Add([RemovalHandleFixture]::Open($item, $true))
  }
  $handles.Add([RemovalHandleFixture]::Open($env:TEGO_HANDLE_FIXTURE_FILE, $false))
  if ($env:TEGO_HANDLE_FIXTURE_NATIVE_IDENTITY -eq '1') {
    [Console]::Out.WriteLine('held:' + (Read-NativeObservation))
  } else { [Console]::Out.WriteLine('held') }
  [Console]::Out.Flush()
  while ($true) {
    $command = [Console]::In.ReadLine()
    if ($command -eq 'release') { break }
    if ($command -eq 'inspect' -and $env:TEGO_HANDLE_FIXTURE_NATIVE_IDENTITY -eq '1') {
      [Console]::Out.WriteLine((Read-NativeObservation))
      [Console]::Out.Flush()
    } else { throw 'Missing explicit fixture release' }
  }
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
