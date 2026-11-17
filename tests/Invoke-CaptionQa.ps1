param(
    [Parameter(Mandatory)][ValidateSet(1359, 1920)][int]$Width,
    [Parameter(Mandatory)][string]$EvidenceDir,
    [string]$InstalledRoot,
    [switch]$RequireReceipt
)

$ErrorActionPreference = 'Stop'
$project = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$destination = [IO.Path]::GetFullPath($EvidenceDir)
if (Test-Path -LiteralPath $destination) { throw "Choose a fresh evidence directory: $destination" }
$fixtureDir = Join-Path $destination 'child-fixture'
New-Item -ItemType Directory -Path $fixtureDir | Out-Null
$exe = Join-Path $fixtureDir 'dsh-desktop-fixture.exe'
$compiler = Join-Path $env:SystemRoot 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
$define = if ($Width -eq 1920) { 'CAPTION,WIDE' } else { 'CAPTION' }
$source = Join-Path $PSScriptRoot 'fixtures\DesktopFixture.cs'
$manifest = Join-Path $PSScriptRoot 'fixtures\fixture.manifest'
& $compiler /nologo /target:winexe /platform:x64 "/define:$define" "/win32manifest:$manifest" "/out:$exe" /r:System.Windows.Forms.dll /r:System.Drawing.dll $source
if ($LASTEXITCODE -ne 0) { throw "Fixture compilation failed: $LASTEXITCODE" }

$settings = @{
    DSH_VD_CONNECTION_QA = $destination
    DSH_VD_CONNECTION_QA_LAUNCH_FIXTURE = '1'
    DSH_VD_CONNECTION_QA_INSTALLED = $InstalledRoot
    DSH_VD_CONNECTION_QA_APPLICATION = $null
    DSH_VD_CONNECTION_QA_SHELL_ONLY = $null
    DSH_VD_CONNECTION_QA_VERIFY_MINIMIZED = $null
    DSH_VD_DEFECT_QA = $null
    DSH_VD_CAPTION_QA = [string]$Width
    DSH_VD_CAPTION_RECEIPT_QA = if ($RequireReceipt) { '1' } else { '' }
}
$prior = @{}
foreach ($name in $settings.Keys) {
    $prior[$name] = [Environment]::GetEnvironmentVariable($name, 'Process')
    [Environment]::SetEnvironmentVariable($name, $settings[$name], 'Process')
}
Push-Location $project
try {
    & node --import tsx tests/connection.windows.integration.ts 2>&1 | Tee-Object (Join-Path $destination 'run.log')
    $code = $LASTEXITCODE
} finally {
    Pop-Location
    foreach ($name in $settings.Keys) {
        [Environment]::SetEnvironmentVariable($name, $prior[$name], 'Process')
    }
}
exit $code
