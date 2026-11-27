$ErrorActionPreference = 'Stop'
# New test directories only. No file writes, disposition, deletion or caller-supplied alias/key.
Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using Microsoft.Win32.SafeHandles;

public static class RemovalRootAliasFixture {
  public sealed class Rejected : Exception {
    public string Reason;
    public Rejected(string reason) { Reason = reason; }
  }
  [StructLayout(LayoutKind.Sequential)]
  private struct LegacyInfo {
    public uint Attributes, CreationLow, CreationHigh, AccessLow, AccessHigh, WriteLow, WriteHigh;
    public uint Volume, SizeHigh, SizeLow, Links, IndexHigh, IndexLow;
  }
  [StructLayout(LayoutKind.Sequential)]
  private struct FileIdentity {
    public ulong VolumeSerial;
    [MarshalAs(UnmanagedType.ByValArray, SizeConst=16)] public byte[] FileId;
  }
  public sealed class Observation {
    public string state, openedVia, dev, ino, volumeGuid, volumeSerial, fileId128;
  }
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  private static extern SafeFileHandle CreateFileW(string name, uint access, uint share,
    IntPtr security, uint disposition, uint flags, IntPtr template);
  [DllImport("kernel32.dll", SetLastError=true)]
  [return: MarshalAs(UnmanagedType.Bool)]
  private static extern bool GetFileInformationByHandle(SafeFileHandle handle, out LegacyInfo info);
  [DllImport("kernel32.dll", SetLastError=true)]
  [return: MarshalAs(UnmanagedType.Bool)]
  private static extern bool GetFileInformationByHandleEx(SafeFileHandle handle, int informationClass,
    out FileIdentity identity, uint size);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  private static extern uint GetFinalPathNameByHandleW(SafeFileHandle handle, StringBuilder path, uint size, uint flags);

  private static SafeFileHandle OpenRoot(string path) {
    var handle = CreateFileW(path, 0x80, 3, IntPtr.Zero, 3, 0x02200000, IntPtr.Zero);
    if (handle.IsInvalid) {
      int error = Marshal.GetLastWin32Error(); handle.Dispose(); throw new Win32Exception(error);
    }
    return handle;
  }
  private static Observation Inspect(SafeFileHandle handle, string via, out string finalPath) {
    LegacyInfo legacy;
    if (!GetFileInformationByHandle(handle, out legacy)) throw new Win32Exception(Marshal.GetLastWin32Error());
    if ((legacy.Attributes & 0x410) != 0x10) throw new Rejected("fixture-boundary");
    FileIdentity identity;
    if (!GetFileInformationByHandleEx(handle, 18, out identity, (uint)Marshal.SizeOf(typeof(FileIdentity))))
      throw new Win32Exception(Marshal.GetLastWin32Error());
    var buffer = new StringBuilder(32768);
    uint count = GetFinalPathNameByHandleW(handle, buffer, (uint)buffer.Capacity, 1);
    if (count == 0) throw new Win32Exception(Marshal.GetLastWin32Error());
    if (count >= buffer.Capacity) throw new Rejected("unsupported-volume");
    finalPath = buffer.ToString();
    const string prefix = @"\\?\Volume{";
    Guid volume;
    if (!finalPath.StartsWith(prefix, StringComparison.OrdinalIgnoreCase) || finalPath.Length <= prefix.Length + 37 ||
      finalPath[prefix.Length + 36] != '}' || finalPath[prefix.Length + 37] != Path.DirectorySeparatorChar ||
      !Guid.TryParseExact(finalPath.Substring(prefix.Length, 36), "D", out volume) || identity.VolumeSerial == 0 ||
      identity.FileId == null || identity.FileId.Length != 16) throw new Rejected("unsupported-volume");
    string fileId = BitConverter.ToString(identity.FileId).Replace("-", "");
    if (fileId == "00000000000000000000000000000000") throw new Rejected("unsupported-volume");
    return new Observation {
      openedVia = via,
      dev = legacy.Volume.ToString(CultureInfo.InvariantCulture),
      ino = (((ulong)legacy.IndexHigh << 32) | legacy.IndexLow).ToString(CultureInfo.InvariantCulture),
      volumeGuid = volume.ToString("D").ToUpperInvariant(),
      volumeSerial = identity.VolumeSerial.ToString(CultureInfo.InvariantCulture), fileId128 = fileId
    };
  }
  private static bool Same(Observation first, Observation second) {
    return first.volumeGuid == second.volumeGuid && first.volumeSerial == second.volumeSerial &&
      first.fileId128 == second.fileId128 && first.dev == second.dev && first.ino == second.ino;
  }
  private static void Boundary(string directory, string mode) {
    if (String.IsNullOrEmpty(directory) || (mode != "hold-dos-root" && mode != "hold-guid-root" &&
      mode != "probe-guid-root" && mode != "probe-dos-root" && mode != "probe-dos-other"))
      throw new Rejected("fixture-boundary");
    string full = Path.GetFullPath(directory);
    string temp = Path.GetFullPath(Path.GetTempPath()).TrimEnd(Path.DirectorySeparatorChar);
    if (!String.Equals(full, directory, StringComparison.OrdinalIgnoreCase) ||
      !String.Equals(Path.GetDirectoryName(full), temp, StringComparison.OrdinalIgnoreCase) ||
      !Regex.IsMatch(Path.GetFileName(full), "^tego-removal-root-alias-[A-Za-z0-9]+$"))
      throw new Rejected("fixture-boundary");
    for (var current = new DirectoryInfo(full); current != null; current = current.Parent)
      if ((current.Attributes & FileAttributes.ReparsePoint) != 0) throw new Rejected("fixture-boundary");
    if (Directory.GetFileSystemEntries(full).Length != 2) throw new Rejected("fixture-boundary");
    foreach (string child in new [] { "root", "other" }) {
      string root = Path.Combine(full, child);
      if ((File.GetAttributes(root) & (FileAttributes.Directory | FileAttributes.ReparsePoint)) != FileAttributes.Directory)
        throw new Rejected("fixture-boundary");
      var entries = Directory.GetFileSystemEntries(root);
      if (entries.Length != 1 || !String.Equals(entries[0], Path.Combine(root, "probe.txt"), StringComparison.OrdinalIgnoreCase) ||
        (File.GetAttributes(entries[0]) & (FileAttributes.Directory | FileAttributes.ReparsePoint)) != 0)
        throw new Rejected("fixture-boundary");
    }
  }

