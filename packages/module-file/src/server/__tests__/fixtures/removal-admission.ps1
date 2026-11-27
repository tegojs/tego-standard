$ErrorActionPreference = 'Stop'
# TEST FIXTURES ONLY. This is not a production lease, native deletion helper, or executor.
$fixtureDirectory = [IO.Path]::GetFullPath($env:TEGO_ADMISSION_FIXTURE_DIRECTORY)
$temporaryDirectory = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\')
if ([IO.Path]::GetDirectoryName($fixtureDirectory).TrimEnd('\') -ine $temporaryDirectory -or
    [IO.Path]::GetFileName($fixtureDirectory) -notmatch '^tego-removal-admission-[a-zA-Z0-9]+$') {
  throw 'Only a new, direct child test fixture of the OS temporary directory is accepted'
}
$root = [IO.Path]::Combine($fixtureDirectory, 'root')
$control = [IO.Path]::Combine($fixtureDirectory, 'control')
foreach ($directory in @($fixtureDirectory, $root, $control)) {
  $attributes = [IO.File]::GetAttributes($directory)
  if (($attributes -band [IO.FileAttributes]::Directory) -eq 0 -or
      ($attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
    throw 'Fixture directories must be real directories, not reparse points'
  }
}
# A same-spelling/session fixture key ONLY, not physical-root alias or deployment coverage.
$hash = [Security.Cryptography.SHA256]::Create()
try {
  $key = [Convert]::ToHexString($hash.ComputeHash([Text.Encoding]::UTF8.GetBytes($root.ToUpperInvariant())))
} finally { $hash.Dispose() }
$mutex = [Threading.Mutex]::new($false, 'Local\TegoRemovalAdmissionFixture_' + $key)
$script:owned = $false
$script:tainted = $false
$consumed = $false
function Enter-FixtureAdmission {
  if ($script:owned -or $script:tainted) {
    [Console]::WriteLine('rejected:admission')
    return
  }
  try {
    $script:owned = $mutex.WaitOne(0)
    [Console]::WriteLine($(if ($script:owned) { 'held' } else { 'busy' }))
  } catch [Threading.AbandonedMutexException] {
    # WaitOne grants ownership on abandonment, but unknown prior work is never permission.
    $script:owned = $true
    $script:tainted = $true
    [Console]::WriteLine('abandoned')
  }
}
try {
  Enter-FixtureAdmission
  :commands while ($null -ne ($command = [Console]::In.ReadLine())) {
    if ($command -eq 'release') { break commands }
    if ($command -eq 'take') { Enter-FixtureAdmission; continue }
    if ($command -notin @('write', 'queue-write')) {
      [Console]::WriteLine('rejected:command')
      continue
    }
    if (-not $script:owned -or $script:tainted) {
      [Console]::WriteLine('rejected:admission')
      continue
    }
    if ($consumed) {
      [Console]::WriteLine('rejected:consumed')
      continue
    }
    # Consume before the command could have a file side effect; no retry on any later error.
    $consumed = $true
    if ($command -eq 'queue-write') {
      [Console]::WriteLine('queued')
      $elapsed = [Diagnostics.Stopwatch]::StartNew()
      while (-not [IO.File]::Exists([IO.Path]::Combine($control, 'allow')) -and
          $elapsed.ElapsedMilliseconds -lt 15000) { [Threading.Thread]::Sleep(10) }
      if (-not [IO.File]::Exists([IO.Path]::Combine($control, 'allow'))) {
        [Console]::WriteLine('rejected:gate-timeout')
        continue
      }
    }
    # Only one fixed NEW object; never open, modify, or unlink attachment.txt.
    $file = [IO.FileStream]::new([IO.Path]::Combine($root, 'new-write.txt'),
      [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::Read)
    try {
      $bytes = [Text.Encoding]::UTF8.GetBytes('New admitted fixture write')
      $file.Write($bytes, 0, $bytes.Length)
    } finally { $file.Dispose() }
    [Console]::WriteLine('written')
  }
} finally {
  if ($script:owned) { $mutex.ReleaseMutex() }
  $mutex.Dispose()
}
