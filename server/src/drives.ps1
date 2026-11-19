# Run by the "myTunnels Drives" task as SYSTEM: makes, attaches and removes
# the drives Storage's locations are, each a virtual disk of a set size kept
# on another drive and given a letter of its own, as myTunnels asks; and
# attaches every one again at boot. None of it needs the admin prompt. Put in
# place once, with the admin's yes, by `mytunnels grant`.
#
# Each ask is <job>.json in %ProgramData%\myTunnels\drives, which only the
# account myTunnels runs as may write to: make or remove a drive. Only disks
# in a top-level `drives` folder, a letter and a size are taken. How far a
# drive being made is goes to <job>.progress, then <job>.done or <job>.error.
$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$list = Join-Path $here 'list.json'
$asks = Join-Path $env:ProgramData 'myTunnels\drives'

function Read-Drives {
    if (-not (Test-Path $list)) { return @() }
    return @(Get-Content $list -Raw | ConvertFrom-Json)
}

function Save-Drives($drives) {
    [IO.File]::WriteAllText($list, (ConvertTo-Json -InputObject @($drives) -Depth 3))
}

# A disk this helper may touch: a .vhdx in a top-level `drives` folder.
function Test-Image([string]$image) {
    return $image -match '^[A-Za-z]:\\drives\\[a-z0-9_-]{1,40}\.vhdx$'
}

# Attaches a drive's disk, when it is not, and gives it its letter.
function Mount-Drive($d) {
    if (-not (Test-Path -LiteralPath $d.image)) { return }
    if (-not (Get-DiskImage -ImagePath $d.image).Attached) {
        Mount-DiskImage -ImagePath $d.image -NoDriveLetter | Out-Null
    }
    $disk = Get-DiskImage -ImagePath $d.image | Get-Disk
    $part = Get-Partition -DiskNumber $disk.Number | Where-Object Type -eq 'Basic' | Select-Object -First 1
    if ($part -and [string]$part.DriveLetter -ne $d.letter) {
        Set-Partition -DiskNumber $disk.Number -PartitionNumber $part.PartitionNumber -NewDriveLetter $d.letter
    }
}

function New-Drive($a, [string]$progress) {
    if (Test-Path -LiteralPath $a.image) { throw "$($a.image) is there already" }
    New-Item -ItemType Directory -Force (Split-Path -Parent $a.image) | Out-Null
    # Its whole size set aside now, as a drive of its own is.
    $script = Join-Path $env:TEMP "drives-$([guid]::NewGuid()).txt"
    [IO.File]::WriteAllText($script, "create vdisk file=`"$($a.image)`" maximum=$([int64]$a.size_mb) type=fixed`r`n")
    try {
        & diskpart /s $script 2>&1 | ForEach-Object {
            if ("$_" -match '(\d+) percent') { [IO.File]::WriteAllText($progress, $Matches[1]) }
        }
    }
    finally { Remove-Item -LiteralPath $script -Force -ErrorAction SilentlyContinue }
    if (-not (Test-Path -LiteralPath $a.image)) { throw 'Windows could not make the drive; is there room?' }
    Mount-DiskImage -ImagePath $a.image -NoDriveLetter | Out-Null
    $disk = Get-DiskImage -ImagePath $a.image | Get-Disk
    Initialize-Disk -Number $disk.Number -PartitionStyle GPT
    New-Partition -DiskNumber $disk.Number -UseMaximumSize -DriveLetter $a.letter |
        Format-Volume -FileSystem NTFS -NewFileSystemLabel $a.label -Confirm:$false | Out-Null
}

function Remove-Drive($a) {
    if (Test-Path -LiteralPath $a.image) {
        if ((Get-DiskImage -ImagePath $a.image).Attached) { Dismount-DiskImage -ImagePath $a.image | Out-Null }
        Remove-Item -LiteralPath $a.image -Force
    }
}

# Every drive back on its letter, as at boot.
foreach ($d in Read-Drives) {
    try { Mount-Drive $d } catch { }
}

New-Item -ItemType Directory -Force $asks | Out-Null
$watch = New-Object IO.FileSystemWatcher $asks, '*.json'
while ($true) {
    foreach ($file in Get-ChildItem $asks -Filter '*.json' -File) {
        $job = $file.BaseName
        if ($job -notmatch '^[A-Za-z0-9_-]{1,64}$') {
            Remove-Item -LiteralPath $file.FullName -Force -ErrorAction SilentlyContinue
            continue
        }
        try {
            $a = Get-Content $file.FullName -Raw | ConvertFrom-Json
            Remove-Item -LiteralPath $file.FullName -Force
            if (-not (Test-Image ([string]$a.image))) { throw "$($a.image) is not a drive myTunnels makes" }
            $drives = @(Read-Drives | Where-Object { $_.image -ne $a.image })
            if ($a.action -eq 'make') {
                if ([string]$a.letter -notmatch '^[A-Z]$' -or [int64]$a.size_mb -lt 1024 -or [string]$a.label -notmatch '^[A-Za-z0-9_-]{1,32}$') {
                    throw 'That is not a drive myTunnels makes'
                }
                New-Drive $a (Join-Path $asks "$job.progress")
                $drives += [pscustomobject]@{ image = [string]$a.image; letter = [string]$a.letter }
            }
            elseif ($a.action -eq 'remove') { Remove-Drive $a }
            else { throw "$($a.action) is not an ask" }
            Save-Drives $drives
            [IO.File]::WriteAllText((Join-Path $asks "$job.done"), 'ok')
        }
        catch {
            Remove-Item -LiteralPath $file.FullName -Force -ErrorAction SilentlyContinue
            try { [IO.File]::WriteAllText((Join-Path $asks "$job.error"), $_.Exception.Message) } catch { }
        }
    }
    # Woken by the next ask, and every few seconds in case one was missed.
    [void]$watch.WaitForChanged([IO.WatcherChangeTypes]::All, 5000)
}
