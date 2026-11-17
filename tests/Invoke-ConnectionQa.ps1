param(
  [Parameter(Mandatory=$true)][string]$EvidenceDirectory,
  [switch]$ShellOnly,
  [switch]$LaunchFixture,
  [switch]$VerifyMinimized
)
$ErrorActionPreference='Stop'
if ($ShellOnly -and $VerifyMinimized) { throw 'Choose either -ShellOnly or -VerifyMinimized.' }
$project=Split-Path $PSScriptRoot -Parent
$qa=[IO.Path]::GetFullPath($EvidenceDirectory)
if (Test-Path -LiteralPath $qa) { throw 'Choose a fresh evidence directory' }
[IO.Directory]::CreateDirectory($qa) | Out-Null
$settings=@{
  DSH_VD_CONNECTION_QA=$qa
  DSH_VD_CONNECTION_QA_LAUNCH_FIXTURE=if ($LaunchFixture) { '1' } else { $null }
  DSH_VD_CONNECTION_QA_SHELL_ONLY=if ($ShellOnly) { '1' } else { $null }
  DSH_VD_CONNECTION_QA_VERIFY_MINIMIZED=if ($VerifyMinimized) { '1' } else { $null }
}
$prior=@{}
$link=$null
try {
  foreach ($name in $settings.Keys) {
    $prior[$name]=[Environment]::GetEnvironmentVariable($name)
    [Environment]::SetEnvironmentVariable($name,$settings[$name])
  }
  if (-not $ShellOnly) {
    $fixture=[IO.Directory]::CreateDirectory((Join-Path $qa 'child-fixture')).FullName
    $fixtureExe=Join-Path $fixture 'dsh-desktop-fixture.exe'
    [IO.File]::Copy((Join-Path $project 'tests/fixtures/dsh-desktop-fixture.exe'),$fixtureExe)
    if (-not $LaunchFixture) {
    $startup=[Environment]::GetFolderPath([Environment+SpecialFolder]::Startup)
    $link=Join-Path $startup ('DSH-Connection-QA-' + [guid]::NewGuid().ToString('N') + '.lnk')
    $shell=New-Object -ComObject 'WScript.Shell'
    $shortcut=$shell.CreateShortcut($link)
    $shortcut.TargetPath=$fixtureExe
    $shortcut.WorkingDirectory=$fixture
    $shortcut.Save()
    }
  }
  Push-Location -LiteralPath $project
  try {
    & node --import tsx tests/connection.windows.integration.ts
    $code=$LASTEXITCODE
  } finally { Pop-Location }
} finally {
  if ($link) { [IO.File]::Delete($link) }
  foreach ($name in $prior.Keys) { [Environment]::SetEnvironmentVariable($name,$prior[$name]) }
}
exit $code
