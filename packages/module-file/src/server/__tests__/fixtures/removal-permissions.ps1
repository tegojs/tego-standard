$ErrorActionPreference = 'Stop'
# New isolated objects only. No product helper, delete/disposition or arbitrary operation.
Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text;
using System.Text.RegularExpressions;
using Microsoft.Win32.SafeHandles;

public static class RemovalPermissionFixture {
  public sealed class BoundaryException : Exception {}
  public sealed class Observation {
    public bool restrictedThreadVerified, originalThreadRestored;
    public int newAttributeOpenError;
    public bool? oldAttributeWrite;
    public int? insideLinkError, outsideLinkError;
  }
  [StructLayout(LayoutKind.Sequential)]
  private struct SidAttributes { public IntPtr Sid; public uint Attributes; }
  [StructLayout(LayoutKind.Sequential)]
  private struct TokenGroupsOne { public uint Count; public SidAttributes First; }
  [StructLayout(LayoutKind.Sequential)]
  private struct HandleInfo {
    public uint Attributes, CreationLow, CreationHigh, AccessLow, AccessHigh, WriteLow, WriteHigh;
    public uint Volume, SizeHigh, SizeLow, Links, IndexHigh, IndexLow;
  }
  private const uint TokenQuery = 8, TokenDuplicate = 2, Dacl = 4;
  private const uint ProtectedDacl = 0x80000000, UnprotectedDacl = 0x20000000;
  private const string RestrictingSid = "S-1-5-12";
  private const FileSystemRights Read = FileSystemRights.ReadAndExecute | FileSystemRights.Synchronize;

