# Installs myTunnels on Windows, or updates it:
#
#   irm https://raw.githubusercontent.com/KrisPowers/myTunnels/main/scripts/install.ps1 | iex
#
# The program, cloudflared and the panel go in %LOCALAPPDATA%\myTunnels\bin,
# which joins your PATH. Nothing needs administrator rights.
& {
    $ErrorActionPreference = 'Stop'
    $ProgressPreference = 'SilentlyContinue'
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

    $repo = 'KrisPowers/myTunnels'
    $root = Join-Path $env:LOCALAPPDATA 'myTunnels'
    $bin = Join-Path $root 'bin'
    $exe = Join-Path $bin 'mytunnels.exe'
    $zip = Join-Path ([IO.Path]::GetTempPath()) "$([guid]::NewGuid()).zip"
    $new = Join-Path $root ".new-$([guid]::NewGuid())"

    New-Item -ItemType Directory -Force $root | Out-Null
    try {
        # Windows on Arm runs the x64 build.
        Write-Host 'Downloading myTunnels for windows-x64'
        Invoke-WebRequest "https://github.com/$repo/releases/latest/download/windows-x64.zip" -OutFile $zip -UseBasicParsing
        Expand-Archive $zip $new

        # An update stops the one running, swaps the files, then starts it again.
        $running = $false
        if (Test-Path $exe) {
            & $exe status *> $null
            $running = $LASTEXITCODE -eq 0
            & $exe stop *> $null
        }
        # Files of a program just stopped can stay locked for a moment.
        for ($try = 0; Test-Path $bin; $try++) {
            try { Remove-Item $bin -Recurse -Force }
            catch { if ($try -ge 20) { throw }; Start-Sleep -Milliseconds 500 }
        }
        Move-Item $new $bin
    }
    finally {
        Remove-Item $zip, $new -Recurse -Force -ErrorAction SilentlyContinue
    }

    $path = [Environment]::GetEnvironmentVariable('Path', 'User')
    if (($path -split ';') -notcontains $bin) {
        [Environment]::SetEnvironmentVariable('Path', (@($bin) + ($path -split ';' | Where-Object { $_ })) -join ';', 'User')
    }
    if (($env:Path -split ';') -notcontains $bin) { $env:Path = "$bin;$env:Path" }

    if ($running) {
        & $exe start
    }
    else {
        Write-Host 'myTunnels is installed. Start it, now and with this computer from then on:'
        Write-Host ''
        Write-Host '  mytunnels start'
    }
}
