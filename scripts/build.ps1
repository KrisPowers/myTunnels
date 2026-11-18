#Requires -Version 7.4
# Builds myTunnels for every system this computer can build for, into builds/:
#
#   pwsh scripts/build.ps1             build
#   pwsh scripts/build.ps1 -Publish    build, release it, and point the Homebrew formula at it
#
# Windows builds windows-x64, a Mac both macOS builds, and either builds
# linux-x64 and linux-arm64 through zig when zig is installed. Through zig,
# Windows and Linux build both macOS archives too, against Apple's SDK, which
# is fetched once into builds/.sdk. Each archive holds mytunnels, cloudflared
# and the panel, as the install scripts expect, and Windows' the desktop app.
# Windows also gets setup.exe, which carries its archive inside it and
# installs with no internet or GitHub sign-in, such as from a USB drive.
#
# -Publish makes the next release (or adds to the one -Version names, as a
# Mac does after Windows) and opens and merges the formula's update.
param(
    [switch]$Publish,
    [string]$Version
)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$repo = 'KrisPowers/myTunnels'
$root = Split-Path $PSScriptRoot
$out = Join-Path $root 'builds'
$server = Join-Path $root 'server'

Add-Type -AssemblyName System.Formats.Tar

# Runs a program with its arguments, stopping the build when it fails.
function Step {
    $rest = @($args | Select-Object -Skip 1 | ForEach-Object { $_ })
    & $args[0] @rest
    if ($LASTEXITCODE -ne 0) { throw "$($args -join ' ') failed" }
}

$all = @(
    @{ Name = 'windows-x64'; Target = 'x86_64-pc-windows-msvc'; Cloudflared = 'cloudflared-windows-amd64.exe' }
    @{ Name = 'macos-arm64'; Target = 'aarch64-apple-darwin'; Cloudflared = 'cloudflared-darwin-arm64.tgz' }
    @{ Name = 'macos-x64'; Target = 'x86_64-apple-darwin'; Cloudflared = 'cloudflared-darwin-amd64.tgz' }
    @{ Name = 'linux-x64'; Target = 'x86_64-unknown-linux-musl'; Cloudflared = 'cloudflared-linux-amd64' }
    @{ Name = 'linux-arm64'; Target = 'aarch64-unknown-linux-musl'; Cloudflared = 'cloudflared-linux-arm64' }
)
$zig = [bool](Get-Command zig -ErrorAction SilentlyContinue)
$builds = $all | Where-Object {
    ($IsWindows -and $_.Name -like 'windows-*') -or (($IsMacOS -or $zig) -and $_.Name -like 'macos-*') -or ($zig -and $_.Name -like 'linux-*')
}
if (-not $zig) { Write-Host 'zig is not installed, so the Linux builds are left out' }
if (-not $builds) { throw 'Nothing here can be built for' }

Write-Host 'Building the panel'
Push-Location (Join-Path $root 'ui')
try {
    Step npm install --no-audit --no-fund
    Step npm run build
}
finally { Pop-Location }

# Built through zig: Linux anywhere, macOS anywhere but a Mac.
function Zigged($b) { $b.Name -like 'linux-*' -or ($b.Name -like 'macos-*' -and -not $IsMacOS) }
if ($builds | Where-Object { Zigged $_ }) {
    if (-not (Get-Command cargo-zigbuild -ErrorAction SilentlyContinue)) { Step cargo install --locked cargo-zigbuild }
}

# Apple's SDK, which zig links macOS builds against, pinned by its checksum.
$sdk = $null
if (-not $IsMacOS -and ($builds | Where-Object Name -like 'macos-*')) {
    $sdkName = 'MacOSX15.5.sdk'
    $sdkHash = 'c15cf0f3f17d714d1aa5a642da8e118db53d79429eb015771ba816aa7c6c1cbd'
    $cache = Join-Path $out '.sdk'
    $sdk = Join-Path $cache $sdkName
    if (-not (Test-Path (Join-Path $sdk 'SDKSettings.json'))) {
        Write-Host "Fetching $sdkName"
        New-Item -ItemType Directory -Force $cache | Out-Null
        $xz = Join-Path $cache "$sdkName.tar.xz"
        Invoke-WebRequest "https://github.com/joseluisq/macosx-sdks/releases/download/15.5/$sdkName.tar.xz" -OutFile $xz
        if ((Get-FileHash $xz -Algorithm SHA256).Hash.ToLower() -ne $sdkHash) { throw "$sdkName does not match its checksum" }
        Step tar -xf $xz -C $cache
        Remove-Item $xz
    }
}