  [DllImport("kernel32.dll")] private static extern IntPtr GetCurrentProcess();
  [DllImport("kernel32.dll")] private static extern IntPtr GetCurrentThread();
  [DllImport("advapi32.dll", SetLastError=true)]
  [return: MarshalAs(UnmanagedType.Bool)]
  private static extern bool OpenProcessToken(IntPtr process, uint access, out SafeAccessTokenHandle token);
  [DllImport("advapi32.dll", SetLastError=true)]
  [return: MarshalAs(UnmanagedType.Bool)]
  private static extern bool OpenThreadToken(IntPtr thread, uint access, bool asSelf, out SafeAccessTokenHandle token);
  [DllImport("advapi32.dll", SetLastError=true)]
  [return: MarshalAs(UnmanagedType.Bool)]
  private static extern bool CreateRestrictedToken(SafeAccessTokenHandle token, uint flags, uint disabledCount,
    IntPtr disabled, uint deletedCount, IntPtr deleted, uint restrictedCount, ref SidAttributes restricted,
    out SafeAccessTokenHandle result);
  [DllImport("advapi32.dll", SetLastError=true)]
  [return: MarshalAs(UnmanagedType.Bool)]
  private static extern bool IsTokenRestricted(SafeAccessTokenHandle token);
  [DllImport("advapi32.dll", SetLastError=true)]
  [return: MarshalAs(UnmanagedType.Bool)]
  private static extern bool GetTokenInformation(SafeAccessTokenHandle token, int kind, IntPtr data, uint size, out uint needed);
  [DllImport("advapi32.dll", SetLastError=true)]
  [return: MarshalAs(UnmanagedType.Bool)]
  private static extern bool ImpersonateLoggedOnUser(SafeAccessTokenHandle token);
  [DllImport("advapi32.dll", SetLastError=true)]
  [return: MarshalAs(UnmanagedType.Bool)]
  private static extern bool RevertToSelf();
  [DllImport("advapi32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  [return: MarshalAs(UnmanagedType.Bool)]
  private static extern bool GetFileSecurityW(string name, uint kind, byte[] data, uint size, out uint needed);
  [DllImport("advapi32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  [return: MarshalAs(UnmanagedType.Bool)]
  private static extern bool SetFileSecurityW(string name, uint kind, byte[] data);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  private static extern SafeFileHandle CreateFileW(string name, uint access, uint share, IntPtr security,
    uint disposition, uint flags, IntPtr template);
  [DllImport("kernel32.dll", SetLastError=true)]
  [return: MarshalAs(UnmanagedType.Bool)]
  private static extern bool GetFileInformationByHandle(SafeFileHandle handle, out HandleInfo info);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  [return: MarshalAs(UnmanagedType.Bool)]
  private static extern bool CreateDirectoryW(string name, IntPtr security);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  [return: MarshalAs(UnmanagedType.Bool)]
  private static extern bool CreateHardLinkW(string newName, string existingName, IntPtr reserved);
  [DllImport("kernel32.dll", SetLastError=true)]
  [return: MarshalAs(UnmanagedType.Bool)]
  private static extern bool SetFileTime(SafeFileHandle handle, IntPtr created, IntPtr accessed, ref long written);

  private static void Native(bool ok) { if (!ok) throw new Win32Exception(Marshal.GetLastWin32Error()); }
  private static string TokenUser(SafeAccessTokenHandle token) {
    uint size;
    GetTokenInformation(token, 1, IntPtr.Zero, 0, out size);
    if (size == 0) throw new Win32Exception(Marshal.GetLastWin32Error());
    IntPtr buffer = Marshal.AllocHGlobal(checked((int)size));
    try {
      Native(GetTokenInformation(token, 1, buffer, size, out size));
      return new SecurityIdentifier(Marshal.ReadIntPtr(buffer)).Value;
    } finally { Marshal.FreeHGlobal(buffer); }
  }
  private static void NoThreadToken() {
    SafeAccessTokenHandle thread;
    bool opened = OpenThreadToken(GetCurrentThread(), TokenQuery, true, out thread);
    int error = Marshal.GetLastWin32Error();
    if (thread != null) thread.Dispose();
    if (opened || error != 1008) throw new InvalidOperationException("Expected original thread without impersonation");
  }
  private static void VerifyRestrictedThread(string owner) {
    SafeAccessTokenHandle thread;
    Native(OpenThreadToken(GetCurrentThread(), TokenQuery, true, out thread));
    using (thread) {
      if (!IsTokenRestricted(thread) || TokenUser(thread) != owner)
        throw new InvalidOperationException("Actual thread token is not the derived restricted identity");
      uint size;
      GetTokenInformation(thread, 11, IntPtr.Zero, 0, out size);
      if (size == 0) throw new Win32Exception(Marshal.GetLastWin32Error());
      IntPtr buffer = Marshal.AllocHGlobal(checked((int)size));
      try {
        Native(GetTokenInformation(thread, 11, buffer, size, out size));
        int offset = Marshal.OffsetOf(typeof(TokenGroupsOne), "First").ToInt32();
        if (Marshal.ReadInt32(buffer) != 1 ||
          new SecurityIdentifier(Marshal.ReadIntPtr(buffer, offset)).Value != RestrictingSid)
          throw new InvalidOperationException("Unexpected actual restricting SID list");
      } finally { Marshal.FreeHGlobal(buffer); }
    }
  }
  private static void Restricted(SafeAccessTokenHandle token, string owner, Action operation) {
    NoThreadToken();
    Native(ImpersonateLoggedOnUser(token));
    try { VerifyRestrictedThread(owner); operation(); }
    finally {
      // Failed reversion must never continue privileged fixture work. / 恢复失败不继续。
      if (!RevertToSelf()) Environment.FailFast("Fixture thread reversion failed");
    }
    NoThreadToken();
  }
  private static byte[] ReadDacl(string name) {
    uint size;
    GetFileSecurityW(name, Dacl, null, 0, out size);
    if (size == 0) throw new Win32Exception(Marshal.GetLastWin32Error());
    byte[] buffer = new byte[size];
    Native(GetFileSecurityW(name, Dacl, buffer, size, out size));
    return buffer;
  }
  private sealed class SavedDacl : IDisposable {
    private readonly string name;
    private readonly byte[] original;
    public SavedDacl(string path) { name = path; original = ReadDacl(path); }
    public void Dispose() {
      NoThreadToken();
      var before = new RawSecurityDescriptor(original, 0);
      bool wasProtected = (before.ControlFlags & ControlFlags.DiscretionaryAclProtected) != 0;
      Native(SetFileSecurityW(name, Dacl | (wasProtected ? ProtectedDacl : UnprotectedDacl), original));
      var after = new RawSecurityDescriptor(ReadDacl(name), 0);
      // Legacy SetFileSecurity clears AI, not ACEs/protection. / AI 完成位不是访问权限。
      // Compare every ACE and other DACL flags; do not claim bit-for-bit descriptor restoration.
      before.SetFlags(before.ControlFlags & ~ControlFlags.DiscretionaryAclAutoInherited);
      after.SetFlags(after.ControlFlags & ~ControlFlags.DiscretionaryAclAutoInherited);
      if (after.GetSddlForm(AccessControlSections.Access) != before.GetSddlForm(AccessControlSections.Access))
        throw new InvalidOperationException("New fixture DACL permission restoration mismatch");
    }
  }
  private static void Grant(string name, string owner, FileSystemRights rights) {
    NoThreadToken();
    var descriptor = new RawSecurityDescriptor("D:P(A;;FA;;;" + owner + ")(A;;0x" +
      ((uint)rights).ToString("x") + ";;;" + RestrictingSid + ")");
    byte[] data = new byte[descriptor.BinaryLength];
    descriptor.GetBinaryForm(data, 0);
    Native(SetFileSecurityW(name, Dacl | ProtectedDacl, data));
  }
  private static SafeFileHandle PinDirectory(string name) {
    SafeFileHandle handle = CreateFileW(name, 0x80, 3, IntPtr.Zero, 3, 0x02200000, IntPtr.Zero);
    if (handle.IsInvalid) { int error = Marshal.GetLastWin32Error(); handle.Dispose(); throw new Win32Exception(error); }
    HandleInfo info;
    try {
      Native(GetFileInformationByHandle(handle, out info));
      if ((info.Attributes & 0x410) != 0x10) throw new BoundaryException();
      return handle;
    } catch { handle.Dispose(); throw; }
  }
  private static int OpenAttributes(string name, out SafeFileHandle handle) {
    handle = CreateFileW(name, (uint)FileSystemRights.WriteAttributes, 7, IntPtr.Zero, 3, 0x00200000, IntPtr.Zero);
    if (!handle.IsInvalid) return 0;
    int error = Marshal.GetLastWin32Error();
    handle.Dispose(); handle = null;
    return error;
  }
  private static void Boundary(string directory, string mode) {
    if (String.IsNullOrEmpty(directory) ||
      (mode != "granted" && mode != "new-attributes-denied" && mode != "old-attributes" && mode != "outside-alias"))
      throw new BoundaryException();
    string full = Path.GetFullPath(directory);
    string temp = Path.GetFullPath(Path.GetTempPath()).TrimEnd(Path.DirectorySeparatorChar);
    if (!String.Equals(full, directory, StringComparison.OrdinalIgnoreCase) ||
      !String.Equals(Path.GetDirectoryName(full), temp, StringComparison.OrdinalIgnoreCase) ||
      !Regex.IsMatch(Path.GetFileName(full), "^tego-removal-permissions-[A-Za-z0-9]+$"))
      throw new BoundaryException();
    for (var current = new DirectoryInfo(full); current != null; current = current.Parent) {
      if ((current.Attributes & FileAttributes.ReparsePoint) != 0) throw new BoundaryException();
    }
    if (Directory.GetFileSystemEntries(full).Length != 0) throw new BoundaryException();
  }
  public static Observation Run(string directory, string mode) {
    Boundary(directory, mode);
    NoThreadToken();
    SafeAccessTokenHandle primary;
    Native(OpenProcessToken(GetCurrentProcess(), TokenQuery | TokenDuplicate, out primary));
    using (primary) {
      if (IsTokenRestricted(primary)) throw new InvalidOperationException("Fixture requires an initially unrestricted primary token");
      string owner = TokenUser(primary);
      byte[] sidBytes = new byte[new SecurityIdentifier(RestrictingSid).BinaryLength];
      new SecurityIdentifier(RestrictingSid).GetBinaryForm(sidBytes, 0);
      var pinnedSid = GCHandle.Alloc(sidBytes, GCHandleType.Pinned);
      SafeAccessTokenHandle token;
      try {
        var sid = new SidAttributes { Sid = pinnedSid.AddrOfPinnedObject(), Attributes = 0 };
        // DISABLE_MAX_PRIVILEGE only; never SANDBOX_INERT or primary-token replacement.
        Native(CreateRestrictedToken(primary, 1, 0, IntPtr.Zero, 0, IntPtr.Zero, 1, ref sid, out token));
      } finally { pinnedSid.Free(); }
      using (token)
      using (var anchor = PinDirectory(directory))
      using (var savedAnchor = new SavedDacl(directory)) {
        if (Directory.GetFileSystemEntries(directory).Length != 0) throw new BoundaryException();
        Grant(directory, owner, Read);
        string data = Path.Combine(directory, "data"), outside = Path.Combine(directory, "outside");
        Native(CreateDirectoryW(data, IntPtr.Zero));
        Native(CreateDirectoryW(outside, IntPtr.Zero));
        using (var dataPin = PinDirectory(data))
        using (var outsidePin = PinDirectory(outside))
        using (var savedData = new SavedDacl(data))
        using (var savedOutside = new SavedDacl(outside)) {
          Grant(data, owner, Read | FileSystemRights.CreateFiles);
          Grant(outside, owner, Read | FileSystemRights.CreateFiles);
          string file = Path.Combine(data, "probe.txt");
          byte[] bytes = Encoding.UTF8.GetBytes("Fresh permission fixture bytes; never a business attachment\n");
          using (var stream = new FileStream(file, FileMode.CreateNew, FileAccess.Write, FileShare.Read))
            stream.Write(bytes, 0, bytes.Length);
          using (var savedFile = new SavedDacl(file)) {
            Grant(file, owner, Read | FileSystemRights.WriteAttributes);
            var result = new Observation();
            SafeFileHandle old = null;
            try {
              if (mode == "old-attributes") {
                Restricted(token, owner, delegate {
                  int error = OpenAttributes(file, out old);
                  if (error != 0) throw new Win32Exception(error);
                });
              }
              if (mode == "new-attributes-denied" || mode == "old-attributes") Grant(file, owner, Read);
              if (mode == "outside-alias") Grant(data, owner, Read);
              Restricted(token, owner, delegate {
                result.restrictedThreadVerified = true;
                SafeFileHandle opened;
                result.newAttributeOpenError = OpenAttributes(file, out opened);
                if (opened != null) opened.Dispose();
                if (mode == "old-attributes") {
                  long written = new DateTime(2000, 1, 2, 3, 4, 5, DateTimeKind.Utc).ToFileTimeUtc();
                  Native(SetFileTime(old, IntPtr.Zero, IntPtr.Zero, ref written));
                  result.oldAttributeWrite = true;
                }
                if (mode == "granted" || mode == "outside-alias") {
                  result.insideLinkError = CreateHardLinkW(Path.Combine(data, "inside-link.txt"), file, IntPtr.Zero)
                    ? 0 : Marshal.GetLastWin32Error();
                }
                if (mode == "outside-alias") {
                  result.outsideLinkError = CreateHardLinkW(Path.Combine(outside, "outside-link.txt"), file, IntPtr.Zero)
                    ? 0 : Marshal.GetLastWin32Error();
                }
              });
              NoThreadToken();
              if (IsTokenRestricted(primary) || TokenUser(primary) != owner)
                throw new InvalidOperationException("Original primary token identity changed");
              result.originalThreadRestored = true;
              return result;
            } finally { if (old != null) old.Dispose(); }
          }
        }
      }
    }
  }
}
'@
try {
  $result = [RemovalPermissionFixture]::Run($env:TEGO_PERMISSION_DIRECTORY, $env:TEGO_PERMISSION_CASE)
  [Console]::Out.WriteLine(($result | ConvertTo-Json -Compress))
} catch {
  $cause = $_.Exception
  while ($null -ne $cause.InnerException) { $cause = $cause.InnerException }
  if ($cause -is [RemovalPermissionFixture+BoundaryException]) {
    [Console]::Out.WriteLine('rejected:fixture-boundary')
    exit 2
  }
  throw
}
