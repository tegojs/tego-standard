$ErrorActionPreference = 'Stop'
# Test-only fixed new namespace. No writes, disposition, deletion or arbitrary paths.
Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;
using Microsoft.Win32.SafeHandles;

public static class RemovalRelativeFixture {
  public sealed class Rejected : Exception {
    public string Reason;
    public Rejected(string reason) { Reason = reason; }
  }
  [StructLayout(LayoutKind.Sequential)]
  private struct UnicodeName { public ushort Length, MaximumLength; public IntPtr Buffer; }
  [StructLayout(LayoutKind.Sequential)]
  private struct ObjectAttributes {
    public uint Length;
    public IntPtr RootDirectory, ObjectName;
    public uint Attributes;
    public IntPtr SecurityDescriptor, SecurityQualityOfService;
  }
  [StructLayout(LayoutKind.Sequential)]
  private struct IoStatus { public IntPtr Status; public UIntPtr Information; }
  [StructLayout(LayoutKind.Sequential)]
  private struct HandleInfo {
    public uint Attributes, CreationLow, CreationHigh, AccessLow, AccessHigh, WriteLow, WriteHigh;
    public uint Volume, SizeHigh, SizeLow, Links, IndexHigh, IndexLow;
  }
  public sealed class Observation {
    public string state, rootDev, rootIno, dataDev, dataIno, dev, ino, bytes;
  }
  [DllImport("ntdll.dll")]
  private static extern int NtCreateFile(out SafeFileHandle handle, uint access,
    ref ObjectAttributes attributes, out IoStatus status, IntPtr allocationSize,
    uint fileAttributes, uint share, uint disposition, uint options, IntPtr ea, uint eaLength);
  [DllImport("ntdll.dll")]
  private static extern uint RtlNtStatusToDosError(int status);
  [DllImport("kernel32.dll", SetLastError=true)]
  [return: MarshalAs(UnmanagedType.Bool)]
  private static extern bool GetFileInformationByHandle(SafeFileHandle handle, out HandleInfo info);
  [DllImport("kernel32.dll", SetLastError=true)]
  [return: MarshalAs(UnmanagedType.Bool)]
  private static extern bool ReadFile(SafeFileHandle file, byte[] bytes, uint count, out uint read, IntPtr overlapped);

  private const string Original = "Original root-relative fixture; never a business attachment\n";
  private static SafeFileHandle Open(IntPtr root, string name, bool directory) {
    // Every relative name is a fixed single component, not a caller-selected path.
    if (root != IntPtr.Zero && name != "data" && name != "probe.txt") throw new Rejected("fixture-boundary");
    IntPtr buffer = Marshal.StringToHGlobalUni(name);
    IntPtr namePointer = IntPtr.Zero;
    try {
      var unicode = new UnicodeName {
        Length = checked((ushort)(name.Length * 2)),
        MaximumLength = checked((ushort)(name.Length * 2 + 2)), Buffer = buffer
      };
      namePointer = Marshal.AllocHGlobal(Marshal.SizeOf(typeof(UnicodeName)));
      Marshal.StructureToPtr(unicode, namePointer, false);
      var attributes = new ObjectAttributes {
        Length = (uint)Marshal.SizeOf(typeof(ObjectAttributes)), RootDirectory = root,
        ObjectName = namePointer, Attributes = 0x40
      };
      SafeFileHandle handle;
      IoStatus io;
      // SYNCHRONIZE + read attributes + directory traverse or file data; FILE_OPEN only.
      int status = NtCreateFile(out handle, directory ? 0x1000a0u : 0x100081u,
        ref attributes, out io, IntPtr.Zero, 0, 7, 1,
        0x00200020u | (directory ? 1u : 0x40u), IntPtr.Zero, 0);
      if (status < 0) {
        if (handle != null) handle.Dispose();
        throw new Win32Exception((int)RtlNtStatusToDosError(status));
      }
      return handle;
    } finally {
      if (namePointer != IntPtr.Zero) Marshal.FreeHGlobal(namePointer);
      Marshal.FreeHGlobal(buffer);
    }
  }
  private static HandleInfo Inspect(SafeFileHandle handle, bool directory) {
    HandleInfo info;
    if (!GetFileInformationByHandle(handle, out info)) throw new Win32Exception(Marshal.GetLastWin32Error());
    if ((info.Attributes & 0x400) != 0 || ((info.Attributes & 0x10) != 0) != directory)
      throw new Rejected("binding-change");
    if (!directory && (info.Links != 1 || info.SizeHigh != 0 || info.SizeLow != Encoding.UTF8.GetByteCount(Original)))
      throw new Rejected("binding-change");
    return info;
  }
  private static bool Same(HandleInfo first, HandleInfo second) {
    return first.Volume == second.Volume && first.IndexHigh == second.IndexHigh && first.IndexLow == second.IndexLow;
  }
  private static string Inode(HandleInfo info) {
    return (((ulong)info.IndexHigh << 32) | info.IndexLow).ToString(CultureInfo.InvariantCulture);
  }
  private static void Boundary(string directory) {
    if (String.IsNullOrEmpty(directory)) throw new Rejected("fixture-boundary");
    string full = Path.GetFullPath(directory);
    string temp = Path.GetFullPath(Path.GetTempPath()).TrimEnd(Path.DirectorySeparatorChar);
    if (!String.Equals(full, directory, StringComparison.OrdinalIgnoreCase) ||
      !String.Equals(Path.GetDirectoryName(full), temp, StringComparison.OrdinalIgnoreCase) ||
      !Regex.IsMatch(Path.GetFileName(full), "^tego-removal-relative-[A-Za-z0-9]+$"))
      throw new Rejected("fixture-boundary");
    for (var current = new DirectoryInfo(full); current != null; current = current.Parent)
      if ((current.Attributes & FileAttributes.ReparsePoint) != 0) throw new Rejected("fixture-boundary");
    var entries = Directory.GetFileSystemEntries(full);
    if (entries.Length != 2 || !Directory.Exists(Path.Combine(full, "root")) ||
      !Directory.Exists(Path.Combine(full, "replacement"))) throw new Rejected("fixture-boundary");
    foreach (var entry in entries)
      if ((File.GetAttributes(entry) & FileAttributes.ReparsePoint) != 0) throw new Rejected("fixture-boundary");
  }

