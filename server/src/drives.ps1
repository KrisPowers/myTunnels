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
# itself from myTunnels' repository, so updates reach it with no prompt. An
# apps ask does the same for the apps helper, which runs as the signed-in
# account and cannot replace itself.
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

# The 512 bytes that make a dynamic VHD a disk Windows attaches; the file
# starts and ends with them.
function New-Footer([int64]$size) {
    [byte[]]$f = New-Object byte[] 512
    $epoch = [DateTime]::new(2000, 1, 1, 0, 0, 0, [DateTimeKind]::Utc)
    Set-Bytes $f 0 ([Text.Encoding]::ASCII.GetBytes('conectix'))
    Set-Bytes $f 8 (Get-Big 2 4)
    Set-Bytes $f 12 (Get-Big 65536 4)
    # Where the dynamic header is: right after the first copy of this footer.
    Set-Bytes $f 16 (Get-Big 512 8)
    Set-Bytes $f 24 (Get-Big ([uint64]([DateTime]::UtcNow - $epoch).TotalSeconds) 4)
    Set-Bytes $f 28 ([Text.Encoding]::ASCII.GetBytes('mytn'))
    Set-Bytes $f 32 (Get-Big 65536 4)
    Set-Bytes $f 36 ([Text.Encoding]::ASCII.GetBytes('Wi2k'))
    Set-Bytes $f 40 (Get-Big $size 8)
    Set-Bytes $f 48 (Get-Big $size 8)
    Set-Bytes $f 56 (Get-Geometry $size)
    # 3: dynamic, which takes room on the drive it is kept on only as it fills.
    Set-Bytes $f 60 (Get-Big 3 4)
    Set-Bytes $f 68 ([guid]::NewGuid().ToByteArray())
    $sum = [int64]0
    foreach ($b in $f) { $sum += $b }
    Set-Bytes $f 64 (Get-Big ([uint64](4294967295 - ($sum % 4294967296))) 4)
    return , $f
}

# A dynamic VHD's blocks, 2 MB each, which take room only once written to.
$block = 2MB

# The 1024-byte header after a dynamic VHD's first footer: where its block
# table is, which comes right after it, and how many blocks the disk has.
function New-Header([int64]$size) {
    [byte[]]$h = New-Object byte[] 1024
    Set-Bytes $h 0 ([Text.Encoding]::ASCII.GetBytes('cxsparse'))
    Set-Bytes $h 8 (Get-Big ([uint64]::MaxValue) 8)
    Set-Bytes $h 16 (Get-Big 1536 8)
    Set-Bytes $h 24 (Get-Big 65536 4)
    Set-Bytes $h 28 (Get-Big ([uint64][math]::Ceiling($size / $block)) 4)
    Set-Bytes $h 32 (Get-Big $block 4)
    $sum = [int64]0
    foreach ($b in $h) { $sum += $b }
    Set-Bytes $h 36 (Get-Big ([uint64](4294967295 - ($sum % 4294967296))) 4)
    return , $h
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

# This release's copy of the apps helper, from myTunnels' repository alone, in
# place of the one an older release put there.
function Update-AppsHelper([string]$tag) {
    if ($tag -notmatch '^v\d{1,4}\.\d{1,5}\.\d{1,6}$') { throw "$tag is not a release" }
    $placed = Join-Path $env:ProgramFiles 'myTunnels\apps\apps.ps1'
    if (-not (Test-Path -LiteralPath $placed)) { throw 'The apps helper is not set up' }
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    $new = [string](Invoke-WebRequest -UseBasicParsing "https://raw.githubusercontent.com/KrisPowers/myTunnels/$tag/server/src/apps.ps1").Content
    if (-not $new.StartsWith('# Run by the "myTunnels Apps" task')) { throw 'That is not the apps helper' }
    $null = [scriptblock]::Create($new)
    [IO.File]::WriteAllText($placed, $new)
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
    # Only SYSTEM and administrators may read or change the disks.
    & icacls $dir /inheritance:r /grant:r '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' | Out-Null
    # A dynamic VHD: a footer, its header, a table with no block written yet,
    # and the footer again. A few hundred KB whatever its size, so it is made
    # at once on any drive; it takes room as files go on it.
    $size = [int64]$a.size_mb * 1MB
    try {
        $footer = New-Footer $size
        $entries = [int64][math]::Ceiling($size / $block)
        $table = [int64][math]::Ceiling($entries * 4 / 512) * 512
        [byte[]]$unused = , 255 * 65536
        $s = [IO.File]::Open($a.image, 'CreateNew', 'ReadWrite', 'None')
        try {
            $s.Write($footer, 0, 512)
            $s.Write((New-Header $size), 0, 1024)
            for ($left = $table; $left -gt 0; $left -= $unused.Length) {
                $s.Write($unused, 0, [int][math]::Min($left, $unused.Length))
            }
            $s.Write($footer, 0, 512)
        }
        finally { $s.Dispose() }
    }
    catch {
        Remove-Item -LiteralPath $a.image -Force -ErrorAction SilentlyContinue
        throw "Windows could not make the disk: $($_.Exception.Message)"
    }
    [IO.File]::WriteAllText($progress, '50')
    $disk = Mount-DiskImage -ImagePath $a.image -NoDriveLetter -PassThru | Get-Disk
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

# Windows' storage provider takes seconds to answer its first call; it is
# asked once now, so the first drive asked for is made at once.
try { $null = Get-Disk } catch { }

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
            if ($a.action -eq 'apps') {
                Update-AppsHelper ([string]$a.tag)
                [IO.File]::WriteAllText((Join-Path $asks "$job.done"), 'ok')
                continue
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
