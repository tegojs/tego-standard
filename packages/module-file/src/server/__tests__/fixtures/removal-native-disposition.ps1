$ErrorActionPreference = 'Stop'
# Destructive dependency characterization of NEW TEST FIXTURES ONLY. Never a runtime helper.
$fixtureDirectory = [IO.Path]::GetFullPath($env:TEGO_DISPOSITION_FIXTURE_DIRECTORY)
$temporaryDirectory = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\')
if ([IO.Path]::GetDirectoryName($fixtureDirectory).TrimEnd('\') -ine $temporaryDirectory -or
    [IO.Path]::GetFileName($fixtureDirectory) -notmatch '^tego-removal-native-disposition-[a-zA-Z0-9]+$') {
  throw 'Only a new, direct child test fixture of the OS temporary directory is accepted'
}
$root = [IO.Path]::Combine($fixtureDirectory, 'root')
$parent = [IO.Path]::Combine($root, 'nested')
$filename = [IO.Path]::Combine($parent, 'attachment.txt')
$expected = $env:TEGO_DISPOSITION_FIXTURE_EXPECTED | ConvertFrom-Json
Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Globalization;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;
public static class RemovalDispositionFixture {
  [StructLayout(LayoutKind.Sequential)]
  private struct HandleInfo {
    public uint Attributes, CreationLow, CreationHigh, AccessLow, AccessHigh, WriteLow, WriteHigh;
    public uint Volume, SizeHigh, SizeLow, Links, IndexHigh, IndexLow;
  }
  [StructLayout(LayoutKind.Sequential)]
  private struct BasicInfo { public long Creation, Access, Write, Change; public uint Attributes; }
  [StructLayout(LayoutKind.Sequential)]
  private struct Disposition { public byte Delete; }
  public sealed class Snapshot {
    public string dev, ino, birthtimeNs, mtimeNs, ctimeNs, size, nlink;
    public bool directory, reparse;
  }
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  private static extern SafeFileHandle CreateFileW(string name, uint access, uint share,
    IntPtr security, uint disposition, uint flags, IntPtr template);
  [DllImport("kernel32.dll", SetLastError=true)]
  [return: MarshalAs(UnmanagedType.Bool)]
  private static extern bool GetFileInformationByHandle(SafeFileHandle handle, out HandleInfo info);
  [DllImport("kernel32.dll", SetLastError=true)]
  [return: MarshalAs(UnmanagedType.Bool)]
  private static extern bool GetFileInformationByHandleEx(SafeFileHandle handle, int kind, out BasicInfo info, uint size);
  [DllImport("kernel32.dll", SetLastError=true)]
  [return: MarshalAs(UnmanagedType.Bool)]
  private static extern bool SetFileInformationByHandle(SafeFileHandle handle, int kind, ref Disposition info, uint size);
  private static string Number(ulong value) { return value.ToString(CultureInfo.InvariantCulture); }
  private static string Epoch(long value) {
    return (((decimal)value - 116444736000000000m) * 100m).ToString("0", CultureInfo.InvariantCulture);
  }
  public static SafeFileHandle Open(string name, bool directory) {
    SafeFileHandle handle = CreateFileW(name, directory ? 0x80u : 0x80010000u, directory ? 3u : 1u,
      IntPtr.Zero, 3, 0x00200000u | (directory ? 0x02000000u : 0u), IntPtr.Zero);
    if (handle.IsInvalid) {
      int code = Marshal.GetLastWin32Error(); handle.Dispose(); throw new Win32Exception(code);
    }
    return handle;
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
  public static void Mark(SafeFileHandle handle) {
    var value = new Disposition { Delete = 1 };
    if (!SetFileInformationByHandle(handle, 4, ref value, (uint)Marshal.SizeOf<Disposition>()))
      throw new Win32Exception(Marshal.GetLastWin32Error());
  }
}
'@
$handles = [System.Collections.Generic.List[System.IDisposable]]::new()
function Assert-FixtureIdentity {
  for ($index = 0; $index -lt 3; $index++) {
    $actual = [RemovalDispositionFixture]::Inspect($handles[$index])
    $wanted = if ($index -eq 2) { $expected.file } else { $expected.directories[$index] }
    $fields = @('dev', 'ino', 'birthtimeNs')
    if ($index -eq 2) { $fields += @('mtimeNs', 'ctimeNs', 'size', 'nlink') }
    if ($actual.reparse -or ($index -lt 2 -and -not $actual.directory) -or
        ($index -eq 2 -and ($actual.directory -or $actual.nlink -ne '1'))) {
      throw [IO.InvalidDataException]::new('Unsafe fixture object')
    }
    foreach ($field in $fields) {
      if ([string]$actual.$field -cne [string]$wanted.$field) {
        throw [IO.InvalidDataException]::new('Fixture identity drift')
      }
    }
  }
}
try {
  $handles.Add([RemovalDispositionFixture]::Open($root, $true))
  $handles.Add([RemovalDispositionFixture]::Open($parent, $true))
  $handles.Add([RemovalDispositionFixture]::Open($filename, $false))
  Assert-FixtureIdentity
  [Console]::Out.WriteLine('held'); [Console]::Out.Flush()
  $command = [Console]::In.ReadLine()
  if ($command -eq 'release') { return }
  if ($command -notin @('mark', 'mark-exit-before-reply', 'validate-only')) { throw 'Unexpected fixture command' }
  Assert-FixtureIdentity
  if ($command -eq 'validate-only') {
    # Deliberate counterexample: a split check/action is NOT a production contract.
    [Console]::Out.WriteLine('validated'); [Console]::Out.Flush()
    if ([Console]::In.ReadLine() -ne 'mark-without-recheck') { throw 'Unexpected fixture command' }
  }
  [RemovalDispositionFixture]::Mark($handles[2])
  if ($command -eq 'mark-exit-before-reply') { return }
  [Console]::Out.WriteLine('marked'); [Console]::Out.Flush()
  if ([Console]::In.ReadLine() -ne 'release') { throw 'Missing explicit fixture release' }
} catch {
  $cause = $_.Exception
  while ($null -ne $cause.InnerException) { $cause = $cause.InnerException }
  if ($cause -is [IO.InvalidDataException]) { [Console]::Out.WriteLine('rejected:identity') }
  elseif ($cause -is [ComponentModel.Win32Exception]) { [Console]::Out.WriteLine('rejected:' + $cause.NativeErrorCode) }
  else { throw }
  [Console]::Out.Flush()
} finally {
  for ($index = $handles.Count - 1; $index -ge 0; $index--) { $handles[$index].Dispose() }
}
