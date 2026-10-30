$ErrorActionPreference = 'Stop'
# NEW TEST FIXTURES ONLY. No disposition/unlink/rename, persistent attempt, or production executor.
$fixtureDirectory = [IO.Path]::GetFullPath($env:TEGO_SESSION_FIXTURE_DIRECTORY)
$temporaryDirectory = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\')
if ([IO.Path]::GetDirectoryName($fixtureDirectory).TrimEnd('\') -ine $temporaryDirectory -or
    [IO.Path]::GetFileName($fixtureDirectory) -notmatch '^tego-removal-session-[a-zA-Z0-9]+$') {
  throw 'Only a new, direct child test fixture of the OS temporary directory is accepted'
}
$pipeName = $env:TEGO_SESSION_FIXTURE_PIPE
if ($pipeName -cnotmatch '^tego-removal-session-[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$') {
  throw 'Unexpected test pipe namespace'
}
$root = [IO.Path]::Combine($fixtureDirectory, 'root')
$parent = [IO.Path]::Combine($root, 'nested')
$filename = [IO.Path]::Combine($parent, 'attachment.txt')
$expected = $env:TEGO_SESSION_FIXTURE_EXPECTED | ConvertFrom-Json -AsHashtable
Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Globalization;
using System.IO;
using System.IO.Pipes;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using Microsoft.Win32.SafeHandles;
public static class RemovalSessionFixture {
  [StructLayout(LayoutKind.Sequential)]
  private struct HandleInfo {
    public uint Attributes, CreationLow, CreationHigh, AccessLow, AccessHigh, WriteLow, WriteHigh;
    public uint Volume, SizeHigh, SizeLow, Links, IndexHigh, IndexLow;
  }
  [StructLayout(LayoutKind.Sequential)]
  private struct BasicInfo { public long Creation, Access, Write, Change; public uint Attributes; }
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
  private static extern bool GetNamedPipeClientProcessId(SafePipeHandle pipe, out uint processId);
  public static uint Peer(NamedPipeServerStream pipe) {
    uint processId;
    if (!GetNamedPipeClientProcessId(pipe.SafePipeHandle, out processId))
      throw new Win32Exception(Marshal.GetLastWin32Error());
    return processId;
  }
  public static SafeFileHandle Open(string name, bool directory) {
    SafeFileHandle handle = CreateFileW(name, directory ? 0x80u : 0x80010000u, directory ? 3u : 1u,
      IntPtr.Zero, 3, 0x00200000u | (directory ? 0x02000000u : 0u), IntPtr.Zero);
    if (handle.IsInvalid) {
      int code = Marshal.GetLastWin32Error(); handle.Dispose(); throw new Win32Exception(code);
    }
    return handle;
  }
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
  public static string Line(Stream pipe) {
    using (var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(10)))
    using (var bytes = new MemoryStream()) {
      var single = new byte[1];
      for (int count = 0; count <= 4096; count++) {
        int read = pipe.ReadAsync(single, 0, 1, timeout.Token).GetAwaiter().GetResult();
        if (read == 0) {
          if (bytes.Length == 0) return null;
          throw new InvalidDataException("protocol");
        }
        if (single[0] == 10) return new UTF8Encoding(false, true).GetString(bytes.ToArray());
        if (count == 4096) throw new InvalidDataException("protocol");
        bytes.WriteByte(single[0]);
      }
      throw new InvalidDataException("protocol");
    }
  }
}
'@
$options = [IO.Pipes.PipeOptions]::CurrentUserOnly -bor [IO.Pipes.PipeOptions]::FirstPipeInstance -bor
  [IO.Pipes.PipeOptions]::Asynchronous
$pipe = [IO.Pipes.NamedPipeServerStream]::new($pipeName, [IO.Pipes.PipeDirection]::InOut, 1,
  [IO.Pipes.PipeTransmissionMode]::Byte, $options)
