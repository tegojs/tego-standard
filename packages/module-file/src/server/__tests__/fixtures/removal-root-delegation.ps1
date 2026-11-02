param([string] $InheritedRoot = '')
$ErrorActionPreference = 'Stop'
# Fixed new fixture only. No deletion, disposition, arbitrary command or production root authority.
Add-Type -TypeDefinition @'
using System;
using System.Collections;
using System.Collections.Generic;
using System.ComponentModel;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;
using Microsoft.Win32.SafeHandles;

public static class RemovalRootDelegationFixture {
  public sealed class Rejected : Exception {
    public string Reason;
    public Rejected(string reason) { Reason = reason; }
  }
  [StructLayout(LayoutKind.Sequential)]
  private struct Info {
    public uint Attributes, CreationLow, CreationHigh, AccessLow, AccessHigh, WriteLow, WriteHigh;
    public uint Volume, SizeHigh, SizeLow, Links, IndexHigh, IndexLow;
  }
  [StructLayout(LayoutKind.Sequential)]
  private struct Security { public uint Length; public IntPtr Descriptor; public int Inherit; }
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
  private struct Startup {
    public uint Size; public string Reserved, Desktop, Title;
    public uint X, Y, XSize, YSize, XCount, YCount, Fill, Flags;
    public ushort Show, ReservedSize;
    public IntPtr ReservedBytes, Input, Output, Error;
  }
  [StructLayout(LayoutKind.Sequential)]
  private struct StartupEx { public Startup Startup; public IntPtr Attributes; }
  [StructLayout(LayoutKind.Sequential)]
  private struct ProcessInfo { public IntPtr Process, Thread; public uint ProcessId, ThreadId; }
  [StructLayout(LayoutKind.Sequential)]
  private struct UnicodeName { public ushort Length, MaximumLength; public IntPtr Buffer; }
  [StructLayout(LayoutKind.Sequential)]
  private struct ObjectAttributes {
    public uint Length; public IntPtr Root, Name; public uint Attributes;
    public IntPtr SecurityDescriptor, SecurityQualityOfService;
  }
  [StructLayout(LayoutKind.Sequential)]
  private struct IoStatus { public IntPtr Status; public UIntPtr Information; }
  public sealed class Observation {
    public string state, rootDev, rootIno, dev, ino, bytes;
    public int attributeError;
  }
  public sealed class Pin { public string state, rootDev, rootIno; }
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  private static extern SafeFileHandle CreateFileW(string name, uint access, uint share,
    IntPtr security, uint disposition, uint flags, IntPtr template);
  [DllImport("kernel32.dll", SetLastError=true)]
  private static extern bool GetFileInformationByHandle(SafeFileHandle handle, out Info info);
  [DllImport("kernel32.dll")]
  private static extern IntPtr GetCurrentProcess();
  [DllImport("kernel32.dll", SetLastError=true)]
  private static extern bool DuplicateHandle(IntPtr sourceProcess, SafeFileHandle source, IntPtr targetProcess,
    out SafeFileHandle target, uint access, bool inherit, uint options);
  [DllImport("kernel32.dll", SetLastError=true)]
  private static extern bool CreatePipe(out SafeFileHandle read, out SafeFileHandle write, ref Security security, uint size);
  [DllImport("kernel32.dll", SetLastError=true)]
  private static extern bool SetHandleInformation(SafeFileHandle handle, uint mask, uint flags);
  [DllImport("kernel32.dll", SetLastError=true)]
  private static extern bool InitializeProcThreadAttributeList(IntPtr list, int count, uint flags, ref IntPtr size);
  [DllImport("kernel32.dll", SetLastError=true)]
  private static extern bool UpdateProcThreadAttribute(IntPtr list, uint flags, IntPtr attribute,
    IntPtr value, IntPtr size, IntPtr previous, IntPtr returned);
  [DllImport("kernel32.dll")]
  private static extern void DeleteProcThreadAttributeList(IntPtr list);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  private static extern bool CreateProcessW(string application, StringBuilder command, IntPtr processSecurity,
    IntPtr threadSecurity, bool inherit, uint flags, IntPtr environment, string currentDirectory,
    ref StartupEx startup, out ProcessInfo process);
  [DllImport("kernel32.dll", SetLastError=true)]
  private static extern uint ResumeThread(IntPtr thread);
  [DllImport("kernel32.dll", SetLastError=true)]
  private static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
  [DllImport("kernel32.dll", SetLastError=true)]
  private static extern bool GetExitCodeProcess(IntPtr process, out uint exit);
  [DllImport("kernel32.dll", SetLastError=true)]
  private static extern bool TerminateProcess(IntPtr process, uint exit);
  [DllImport("kernel32.dll")]
  private static extern bool CloseHandle(IntPtr handle);
  [DllImport("kernel32.dll", SetLastError=true)]
  private static extern bool SetFileTime(SafeFileHandle handle, IntPtr creation, IntPtr access, ref long write);
  [DllImport("kernel32.dll", SetLastError=true)]
  private static extern bool ReadFile(SafeFileHandle handle, byte[] bytes, uint count, out uint read, IntPtr overlapped);
  [DllImport("ntdll.dll")]
  private static extern int NtCreateFile(out SafeFileHandle handle, uint access, ref ObjectAttributes attributes,
    out IoStatus status, IntPtr allocation, uint fileAttributes, uint share, uint disposition, uint options,
    IntPtr ea, uint eaLength);
  [DllImport("ntdll.dll")]
  private static extern uint RtlNtStatusToDosError(int status);