  public sealed class Session : IDisposable {
    private SafeFileHandle root;
    private HandleInfo originalRoot, originalData, originalFile;
    private bool captured, consumed;
    private Session() {}
    public static Session Create(string directory) {
      Boundary(directory);
      var session = new Session();
      try {
        session.root = Open(IntPtr.Zero, @"\??\" + Path.Combine(directory, "root"), true);
        return session;
      } catch { session.Dispose(); throw; }
    }
    public Observation Observe(bool final) {
      if (consumed || (final && !captured) || (!final && captured)) throw new Rejected("command");
      if (final) consumed = true;
      var rootInfo = Inspect(root, true);
      using (var data = Open(root.DangerousGetHandle(), "data", true)) {
        var dataInfo = Inspect(data, true);
        if (captured && (!Same(rootInfo, originalRoot) || !Same(dataInfo, originalData)))
          throw new Rejected("binding-change");
        using (var file = Open(data.DangerousGetHandle(), "probe.txt", false)) {
          var fileInfo = Inspect(file, false);
          if (captured && !Same(fileInfo, originalFile)) throw new Rejected("binding-change");
          var bytes = new byte[Encoding.UTF8.GetByteCount(Original)];
          uint count;
          if (!ReadFile(file, bytes, (uint)bytes.Length, out count, IntPtr.Zero))
            throw new Win32Exception(Marshal.GetLastWin32Error());
          if (count != bytes.Length || Encoding.UTF8.GetString(bytes) != Original)
            throw new Rejected("binding-change");
          if (!captured) { originalRoot = rootInfo; originalData = dataInfo; originalFile = fileInfo; captured = true; }
          return new Observation {
            state = final ? "relative-observed" : "root-held",
            rootDev = rootInfo.Volume.ToString(CultureInfo.InvariantCulture), rootIno = Inode(rootInfo),
            dataDev = dataInfo.Volume.ToString(CultureInfo.InvariantCulture), dataIno = Inode(dataInfo),
            dev = fileInfo.Volume.ToString(CultureInfo.InvariantCulture), ino = Inode(fileInfo),
            bytes = Convert.ToBase64String(bytes)
          };
        }
      }
    }
    public void Dispose() { if (root != null) { root.Dispose(); root = null; } }
  }
}
'@
function Write-FixtureObservation($observation) {
  [Console]::Out.WriteLine(($observation | ConvertTo-Json -Compress))
  [Console]::Out.Flush()
}
$session = $null
try {
  $session = [RemovalRelativeFixture+Session]::Create($env:TEGO_RELATIVE_DIRECTORY)
  Write-FixtureObservation ($session.Observe($false))
  if ([Console]::In.ReadLine() -ne 'observe-and-close') { throw [RemovalRelativeFixture+Rejected]::new('command') }
  Write-FixtureObservation ($session.Observe($true))
} catch {
  $cause = $_.Exception
  while ($null -ne $cause.InnerException) { $cause = $cause.InnerException }
  if ($cause -is [RemovalRelativeFixture+Rejected]) {
    [Console]::Out.WriteLine('rejected:' + $cause.Reason)
    exit 2
  }
  throw
} finally { if ($null -ne $session) { $session.Dispose() } }