$handles = [Collections.Generic.List[IDisposable]]::new()
$mutex = $null
$owned = $false
$writer = $null
$requestId = $null
$challenge = $null
$sessionId = $null
$peerProcessId = $null
function Read-Message {
  $line = [RemovalSessionFixture]::Line($pipe)
  if ($null -eq $line) { return $null }
  $document = [Text.Json.JsonDocument]::Parse($line)
  try {
    if ($document.RootElement.ValueKind -ne [Text.Json.JsonValueKind]::Object) {
      throw [IO.InvalidDataException]::new('protocol')
    }
    $names = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
    foreach ($property in $document.RootElement.EnumerateObject()) {
      if (-not $names.Add($property.Name)) { throw [IO.InvalidDataException]::new('protocol') }
    }
  } finally { $document.Dispose() }
  return ($line | ConvertFrom-Json -AsHashtable)
}
function Assert-Message($message, [bool]$first) {
  $names = @('version', 'kind', 'requestId', 'challenge')
  if (-not $first) { $names += 'sessionId' }
  if ($message.Count -ne $names.Count -or
      (-not ($message.version -is [int] -or $message.version -is [long])) -or $message.version -ne 1) {
    throw [IO.InvalidDataException]::new('protocol')
  }
  foreach ($name in $message.Keys) {
    if ($name -cnotin $names) { throw [IO.InvalidDataException]::new('protocol') }
  }
  foreach ($name in @('requestId', 'challenge') + $(if ($first) { @() } else { @('sessionId') })) {
    $parsed = [guid]::Empty
    if ($message[$name] -isnot [string] -or -not [guid]::TryParseExact($message[$name], 'D', [ref]$parsed) -or
        $parsed.ToString('D') -cne $message[$name]) { throw [IO.InvalidDataException]::new('protocol') }
  }
  if (($first -and $message.kind -cne 'hello') -or
      (-not $first -and $message.kind -cnotin @('observe', 'close'))) {
    throw [IO.InvalidDataException]::new('protocol')
  }
}
function Observe-Fixture {
  $directories = @()
  for ($index = 0; $index -lt 4; $index++) {
    $actual = [RemovalSessionFixture]::Inspect($handles[$index])
    $wanted = if ($index -eq 3) { $expected.file } else { $expected.directories[$index] }
    if ($actual.reparse -or ($index -lt 3 -and -not $actual.directory) -or
        ($index -eq 3 -and ($actual.directory -or $actual.nlink -ne '1'))) {
      throw [IO.InvalidDataException]::new('identity')
    }
    $fields = @('dev', 'ino', 'birthtimeNs')
    if ($index -eq 3) { $fields += @('mtimeNs', 'ctimeNs', 'size', 'nlink') }
    foreach ($field in $fields) {
      if ([string]$actual.$field -cne [string]$wanted.$field) { throw [IO.InvalidDataException]::new('identity') }
    }
    if ($index -lt 3) { $directories += $actual } else { $object = $actual }
  }
  return @{ file = $object; directories = $directories }
}
function Send-Reply([string]$kind, [string]$reason, $observations) {
  $reply = @{ version = 1; kind = $kind; requestId = $requestId; challenge = $challenge }
  if ($null -ne $sessionId) { $reply.sessionId = $sessionId }
  if ($reason) { $reply.reason = $reason }
  if ($null -ne $observations) {
    $reply.observations = $observations
    $reply.peerProcessId = $peerProcessId
    $reply.brokerProcessId = [int]$PID
  }
  $writer.WriteLine(($reply | ConvertTo-Json -Depth 8 -Compress))
}
try {
  if (-not $pipe.WaitForConnectionAsync().Wait(10000)) { throw 'Fixture pipe connection timeout' }
  $peerProcessId = [RemovalSessionFixture]::Peer($pipe)
  $writer = [IO.StreamWriter]::new($pipe, [Text.UTF8Encoding]::new($false, $true), 1024, $true)
  $writer.NewLine = [string][char]10
  $writer.AutoFlush = $true
  $hello = Read-Message
  if ($null -eq $hello) { return }
  Assert-Message $hello $true
  $requestId = $hello.requestId
  $challenge = $hello.challenge
  $hash = [Security.Cryptography.SHA256]::Create()
  try { $key = [Convert]::ToHexString($hash.ComputeHash([Text.Encoding]::UTF8.GetBytes($root.ToUpperInvariant()))) }
  finally { $hash.Dispose() }
  $mutex = [Threading.Mutex]::new($false, 'Local\TegoRemovalSessionFixture_' + $key)
  try { $owned = $mutex.WaitOne(0) }
  catch [Threading.AbandonedMutexException] {
    $owned = $true
    Send-Reply 'rejected' 'abandoned' $null
    return
  }
  if (-not $owned) { Send-Reply 'rejected' 'busy' $null; return }
  foreach ($name in @($fixtureDirectory, $root, $parent)) {
    $handles.Add([RemovalSessionFixture]::Open($name, $true))
  }
  $handles.Add([RemovalSessionFixture]::Open($filename, $false))
  $observations = Observe-Fixture
  $sessionId = [guid]::NewGuid().ToString('D')
  $requests = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
  [void]$requests.Add($requestId)
  Send-Reply 'held' '' $observations
  while ($null -ne ($message = Read-Message)) {
    Assert-Message $message $false
    $requestId = $message.requestId
    if ($message.challenge -cne $challenge -or $message.sessionId -cne $sessionId) {
      throw [IO.InvalidDataException]::new('session')
    }
    if (-not $requests.Add($requestId)) { throw [IO.InvalidDataException]::new('replay') }
    if ($message.kind -ceq 'close') { Send-Reply 'closed' '' $null; break }
    Send-Reply 'observed' '' (Observe-Fixture)
  }
} catch {
  $cause = $_.Exception
  while ($null -ne $cause.InnerException) { $cause = $cause.InnerException }
  $reason = if ($cause -is [ComponentModel.Win32Exception]) { 'native' }
    elseif ($cause -is [IO.InvalidDataException] -and $cause.Message -cin @('identity', 'session', 'replay')) {
      $cause.Message
    } else { 'protocol' }
  if ($null -ne $writer -and $pipe.IsConnected) {
    try { Send-Reply 'rejected' $reason $null } catch { }
  } else { throw }
} finally {
  for ($index = $handles.Count - 1; $index -ge 0; $index--) { $handles[$index].Dispose() }
  if ($owned) { $mutex.ReleaseMutex() }
  if ($null -ne $mutex) { $mutex.Dispose() }
  if ($null -ne $writer) { $writer.Dispose() }
  $pipe.Dispose()
}
