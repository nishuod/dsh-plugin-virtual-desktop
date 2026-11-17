param(
    [Parameter(Mandatory)][string]$EvidenceDir,
    [switch]$PowerCycle,
    [string]$Vmx,
    [string]$InstalledRoot
)

$ErrorActionPreference = 'Stop'
if ($Vmx -and -not $PowerCycle) { throw '-Vmx requires -PowerCycle' }
if ($Vmx -and $Vmx -notmatch '^[A-Za-z0-9][A-Za-z0-9 _.\-]{0,75}\.vmx$') {
    throw '-Vmx must be a fresh filename, such as "Disposable QA.vmx". The harness creates the file.'
}
$project = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$destination = [IO.Path]::GetFullPath($EvidenceDir)
if (Test-Path -LiteralPath $destination) { throw "Choose a fresh evidence directory: $destination" }
New-Item -ItemType Directory -Path $destination | Out-Null

$settings = @{
    DSH_VD_CONNECTION_QA = $destination
    DSH_VD_CONNECTION_QA_INSTALLED = $InstalledRoot
    DSH_VD_CONNECTION_QA_APPLICATION = $null
    DSH_VD_CONNECTION_QA_SHELL_ONLY = $null
    DSH_VD_CONNECTION_QA_LAUNCH_FIXTURE = $null
    DSH_VD_CONNECTION_QA_VERIFY_MINIMIZED = $null
    DSH_VD_DEFECT_QA = $null
    DSH_VD_CAPTION_QA = $null
    DSH_VD_VM_COMMAND_QA = '1'
    DSH_VD_VM_COMMAND_QA_POWER_CYCLE = if ($PowerCycle) { '1' } else { $null }
    DSH_VD_VM_COMMAND_QA_VMX = $Vmx
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
