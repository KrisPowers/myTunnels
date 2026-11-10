# Installs myTunnels on Windows, or updates it:
#
#   irm https://api.github.com/repos/KrisPowers/myTunnels/contents/scripts/install.ps1 -Headers @{ Authorization = "Bearer $(gh auth token)"; Accept = 'application/vnd.github.raw' } | iex
#
# The program, cloudflared and the panel go in %LOCALAPPDATA%\myTunnels\bin,
# which joins your PATH. Nothing needs administrator rights. The release is
# fetched signed in, with GH_TOKEN, GITHUB_TOKEN or gh's sign-in, since the
# repository is private.
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
        $token = if ($env:GH_TOKEN) { $env:GH_TOKEN } elseif ($env:GITHUB_TOKEN) { $env:GITHUB_TOKEN }
        if (-not $token -and (Get-Command gh -ErrorAction SilentlyContinue)) {
            try { $token = gh auth token 2>$null } catch { }
        }
        if ($token) {
            # The latest release's archive, by its API address, which takes the token.
            $release = Invoke-RestMethod "https://api.github.com/repos/$repo/releases/latest" -Headers @{ Authorization = "Bearer $token" } -UseBasicParsing
            $tag = $release.tag_name
            $asset = $release.assets | Where-Object name -eq 'windows-x64.zip'
            if (-not $asset) { throw 'The latest release has no build for windows-x64' }
            # GitHub answers with its file storage's address, which refuses the
            # token, so the redirect is followed by hand, without it.
            Add-Type -AssemblyName System.Net.Http
            $handler = New-Object System.Net.Http.HttpClientHandler
            $handler.AllowAutoRedirect = $false
            $client = New-Object System.Net.Http.HttpClient($handler)
            $ask = New-Object System.Net.Http.HttpRequestMessage([System.Net.Http.HttpMethod]::Get, $asset.url)
            $ask.Headers.Add('Authorization', "Bearer $token")
            $ask.Headers.Add('Accept', 'application/octet-stream')
            $ask.Headers.Add('User-Agent', 'mytunnels-install')
            $answer = $client.SendAsync($ask).GetAwaiter().GetResult()
            if (-not $answer.Headers.Location) { throw "GitHub would not hand out the download: $($answer.StatusCode)" }
            Invoke-WebRequest $answer.Headers.Location.AbsoluteUri -OutFile $zip -UseBasicParsing
            $client.Dispose()
        }
        else {
            $tag = (Invoke-RestMethod "https://api.github.com/repos/$repo/releases/latest" -UseBasicParsing).tag_name
            Invoke-WebRequest "https://github.com/$repo/releases/latest/download/windows-x64.zip" -OutFile $zip -UseBasicParsing
        }
        Expand-Archive $zip $new
        # The release in place, which the panel compares with the latest to offer an update.
        Set-Content (Join-Path $new 'release') $tag -NoNewline

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
    # Terminals already open, and those opened from an editor or Windows
    # Terminal started before now, keep the PATH they began with. WindowsApps
    # is on every account's PATH from sign-in, so a launcher there answers to
    # `mytunnels` in all of them.
    $apps = Join-Path $env:LOCALAPPDATA 'Microsoft\WindowsApps'
    if (Test-Path $apps) {
        Set-Content (Join-Path $apps 'mytunnels.cmd') "@`"$exe`" %*" -Encoding ascii
    }

    if ($running) {
        & $exe start
    }
    else {
        Write-Host 'myTunnels is installed. Start it, now and with this computer from then on:'
        Write-Host ''
        Write-Host '  mytunnels start'
    }
}