  private const string Original = "Original delegated root fixture\n";
  private static void Check(bool result) { if (!result) throw new Win32Exception(Marshal.GetLastWin32Error()); }
  private static string Dev(Info info) { return info.Volume.ToString(CultureInfo.InvariantCulture); }
  private static string Inode(Info info) {
    return (((ulong)info.IndexHigh << 32) | info.IndexLow).ToString(CultureInfo.InvariantCulture);
  }
  private static Info Inspect(SafeFileHandle handle, bool directory) {
    Info info;
    if (!GetFileInformationByHandle(handle, out info) || (info.Attributes & 0x400) != 0 ||
      ((info.Attributes & 0x10) != 0) != directory) throw new Rejected("inherited-root");
    return info;
  }
  private static SafeFileHandle OpenLeaf(SafeFileHandle root) {
    const string name = "probe.txt";
    IntPtr buffer = Marshal.StringToHGlobalUni(name), pointer = IntPtr.Zero;
    try {
      var unicode = new UnicodeName { Length = (ushort)(name.Length * 2),
        MaximumLength = (ushort)(name.Length * 2 + 2), Buffer = buffer };
      pointer = Marshal.AllocHGlobal(Marshal.SizeOf(typeof(UnicodeName)));
      Marshal.StructureToPtr(unicode, pointer, false);
      var attributes = new ObjectAttributes { Length = (uint)Marshal.SizeOf(typeof(ObjectAttributes)),
        Root = root.DangerousGetHandle(), Name = pointer, Attributes = 0x40 };
      SafeFileHandle file; IoStatus io;
      int status = NtCreateFile(out file, 0x100081, ref attributes, out io, IntPtr.Zero, 0, 7, 1,
        0x00200060, IntPtr.Zero, 0);
      if (status < 0) {
        if (file != null) file.Dispose();
        throw new Win32Exception((int)RtlNtStatusToDosError(status));
      }
      return file;
    } finally {
      if (pointer != IntPtr.Zero) Marshal.FreeHGlobal(pointer);
      Marshal.FreeHGlobal(buffer);
    }
  }
  public static Observation ReadInherited(string value) {
    if (!String.IsNullOrEmpty(Environment.GetEnvironmentVariable("TEGO_DELEGATION_DIRECTORY")) ||
      !String.IsNullOrEmpty(Environment.GetEnvironmentVariable("TEGO_DELEGATION_MODE")))
      throw new Rejected("fixture-boundary");
    long number;
    if (!Int64.TryParse(value, NumberStyles.None, CultureInfo.InvariantCulture, out number) || number <= 0)
      throw new Rejected("inherited-root");
    using (var root = new SafeFileHandle(new IntPtr(number), true)) {
      var rootInfo = Inspect(root, true);
      // Actual access check on the inherited duplicate, not a reported access-mask assertion.
      long fixedTime = new DateTime(2020, 1, 1, 0, 0, 0, DateTimeKind.Utc).ToFileTimeUtc();
      bool changed = SetFileTime(root, IntPtr.Zero, IntPtr.Zero, ref fixedTime);
      int error = changed ? 0 : Marshal.GetLastWin32Error();
      if (error != 5) throw new Rejected("access-not-reduced");
      using (var file = OpenLeaf(root)) {
        var info = Inspect(file, false);
        var bytes = new byte[Encoding.UTF8.GetByteCount(Original)];
        if (info.Links != 1 || info.SizeHigh != 0 || info.SizeLow != bytes.Length)
          throw new Rejected("binding-change");
        uint count;
        Check(ReadFile(file, bytes, (uint)bytes.Length, out count, IntPtr.Zero));
        if (count != bytes.Length || Encoding.UTF8.GetString(bytes) != Original) throw new Rejected("binding-change");
        return new Observation { state = "delegated-read", rootDev = Dev(rootInfo), rootIno = Inode(rootInfo),
          dev = Dev(info), ino = Inode(info), bytes = Convert.ToBase64String(bytes), attributeError = error };
      }
    }
  }
  private static void Boundary(string directory, string mode) {
    if (String.IsNullOrEmpty(directory) || (mode != "delegate" && mode != "omit-root"))
      throw new Rejected("fixture-boundary");
    string full = Path.GetFullPath(directory);
    string temp = Path.GetFullPath(Path.GetTempPath()).TrimEnd(Path.DirectorySeparatorChar);
    if (!String.Equals(full, directory, StringComparison.OrdinalIgnoreCase) ||
      !String.Equals(Path.GetDirectoryName(full), temp, StringComparison.OrdinalIgnoreCase) ||
      !Regex.IsMatch(Path.GetFileName(full), "^tego-removal-root-delegation-[A-Za-z0-9]+$"))
      throw new Rejected("fixture-boundary");
    for (var current = new DirectoryInfo(full); current != null; current = current.Parent)
      if ((current.Attributes & FileAttributes.ReparsePoint) != 0) throw new Rejected("fixture-boundary");
    if (Directory.GetFileSystemEntries(full).Length != 2) throw new Rejected("fixture-boundary");
    foreach (string name in new [] { "root", "replacement" }) {
      string root = Path.Combine(full, name);
      if ((File.GetAttributes(root) & (FileAttributes.Directory | FileAttributes.ReparsePoint)) != FileAttributes.Directory)
        throw new Rejected("fixture-boundary");
      string[] entries = Directory.GetFileSystemEntries(root);
      if (entries.Length != 1 || !String.Equals(entries[0], Path.Combine(root, "probe.txt"), StringComparison.OrdinalIgnoreCase) ||
        (File.GetAttributes(entries[0]) & (FileAttributes.Directory | FileAttributes.ReparsePoint)) != 0)
        throw new Rejected("fixture-boundary");
    }
  }
  private static IntPtr WorkerEnvironment() {
    var values = new SortedDictionary<string, string>(StringComparer.OrdinalIgnoreCase);
    foreach (DictionaryEntry entry in Environment.GetEnvironmentVariables()) {
      string key = (string)entry.Key;
      if (key != "TEGO_DELEGATION_DIRECTORY" && key != "TEGO_DELEGATION_MODE") values[key] = (string)entry.Value;
    }
    var block = new StringBuilder();
    foreach (var entry in values) block.Append(entry.Key).Append('=').Append(entry.Value).Append('\0');
    block.Append('\0');
    return Marshal.StringToHGlobalUni(block.ToString());
  }
  public sealed class Session : IDisposable {
    private SafeFileHandle root;
    private bool omit, consumed;
    private Session() {}
    public static Session Open(string directory, string mode) {
      Boundary(directory, mode);
      var session = new Session();
      try {
        session.root = CreateFileW(Path.Combine(directory, "root"), 0x1001a0, 7, IntPtr.Zero, 3, 0x02200000, IntPtr.Zero);
        if (session.root.IsInvalid) throw new Win32Exception(Marshal.GetLastWin32Error());
        Inspect(session.root, true);
        session.omit = mode == "omit-root";
        return session;
      } catch { session.Dispose(); throw; }
    }
    public Pin Status() {
      var info = Inspect(root, true);
      return new Pin { state = "root-held", rootDev = Dev(info), rootIno = Inode(info) };
    }
    public string Delegate(string executable, string script, out int exit) {
      if (consumed) throw new Rejected("command");
      consumed = true;
      if (!Path.IsPathFullyQualified(executable) || !Path.IsPathFullyQualified(script) ||
        Path.GetFileName(executable) != "pwsh.exe" || Path.GetFileName(script) != "removal-root-delegation.ps1" ||
        executable.Contains("\"") || script.Contains("\"")) throw new Rejected("fixture-boundary");
      SafeFileHandle duplicate = null, inputRead = null, inputWrite = null, outputRead = null, outputWrite = null;
      IntPtr list = IntPtr.Zero, handles = IntPtr.Zero, environment = IntPtr.Zero;
      bool initialized = false, created = false, exited = false;
      var process = new ProcessInfo();
      try {
        IntPtr current = GetCurrentProcess();
        Check(DuplicateHandle(current, root, current, out duplicate, 0x1000a0, true, 0));
        var security = new Security { Length = (uint)Marshal.SizeOf(typeof(Security)), Inherit = 1 };
        Check(CreatePipe(out inputRead, out inputWrite, ref security, 0));
        Check(CreatePipe(out outputRead, out outputWrite, ref security, 0));
        Check(SetHandleInformation(inputWrite, 1, 0));
        Check(SetHandleInformation(outputRead, 1, 0));
        var selected = omit ? new [] { inputRead.DangerousGetHandle(), outputWrite.DangerousGetHandle() } :
          new [] { duplicate.DangerousGetHandle(), inputRead.DangerousGetHandle(), outputWrite.DangerousGetHandle() };
        IntPtr size = IntPtr.Zero;
        InitializeProcThreadAttributeList(IntPtr.Zero, 1, 0, ref size);
        if (size == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
        list = Marshal.AllocHGlobal(size);
        Check(InitializeProcThreadAttributeList(list, 1, 0, ref size)); initialized = true;
        handles = Marshal.AllocHGlobal(selected.Length * IntPtr.Size);
        Marshal.Copy(selected, 0, handles, selected.Length);
        Check(UpdateProcThreadAttribute(list, 0, new IntPtr(0x20002), handles,
          new IntPtr(selected.Length * IntPtr.Size), IntPtr.Zero, IntPtr.Zero));
        var startup = new StartupEx { Attributes = list, Startup = new Startup {
          Size = (uint)Marshal.SizeOf(typeof(StartupEx)), Flags = 0x100,
          Input = inputRead.DangerousGetHandle(), Output = outputWrite.DangerousGetHandle(), Error = outputWrite.DangerousGetHandle() } };
        var command = new StringBuilder("\"" + executable + "\" -NoLogo -NoProfile -NonInteractive -File \"" + script +
          "\" -InheritedRoot " + duplicate.DangerousGetHandle().ToInt64().ToString(CultureInfo.InvariantCulture));
        environment = WorkerEnvironment();
        Check(CreateProcessW(executable, command, IntPtr.Zero, IntPtr.Zero, true, 0x08080404,
          environment, Path.GetDirectoryName(executable), ref startup, out process)); created = true;
        // The worker cannot execute until BOTH launcher root copies are actually closed.
        root.Dispose(); root = null;
        duplicate.Dispose(); duplicate = null;
        inputRead.Dispose(); inputRead = null;
        outputWrite.Dispose(); outputWrite = null;
        inputWrite.Dispose(); inputWrite = null;
        if (ResumeThread(process.Thread) == UInt32.MaxValue) throw new Win32Exception(Marshal.GetLastWin32Error());
        string output;
        using (var stream = new FileStream(outputRead, FileAccess.Read))
        using (var reader = new StreamReader(stream, Encoding.UTF8)) output = reader.ReadToEnd();
        outputRead = null;
        if (WaitForSingleObject(process.Process, 30000) != 0) throw new Rejected("worker-exit");
        uint code; Check(GetExitCodeProcess(process.Process, out code)); exited = true;
        if (output.Length > 4096 || (code != 0 && code != 2)) throw new Rejected("worker-exit");
        exit = (int)code;
        return output;
      } finally {
        if (created && !exited) { TerminateProcess(process.Process, 2); WaitForSingleObject(process.Process, 30000); }
        if (process.Thread != IntPtr.Zero) CloseHandle(process.Thread);
        if (process.Process != IntPtr.Zero) CloseHandle(process.Process);
        if (initialized) DeleteProcThreadAttributeList(list);
        if (list != IntPtr.Zero) Marshal.FreeHGlobal(list);
        if (handles != IntPtr.Zero) Marshal.FreeHGlobal(handles);
        if (environment != IntPtr.Zero) Marshal.FreeHGlobal(environment);
        if (duplicate != null) duplicate.Dispose();
        if (inputRead != null) inputRead.Dispose();
        if (inputWrite != null) inputWrite.Dispose();
        if (outputRead != null) outputRead.Dispose();
        if (outputWrite != null) outputWrite.Dispose();
      }
    }
    public void Dispose() { if (root != null) { root.Dispose(); root = null; } }
  }
}
'@
$session = $null
try {
  if ($InheritedRoot -ne '') {
    $observation = [RemovalRootDelegationFixture]::ReadInherited($InheritedRoot)
    [Console]::Out.WriteLine(($observation | ConvertTo-Json -Compress))
  } else {
    $session = [RemovalRootDelegationFixture+Session]::Open($env:TEGO_DELEGATION_DIRECTORY, $env:TEGO_DELEGATION_MODE)
    [Console]::Out.WriteLine(($session.Status() | ConvertTo-Json -Compress))
    [Console]::Out.Flush()
    if ([Console]::In.ReadLine() -ne 'delegate-and-close') { throw [RemovalRootDelegationFixture+Rejected]::new('command') }
    $workerExit = 0
    $output = $session.Delegate((Join-Path $PSHOME 'pwsh.exe'), $PSCommandPath, [ref] $workerExit)
    [Console]::Out.Write($output)
    [Console]::Out.Flush()
    exit $workerExit
  }
} catch {
  $cause = $_.Exception
  while ($null -ne $cause.InnerException) { $cause = $cause.InnerException }
  if ($cause -is [RemovalRootDelegationFixture+Rejected]) {
    [Console]::Out.WriteLine('rejected:' + $cause.Reason)
    exit 2
  }
  throw
} finally { if ($null -ne $session) { $session.Dispose() } }
