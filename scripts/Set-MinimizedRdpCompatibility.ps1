[CmdletBinding()]
param(
    [ValidateSet('Status', 'Enable', 'Restore')]
    [string]$Mode = 'Status',

    [string]$BackupPath
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$subkey = 'Software\Microsoft\Terminal Server Client'
$valueName = 'RemoteDesktop_SuppressWhenMinimized'
$scope = "HKCU(Registry64)\$subkey\$valueName"
$dwordKind = [Microsoft.Win32.RegistryValueKind]::DWord

function Resolve-BackupPath([string]$Path) {
    if ($Path -notmatch '^[A-Za-z]:[\\/]') {
        throw 'BackupPath must be an absolute path on a local drive. UNC paths are not accepted.'
    }
    $fullPath = [IO.Path]::GetFullPath($Path)
    $drive = [IO.DriveInfo]::new([IO.Path]::GetPathRoot($fullPath))
    if ($drive.DriveType -notin @('Fixed', 'Removable', 'Ram') -or
        $fullPath.Substring(2).Contains(':') -or
        -not [IO.Path]::GetFileName($fullPath) -or [IO.Directory]::Exists($fullPath)) {
        throw 'BackupPath must identify a regular file on a local drive.'
    }
    $parent = [IO.DirectoryInfo]::new([IO.Path]::GetDirectoryName($fullPath))
    if (-not $parent.Exists) { throw 'The backup directory must already exist.' }
    for ($directory = $parent; $null -ne $directory; $directory = $directory.Parent) {
        if (($directory.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
            throw 'BackupPath must not traverse a reparse point.'
        }
    }
    if ([IO.File]::Exists($fullPath) -and
        ([IO.File]::GetAttributes($fullPath) -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw 'The backup file must not be a reparse point.'
    }
    return $fullPath
}

function Get-TargetValue {
    $key = $baseKey.OpenSubKey($subkey)
    try {
        if ($null -eq $key -or $key.GetValueNames() -notcontains $valueName) {
            return @{ exists = $false; kind = $null; dword = $null }
        }
        $kind = $key.GetValueKind($valueName)
        $number = $null
        if ($kind -eq $dwordKind) {
            $number = [BitConverter]::ToUInt32([BitConverter]::GetBytes([int]$key.GetValue($valueName)), 0)
        }
        return @{ exists = $true; kind = [string]$kind; dword = $number }
    } finally {
        if ($null -ne $key) { $key.Dispose() }
    }
}

function Test-Enabled($Value) {
    return $Value.kind -eq 'DWord' -and $Value.dword -eq 2
}

function Test-OriginalValue($Value, $Backup) {
    return $Value.exists -eq $Backup.originalExists -and
        (-not $Value.exists -or ($Value.kind -eq 'DWord' -and $Value.dword -eq $Backup.originalDword))
}

function Assert-ClientsClosed {
    $clients = @(Get-Process -Name 'ChildSessionHost', 'mstsc' -ErrorAction SilentlyContinue)
    if ($clients.Count -gt 0) { throw 'Close ChildSessionHost and mstsc before changing this setting.' }
}

function Read-Backup([string]$Path) {
    $info = [IO.FileInfo]::new($Path)
    if (-not $info.Exists -or $info.Length -lt 2 -or $info.Length -gt 4096) {
        throw 'Backup missing or invalid.'
    }
    $backup = [IO.File]::ReadAllText($Path) | ConvertFrom-Json -ErrorAction Stop
    $fields = @('version', 'scope', 'userSid', 'originalExists', 'originalDword', 'state')
    if ($backup -isnot [pscustomobject] -or @($backup.PSObject.Properties).Count -ne $fields.Count -or
        @($fields | Where-Object { $null -eq $backup.PSObject.Properties[$_] }).Count -ne 0 -or
        ($backup.version -isnot [int] -and $backup.version -isnot [long]) -or $backup.version -ne 1 -or
        $backup.scope -cne $scope -or $backup.userSid -cne $currentSid -or
        $backup.originalExists -isnot [bool] -or
        $backup.state -cnotin @('pending', 'active', 'restoring', 'restored')) {
        throw 'Backup schema, registry scope, or Windows user does not match.'
    }
    if ($backup.originalExists) {
        if (($backup.originalDword -isnot [int] -and $backup.originalDword -isnot [long]) -or
            $backup.originalDword -lt 0 -or $backup.originalDword -gt [uint32]::MaxValue) {
            throw 'Backup contains an invalid original DWORD.'
        }
    } elseif ($null -ne $backup.originalDword) {
        throw 'Backup contains an unexpected original value.'
    }
    return $backup
}

function Write-Backup([string]$Path, $Backup, [switch]$Replace) {
    $temporary = "$Path.$([guid]::NewGuid().ToString('N')).tmp"
    try {
        $json = ConvertTo-Json -InputObject $Backup -Compress
        $bytes = [Text.UTF8Encoding]::new($false).GetBytes($json)
        $file = [IO.File]::Open($temporary, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
        try {
            $file.Write($bytes, 0, $bytes.Length)
            $file.Flush($true)
        } finally { $file.Dispose() }

        if ($Replace) {
            [IO.File]::Replace($temporary, $Path, [System.Management.Automation.Language.NullString]::Value)
        } else {
            [IO.File]::Move($temporary, $Path)
        }
    } finally {
        if ([IO.File]::Exists($temporary)) {
            try { [IO.File]::Delete($temporary) } catch { }
        }
    }
}

function Set-TargetValue([bool]$Exists, [uint32]$Dword) {
    $key = if ($Exists) { $baseKey.CreateSubKey($subkey) } else { $baseKey.OpenSubKey($subkey, $true) }
    try {
        if ($Exists) {
            $signed = [BitConverter]::ToInt32([BitConverter]::GetBytes($Dword), 0)
            $key.SetValue($valueName, $signed, $dwordKind)
        } elseif ($null -ne $key) {
            $key.DeleteValue($valueName, $false)
        }
    } finally {
        if ($null -ne $key) { $key.Dispose() }
    }
}

function Write-Receipt($Current, $Backup, [bool]$Changed) {
    $backupState = $null
    if ($null -ne $Backup) { $backupState = $Backup.state }
    [ordered]@{
        mode = $Mode
        changed = $Changed
        exists = $Current.exists
        kind = $Current.kind
        dword = $Current.dword
        enabled = Test-Enabled $Current
        backupState = $backupState
    } | ConvertTo-Json -Compress
}

if (-not [Environment]::Is64BitOperatingSystem) { throw '64-bit Windows is required.' }
if ($Mode -ne 'Status' -and -not $BackupPath) { throw 'Enable and Restore require BackupPath.' }
if ($BackupPath) { $BackupPath = Resolve-BackupPath $BackupPath }
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
try { $currentSid = $identity.User.Value } finally { $identity.Dispose() }
$baseKey = [Microsoft.Win32.RegistryKey]::OpenBaseKey(
    [Microsoft.Win32.RegistryHive]::CurrentUser, [Microsoft.Win32.RegistryView]::Registry64)

$mutex = $null
$locked = $false
try {
    if ($Mode -ne 'Status') {
        $mutex = [Threading.Mutex]::new($false, "Global\DSHarness.MinimizedRdp.$currentSid")
        try { $locked = $mutex.WaitOne(0) } catch [Threading.AbandonedMutexException] { $locked = $true }
        if (-not $locked) { throw 'Another compatibility-setting operation is in progress.' }
        Assert-ClientsClosed
    }
    $current = Get-TargetValue
    $backup = if ($BackupPath -and [IO.File]::Exists($BackupPath)) { Read-Backup $BackupPath }
    if ($Mode -eq 'Status') {
        Write-Receipt $current $backup $false
        return
    }
    if ($current.exists -and $current.kind -ne 'DWord') { throw 'The existing setting is not a DWORD. It was preserved.' }

    if ($Mode -eq 'Enable') {
        if ($null -eq $backup) {
            $backup = [pscustomobject]@{
                version = 1
                scope = $scope
                userSid = $currentSid
                originalExists = $current.exists
                originalDword = $current.dword
                state = 'pending'
            }
            Write-Backup $BackupPath $backup
        }
        if ($backup.state -eq 'restored') { throw 'This backup was restored. Choose a new BackupPath to enable again.' }
        if ($backup.state -eq 'restoring') { throw 'This backup has an unfinished restore. Complete the restore first.' }
        if ($backup.state -eq 'active') {
            if (-not (Test-Enabled $current)) { throw 'The current value changed after enable. It was preserved.' }
            Write-Receipt $current $backup $false
            return
        }

        Assert-ClientsClosed
        $current = Get-TargetValue
        if (-not (Test-OriginalValue $current $backup)) {
            throw 'The setting changed after the backup was created. It was preserved.'
        }
        $changed = -not (Test-Enabled $current)
        try {
            if ($changed) { Set-TargetValue $true 2 }
            $verified = Get-TargetValue
            if (-not (Test-Enabled $verified)) { throw 'Could not verify the enabled DWORD.' }
            $backup.state = 'active'
            Write-Backup $BackupPath $backup -Replace
        } catch {
            $enableError = $_
            if ($changed -and (Test-Enabled (Get-TargetValue))) {
                try {
                    Set-TargetValue $backup.originalExists ([uint32]$backup.originalDword)
                    if (-not (Test-OriginalValue (Get-TargetValue) $backup)) { throw 'Rollback verification failed.' }
                } catch {
                    throw 'Enable failed and the original value could not be verified after rollback. Keep the backup.'
                }
            }
            throw $enableError
        }
        Write-Receipt $verified $backup $changed
        return
    }

    if ($null -eq $backup -or $backup.state -eq 'restored') { throw 'Restore requires a valid, unrestored backup.' }
    if (-not (Test-Enabled $current)) { throw 'The current setting is no longer DWORD 2. It was preserved.' }
    if ($backup.state -ne 'restoring') {
        $backup.state = 'restoring'
        Write-Backup $BackupPath $backup -Replace
    }
    Assert-ClientsClosed
    $current = Get-TargetValue
    if (-not (Test-Enabled $current)) { throw 'The current setting is no longer DWORD 2. It was preserved.' }
    $changed = -not (Test-OriginalValue $current $backup)
    if ($changed) { Set-TargetValue $backup.originalExists ([uint32]$backup.originalDword) }
    $verified = Get-TargetValue
    if (-not (Test-OriginalValue $verified $backup)) { throw 'Could not verify the restored original value.' }
    $backup.state = 'restored'
    Write-Backup $BackupPath $backup -Replace
    Write-Receipt $verified $backup $changed
} finally {
    if ($locked) { $mutex.ReleaseMutex() }
    if ($null -ne $mutex) { $mutex.Dispose() }
    $baseKey.Dispose()
}
