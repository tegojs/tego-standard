$ErrorActionPreference = 'Stop'
# Test-only fixed new namespace; no deletion, disposition, arbitrary command or product entry.
Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;
using Microsoft.Win32.SafeHandles;

public static class RemovalMultiViewFixture {
  public sealed class BoundaryException : Exception {}
  [StructLayout(LayoutKind.Sequential)]
  private struct HandleInfo {
    public uint Attributes, CreationLow, CreationHigh, AccessLow, AccessHigh, WriteLow, WriteHigh;
    public uint Volume, SizeHigh, SizeLow, Links, IndexHigh, IndexLow;
  }
  public sealed class Observation {
    public string state, dev, ino;
    public int? openError;
  }
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  private static extern SafeFileHandle CreateFileW(string name, uint access, uint share,
    IntPtr security, uint disposition, uint flags, IntPtr template);
  [DllImport("kernel32.dll", SetLastError=true)]
  [return: MarshalAs(UnmanagedType.Bool)]
  private static extern bool GetFileInformationByHandle(SafeFileHandle handle, out HandleInfo info);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  private static extern SafeFileHandle CreateFileMappingW(SafeFileHandle file, IntPtr security,
    uint protection, uint maximumHigh, uint maximumLow, string name);
  [DllImport("kernel32.dll", SetLastError=true)]
  private static extern IntPtr MapViewOfFile(SafeFileHandle mapping, uint access,
    uint offsetHigh, uint offsetLow, UIntPtr bytes);
  [DllImport("kernel32.dll", SetLastError=true)]
  [return: MarshalAs(UnmanagedType.Bool)]
  private static extern bool FlushViewOfFile(IntPtr address, UIntPtr bytes);
  [DllImport("kernel32.dll", SetLastError=true)]
  [return: MarshalAs(UnmanagedType.Bool)]
  private static extern bool UnmapViewOfFile(IntPtr address);

  private static void Native(bool ok) { if (!ok) throw new Win32Exception(Marshal.GetLastWin32Error()); }
  private static SafeFileHandle OpenHandle(string name, uint access, uint share, bool directory) {
    var handle = CreateFileW(name, access, share, IntPtr.Zero, 3,
      0x00200000u | (directory ? 0x02000000u : 0u), IntPtr.Zero);
    if (handle.IsInvalid) {
      int error = Marshal.GetLastWin32Error(); handle.Dispose(); throw new Win32Exception(error);
    }
    return handle;
  }
  private static HandleInfo InspectFile(SafeFileHandle handle) {
    HandleInfo info;
    Native(GetFileInformationByHandle(handle, out info));
    uint size = (uint)Encoding.UTF8.GetByteCount("Fresh multi-process mapping fixture; never a business attachment\n");
    if ((info.Attributes & 0x410) != 0 || info.Links != 1 || info.SizeHigh != 0 || info.SizeLow != size)
      throw new BoundaryException();
    return info;
  }
  private static void Boundary(string directory, string mode) {
    if (String.IsNullOrEmpty(directory) || (mode != "hold-first" && mode != "hold-second" && mode != "probe-gate"))
      throw new BoundaryException();
    string full = Path.GetFullPath(directory);
    string temp = Path.GetFullPath(Path.GetTempPath()).TrimEnd(Path.DirectorySeparatorChar);
    if (!String.Equals(full, directory, StringComparison.OrdinalIgnoreCase) ||
      !String.Equals(Path.GetDirectoryName(full), temp, StringComparison.OrdinalIgnoreCase) ||
      !Regex.IsMatch(Path.GetFileName(full), "^tego-removal-multi-view-[A-Za-z0-9]+$"))
      throw new BoundaryException();
    for (var current = new DirectoryInfo(full); current != null; current = current.Parent)
      if ((current.Attributes & FileAttributes.ReparsePoint) != 0) throw new BoundaryException();
    string[] entries = Directory.GetFileSystemEntries(full);
    if (entries.Length != 1 || !String.Equals(entries[0], Path.Combine(full, "probe.txt"), StringComparison.OrdinalIgnoreCase))
      throw new BoundaryException();
  }

  public sealed class Session : IDisposable {
    private SafeFileHandle anchor;
    private IntPtr view;
    private int offset;
    private Observation observation;