# The release being made, known before building so setup.exe can carry its
# name. A build that is not published names none.
$tag = $null
if ($Publish) {
    if (-not $Version) {
        $latest = gh release list --repo $repo --limit 1 --json tagName -q '.[0].tagName'
        $Version = if ($latest) {
            $parts = $latest.TrimStart('v').Split('.')
            $parts[-1] = [int]$parts[-1] + 1
            $parts -join '.'
        }
        else { '0.1.0' }
    }
    $tag = "v$Version"
}

New-Item -ItemType Directory -Force $out | Out-Null
$made = @()
foreach ($b in $builds) {
    Write-Host "Building $($b.Name)"
    Step rustup target add $b.Target
    $build = if (Zigged $b) { 'zigbuild' } else { 'build' }
    $env:SDKROOT = if ($b.Name -like 'macos-*') { $sdk } else { $null }
    Push-Location $server
    try { Step cargo $build --release --locked --target $b.Target }
    finally { Pop-Location; $env:SDKROOT = $null }
    # The desktop app, a window onto the panel, is Windows' alone for now.
    if ($b.Name -like 'windows-*') {
        Push-Location (Join-Path $root 'desktop')
        try { Step cargo build --release --locked --target $b.Target --bin desktop }
        finally { Pop-Location }
    }

    $exe = if ($b.Name -like 'windows-*') { '.exe' } else { '' }
    $stage = Join-Path $out ".stage-$($b.Name)"
    Remove-Item $stage -Recurse -Force -ErrorAction SilentlyContinue
    New-Item -ItemType Directory $stage | Out-Null
    Copy-Item (Join-Path $server "target/$($b.Target)/release/server$exe") (Join-Path $stage "mytunnels$exe")
    Copy-Item (Join-Path $root 'ui/dist') (Join-Path $stage 'ui') -Recurse
    if ($exe) {
        Copy-Item (Join-Path $root "desktop/target/$($b.Target)/release/desktop.exe") $stage
        # What the hardware sensors' setup downloads, brought along so it runs
        # with no internet, pinned as hardware.rs pins them.
        $pinned = Get-Content (Join-Path $server 'src/hardware.rs') -Raw
        New-Item -ItemType Directory (Join-Path $stage 'hardware') | Out-Null
        foreach ($m in [regex]::Matches($pinned, 'const (?:PAWNIO|LHM): \(&str, &str\) = \(\s*"([^"]+)",\s*"([0-9a-f]{64})"')) {
            $url = $m.Groups[1].Value
            $file = Join-Path $stage "hardware/$($url.Split('/')[-1])"
            Invoke-WebRequest $url -OutFile $file
            if ((Get-FileHash $file -Algorithm SHA256).Hash.ToLower() -ne $m.Groups[2].Value) { throw "$url does not match its checksum" }
        }
    }
    $url = "https://github.com/cloudflare/cloudflared/releases/latest/download/$($b.Cloudflared)"
    if ($b.Cloudflared -like '*.tgz') {
        $tgz = Join-Path $stage 'cloudflared.tgz'
        Invoke-WebRequest $url -OutFile $tgz
        Step tar -xzf $tgz -C $stage
        Remove-Item $tgz
    }
    else {
        Invoke-WebRequest $url -OutFile (Join-Path $stage "cloudflared$exe")
    }

    if ($exe) {
        $archive = Join-Path $out "$($b.Name).zip"
        Remove-Item $archive -ErrorAction SilentlyContinue
        Compress-Archive (Join-Path $stage '*') $archive
    }
    else {
        # Written here rather than by tar, so the programs are executable even
        # when packed on Windows, which keeps no such mark.
        $archive = Join-Path $out "$($b.Name).tar.gz"
        $file = [IO.File]::Create($archive)
        $gz = [IO.Compression.GZipStream]::new($file, [IO.Compression.CompressionLevel]::Optimal)
        $tar = [Formats.Tar.TarWriter]::new($gz, [Formats.Tar.TarEntryFormat]::Pax, $false)
        try {
            foreach ($f in Get-ChildItem $stage -Recurse -File) {
                $path = [IO.Path]::GetRelativePath($stage, $f.FullName).Replace('\', '/')
                $entry = [Formats.Tar.PaxTarEntry]::new([Formats.Tar.TarEntryType]::RegularFile, $path)
                # rwxr-xr-x for the programs, rw-r--r-- for the rest.
                $entry.Mode = if ($path -in 'mytunnels', 'cloudflared') { [IO.UnixFileMode]493 } else { [IO.UnixFileMode]420 }
                $entry.DataStream = [IO.File]::OpenRead($f.FullName)
                try { $tar.WriteEntry($entry) }
                finally { $entry.DataStream.Dispose() }
            }
        }
        finally { $tar.Dispose(); $gz.Dispose(); $file.Dispose() }
    }
    Remove-Item $stage -Recurse -Force
    $made += [pscustomobject]@{ Name = $b.Name; File = $archive; Sha256 = (Get-FileHash $archive -Algorithm SHA256).Hash.ToLower() }

    # setup.exe: the same build inside an installer that needs no internet
    # or GitHub sign-in, to carry on a USB drive, and asks at install for
    # what needs administrator rights.
    if ($exe) {
        $env:SETUP_PAYLOAD = $archive
        $env:SETUP_RELEASE = $tag
        Push-Location (Join-Path $root 'desktop')
        try { Step cargo build --release --locked --target $b.Target --bin setup }
        finally { Pop-Location; $env:SETUP_PAYLOAD = $null; $env:SETUP_RELEASE = $null }
        $setup = Join-Path $out 'setup.exe'
        Copy-Item (Join-Path $root "desktop/target/$($b.Target)/release/setup.exe") $setup -Force
        $made += [pscustomobject]@{ Name = 'windows-setup'; File = $setup; Sha256 = (Get-FileHash $setup -Algorithm SHA256).Hash.ToLower() }
    }
}
$made | Format-Table Name, Sha256 -AutoSize | Out-Host

if (-not $Publish) { return }

$tag = "v$Version"
gh release view $tag --repo $repo *> $null
if ($LASTEXITCODE -eq 0) {
    Write-Host "Adding to release $Version"
    Step gh release upload $tag @($made.File) --repo $repo --clobber
}
else {
    Write-Host "Releasing $Version"
    Step gh release create $tag @($made.File) --repo $repo --title $Version --notes "Built with scripts/build.ps1."
}

# The formula's url lines name the release and archive; the sha256 line under
# each is its checksum. Archives not built here keep the release they had.
$brewed = $made | Where-Object Name -notlike 'windows-*'
if (-not $brewed) { return }
$formula = Join-Path $root 'Formula/mytunnels.rb'
$lines = Get-Content $formula
for ($i = 0; $i -lt $lines.Count; $i++) {
    $lines[$i] = $lines[$i] -replace '^  version "[^"]*"', "  version `"$Version`""
    foreach ($m in $brewed) {
        if ($lines[$i] -match "/$($m.Name)\.tar\.gz`"") {
            $lines[$i] = $lines[$i] -replace '/download/v[^/]+/', "/download/$tag/"
            $lines[$i + 1] = $lines[$i + 1] -replace 'sha256 "[^"]*"', "sha256 `"$($m.Sha256)`""
        }
    }
}
Set-Content $formula $lines

Push-Location $root
try {
    $branch = "chore/formula-$tag"
    Step git add Formula/mytunnels.rb
    Step git commit -m "chore(brew): point the formula at $Version"
    Step git push origin "HEAD:refs/heads/$branch"
    Step gh pr create --repo $repo --head $branch --base main --title "chore(brew): point the formula at $Version" --body "## Summary`n- The Homebrew formula installs release $Version.`n`n## Test plan`n- [ ] ``brew upgrade mytunnels`` installs $Version."
    Step gh pr merge $branch --repo $repo --merge
    Step git pull
}
finally { Pop-Location }