  public sealed class Session : IDisposable {
    private SafeFileHandle root;
    private Mutex mutex;
    private bool owns, holder;
    private Observation observation;
    private Session() {}
    public static Session Create(string directory, string mode) {
      Boundary(directory, mode);
      var session = new Session();
      try {
        string dosPath = Path.Combine(directory, mode == "probe-dos-other" ? "other" : "root");
        using (var source = OpenRoot(dosPath)) {
          string actualAlias;
          var original = Inspect(source, "dos", out actualAlias);
          bool guid = mode == "hold-guid-root" || mode == "probe-guid-root";
          session.root = OpenRoot(guid ? actualAlias : dosPath);
          string selectedAlias;
          session.observation = Inspect(session.root, guid ? "volume-guid" : "dos", out selectedAlias);
          if (!Same(original, session.observation)) throw new Rejected("identity-change");
        }
        string material = session.observation.volumeGuid + ":" + session.observation.volumeSerial + ":" + session.observation.fileId128;
        string key;
        using (var hash = SHA256.Create()) key = BitConverter.ToString(hash.ComputeHash(Encoding.UTF8.GetBytes(material))).Replace("-", "");
        // Private derivation, not a secret, credential, externally accepted key or persistent history.
        session.mutex = new Mutex(false, @"Local\TegoRemovalRootAliasFixture-v1-" + key);
        try { session.owns = session.mutex.WaitOne(0); }
        catch (AbandonedMutexException) { session.owns = true; throw new Rejected("abandoned"); }
        session.holder = mode == "hold-dos-root" || mode == "hold-guid-root";
        session.observation.state = session.owns ? (session.holder ? "held" : "acquired") : "busy";
        return session;
      } catch { session.Dispose(); throw; }
    }
    public Observation Status() { return observation; }
    public void Release() {
      if (!holder || !owns) throw new Rejected("command");
      mutex.ReleaseMutex(); owns = false;
    }
    public void Dispose() {
      try { if (owns) { mutex.ReleaseMutex(); owns = false; } }
      finally {
        try { if (mutex != null) { mutex.Dispose(); mutex = null; } }
        finally { if (root != null) { root.Dispose(); root = null; } }
      }
    }
  }
}
'@
$session = $null
try {
  $session = [RemovalRootAliasFixture+Session]::Create($env:TEGO_ROOT_ALIAS_DIRECTORY, $env:TEGO_ROOT_ALIAS_MODE)
  $observation = $session.Status()
  [Console]::Out.WriteLine(($observation | ConvertTo-Json -Compress))
  [Console]::Out.Flush()
  if ($observation.state -eq 'held') {
    if ([Console]::In.ReadLine() -ne 'release-and-close') { throw [RemovalRootAliasFixture+Rejected]::new('command') }
    $session.Release()
    [Console]::Out.WriteLine('released')
    [Console]::Out.Flush()
  }
} catch {
  $cause = $_.Exception
  while ($null -ne $cause.InnerException) { $cause = $cause.InnerException }
  if ($cause -is [RemovalRootAliasFixture+Rejected]) {
    [Console]::Out.WriteLine('rejected:' + $cause.Reason)
    exit 2
  }
  throw
} finally { if ($null -ne $session) { $session.Dispose() } }
