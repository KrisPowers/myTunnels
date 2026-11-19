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
# A refresh ask names a release, and this helper takes that release's copy of
# itself from myTunnels' repository, so updates reach it with no prompt.
$ErrorActionPreference = 'Stop'
$self = $MyInvocation.MyCommand.Path
$here = Split-Path -Parent $self
$list = Join-Path $here 'list.json'
$asks = Join-Path $env:ProgramData 'myTunnels\drives'

function Read-Drives {
    if (-not (Test-Path $list)) { return @() }
    return @(Get-Content $list -Raw | ConvertFrom-Json)
}

function Save-Drives($drives) {
    [IO.File]::WriteAllText($list, (ConvertTo-Json -InputObject @($drives) -Depth 3))
}

# A disk this helper may touch: a .vhd, or an older .vhdx, in a top-level
# `drives` folder.
function Test-Image([string]$image) {
    return $image -match '^[A-Za-z]:\\drives\\[a-z0-9_-]{1,40}\.vhdx?$'
}

function Set-Bytes([byte[]]$to, [int]$at, [byte[]]$bytes) {
    [Array]::Copy($bytes, 0, $to, $at, $bytes.Length)
}

# The last `$n` bytes of `$v`, most significant first, as a VHD footer holds them.
function Get-Big([uint64]$v, [int]$n) {
    [byte[]]$b = [BitConverter]::GetBytes($v)[0..($n - 1)]
    [Array]::Reverse($b)
    return , $b
}

# Cylinders, heads and sectors per track for a disk of `$size` bytes, by the
# VHD format's own reckoning.
function Get-Geometry([int64]$size) {
    $total = [math]::Min([int64]($size / 512), [int64]65535 * 16 * 255)
    if ($total -ge [int64]65535 * 16 * 63) {
        $spt = 255; $heads = 16; $cth = [math]::Floor($total / $spt)
    }
    else {
        $spt = 17; $cth = [math]::Floor($total / $spt)
        $heads = [math]::Max(4, [math]::Floor(($cth + 1023) / 1024))
        if ($cth -ge $heads * 1024 -or $heads -gt 16) { $spt = 31; $heads = 16; $cth = [math]::Floor($total / $spt) }
        if ($cth -ge $heads * 1024) { $spt = 63; $heads = 16; $cth = [math]::Floor($total / $spt) }
    }
    $cyl = [int]([math]::Floor($cth / $heads))
    return , ([byte[]]@((($cyl -shr 8) -band 255), ($cyl -band 255), [int]$heads, [int]$spt))
}

# The 512 bytes after a fixed VHD's data, which make it a disk Windows attaches.
function New-Footer([int64]$size) {
    [byte[]]$f = New-Object byte[] 512
    $epoch = [DateTime]::new(2000, 1, 1, 0, 0, 0, [DateTimeKind]::Utc)
    Set-Bytes $f 0 ([Text.Encoding]::ASCII.GetBytes('conectix'))
    Set-Bytes $f 8 (Get-Big 2 4)
    Set-Bytes $f 12 (Get-Big 65536 4)
    Set-Bytes $f 16 (Get-Big ([uint64]::MaxValue) 8)
    Set-Bytes $f 24 (Get-Big ([uint64]([DateTime]::UtcNow - $epoch).TotalSeconds) 4)
    Set-Bytes $f 28 ([Text.Encoding]::ASCII.GetBytes('mytn'))
    Set-Bytes $f 32 (Get-Big 65536 4)
    Set-Bytes $f 36 ([Text.Encoding]::ASCII.GetBytes('Wi2k'))
    Set-Bytes $f 40 (Get-Big $size 8)
    Set-Bytes $f 48 (Get-Big $size 8)
    Set-Bytes $f 56 (Get-Geometry $size)
    Set-Bytes $f 60 (Get-Big 2 4)
    Set-Bytes $f 68 ([guid]::NewGuid().ToByteArray())
    $sum = [int64]0
    foreach ($b in $f) { $sum += $b }
    Set-Bytes $f 64 (Get-Big ([uint64](4294967295 - ($sum % 4294967296))) 4)
    return , $f
}

# This release's copy of this helper, from myTunnels' repository alone, so
# what the account myTunnels runs as asks cannot change what runs as SYSTEM.
function Update-Helper([string]$tag) {
    if ($tag -notmatch '^v\d{1,4}\.\d{1,5}\.\d{1,6}$') { throw "$tag is not a release" }
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    $new = [string](Invoke-WebRequest -UseBasicParsing "https://raw.githubusercontent.com/KrisPowers/myTunnels/$tag/server/src/drives.ps1").Content
    if (-not $new.StartsWith('# Run by the "myTunnels Drives" task')) { throw 'That is not the drives helper' }
    $null = [scriptblock]::Create($new)
    [IO.File]::WriteAllText($self, $new)
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
    $dir = Split-Path -Parent $a.image
    New-Item -ItemType Directory -Force $dir | Out-Null
    # Only SYSTEM and administrators may read or change the disks: the room
    # they take is not written over first.
    & icacls $dir /inheritance:r /grant:r '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' | Out-Null
    # Its whole size set aside at once, as a drive of its own is, with no time
    # spent writing zeros over it: a fixed VHD is the disk's bytes, then a footer.
    $size = [int64]$a.size_mb * 1MB
    try {
        $s = [IO.File]::Open($a.image, 'CreateNew', 'ReadWrite', 'None')
        try { $s.SetLength($size + 512) } finally { $s.Dispose() }
        & fsutil file setvaliddata $a.image ($size + 512) | Out-Null
        $s = [IO.File]::Open($a.image, 'Open', 'ReadWrite', 'None')
        try {
            # Its first and last MB cleared, so no old disk's table is found there.
            $zero = New-Object byte[] 1MB
            $s.Write($zero, 0, $zero.Length)
            $s.Seek($size - 1MB, 'Begin') | Out-Null
            $s.Write($zero, 0, $zero.Length)
            $s.Write((New-Footer $size), 0, 512)
        }
        finally { $s.Dispose() }
    }
    catch {
        Remove-Item -LiteralPath $a.image -Force -ErrorAction SilentlyContinue
        throw "Windows could not set the room aside: $($_.Exception.Message)"
    }
    [IO.File]::WriteAllText($progress, '50')
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
            if ($a.action -eq 'refresh') {
                Update-Helper ([string]$a.tag)
                [IO.File]::WriteAllText((Join-Path $asks "$job.done"), 'ok')
                # The new copy carries on in this process; this one ends with it.
                $watch.Dispose()
                & $self
                exit
            }
            if (-not (Test-Image ([string]$a.image))) { throw "$($a.image) is not a drive myTunnels makes" }
            $drives = @(Read-Drives | Where-Object { $_.image -ne $a.image })
            if ($a.action -eq 'make') {
                if ([string]$a.letter -notmatch '^[A-Z]$' -or [int64]$a.size_mb -lt 1024 -or [int64]$a.size_mb -gt 2088960 -or [string]$a.label -notmatch '^[A-Za-z0-9_-]{1,32}$') {
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