    private Session() {}
    public static Session Open(string directory, string mode) {
      Boundary(directory, mode);
      var session = new Session();
      try {
        session.anchor = OpenHandle(directory, 0x80, 3, true);
        HandleInfo root;
        Native(GetFileInformationByHandle(session.anchor, out root));
        if ((root.Attributes & 0x410) != 0x10) throw new BoundaryException();
        string file = Path.Combine(directory, "probe.txt");
        HandleInfo original;
        using (var source = OpenHandle(file, mode == "probe-gate" ? 0x80u : 0xc0000000u, 7, false)) {
          original = InspectFile(source);
          if (mode != "probe-gate") {
            // Unnamed PAGE_READWRITE / FILE_MAP_WRITE data view, never executable.
            using (var mapping = CreateFileMappingW(source, IntPtr.Zero, 4, 0, 0, null)) {
              if (mapping.IsInvalid) throw new Win32Exception(Marshal.GetLastWin32Error());
              session.view = MapViewOfFile(mapping, 2, 0, 0, UIntPtr.Zero);
              if (session.view == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
            }
          }
        }
        // Source and mapping-object handles are closed before a holder announces readiness.
        session.offset = mode == "hold-first" ? 0 : 1;
        session.observation = new Observation {
          state = mode == "probe-gate" ? "gate-observed" : "view-held",
          dev = original.Volume.ToString(CultureInfo.InvariantCulture),
          ino = (((ulong)original.IndexHigh << 32) | original.IndexLow).ToString(CultureInfo.InvariantCulture)
        };
        if (mode == "probe-gate") {
          using (var gate = CreateFileW(file, 0x80010000, 1, IntPtr.Zero, 3, 0x00200000, IntPtr.Zero)) {
            session.observation.openError = gate.IsInvalid ? Marshal.GetLastWin32Error() : 0;
            if (!gate.IsInvalid) {
              var actual = InspectFile(gate);
              if (actual.Volume != original.Volume || actual.IndexHigh != original.IndexHigh || actual.IndexLow != original.IndexLow)
                throw new BoundaryException();
            }
          }
        }
        return session;
      } catch { session.Dispose(); throw; }
    }
    public Observation Status() { return observation; }
    public Observation WriteAndRelease() {
      if (view == IntPtr.Zero || Marshal.ReadByte(view, offset) != (byte)(offset == 0 ? 'F' : 'r'))
        throw new BoundaryException();
      Marshal.WriteByte(view, offset, (byte)(offset == 0 ? 'M' : 'S'));
      Native(FlushViewOfFile(view, new UIntPtr(2)));
      Native(UnmapViewOfFile(view));
      view = IntPtr.Zero;
      observation.state = "view-written";
      return observation;
    }
    public void Dispose() {
      try {
        if (view != IntPtr.Zero) {
          Native(UnmapViewOfFile(view));
          view = IntPtr.Zero;
        }
      } finally { if (anchor != null) { anchor.Dispose(); anchor = null; } }
    }
  }
}
'@
function Write-FixtureObservation($observation) {
  $result = @{ state = $observation.state; dev = $observation.dev; ino = $observation.ino }
  if ($null -ne $observation.openError) { $result.openError = $observation.openError }
  [Console]::Out.WriteLine(($result | ConvertTo-Json -Compress))
  [Console]::Out.Flush()
}
$session = $null
try {
  $session = [RemovalMultiViewFixture+Session]::Open($env:TEGO_MULTI_VIEW_DIRECTORY, $env:TEGO_MULTI_VIEW_MODE)
  Write-FixtureObservation ($session.Status())
  if ($env:TEGO_MULTI_VIEW_MODE -ne 'probe-gate') {
    if ([Console]::In.ReadLine() -ne 'write-and-release') { throw 'Only the fixed new-fixture write command is accepted' }
    Write-FixtureObservation ($session.WriteAndRelease())
  }
} catch {
  $cause = $_.Exception
  while ($null -ne $cause.InnerException) { $cause = $cause.InnerException }
  if ($cause -is [RemovalMultiViewFixture+BoundaryException]) {
    [Console]::Out.WriteLine('rejected:fixture-boundary')
    exit 2
  }
  throw
} finally { if ($null -ne $session) { $session.Dispose() } }
