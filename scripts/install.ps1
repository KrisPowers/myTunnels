# Installs myTunnels on Windows, or updates it:
#
#   irm https://api.github.com/repos/KrisPowers/myTunnels/contents/scripts/install.ps1 -Headers @{ Authorization = "Bearer $(gh auth token)"; Accept = 'application/vnd.github.raw' } | iex
#
# The program, cloudflared and the panel go in %LOCALAPPDATA%\myTunnels\bin,
# which joins your PATH. Nothing needs administrator rights. The release is
# fetched signed in, with GH_TOKEN, GITHUB_TOKEN or gh's sign-in, since the
# repository is private. When the panel runs it, MYTUNNELS_PROGRESS names a
# file it writes each step to, with how much of the download is in.
& {
    $ErrorActionPreference = 'Stop'
    $ProgressPreference = 'SilentlyContinue'
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    Add-Type -AssemblyName System.Net.Http, System.IO.Compression.FileSystem

    # The step under way, and for the download how far along, for the panel.
    function Report($step, $percent) {
        if (-not $env:MYTUNNELS_PROGRESS) { return }
        $share = if ($null -eq $percent) { 'null' } else { [int]$percent }
        $line = "{`"step`":`"$step`",`"percent`":$share,`"at`":$([DateTimeOffset]::UtcNow.ToUnixTimeSeconds())}"
        try { [IO.File]::WriteAllText($env:MYTUNNELS_PROGRESS, $line) } catch { }
    }

    # Downloads $url to $zip a block at a time, reporting each percent.
    function Save($url) {
        $client = New-Object System.Net.Http.HttpClient
        $client.DefaultRequestHeaders.Add('User-Agent', 'mytunnels-install')
        $in = $null
        $out = $null
        try {
            $answer = $client.GetAsync($url, [System.Net.Http.HttpCompletionOption]::ResponseHeadersRead).GetAwaiter().GetResult()
            [void]$answer.EnsureSuccessStatusCode()
            $total = $answer.Content.Headers.ContentLength
            $in = $answer.Content.ReadAsStreamAsync().GetAwaiter().GetResult()
            $out = [IO.File]::Create($zip)
            $buffer = New-Object byte[] 262144
            $done = 0
            $shown = -1
            while (($n = $in.Read($buffer, 0, $buffer.Length)) -gt 0) {
                $out.Write($buffer, 0, $n)
                $done += $n
                if ($total) {
                    $percent = [math]::Floor($done * 100 / $total)
                    if ($percent -ne $shown) { Report 'download' $percent; $shown = $percent }
                }
            }
        }
        finally {
            if ($out) { $out.Dispose() }
            if ($in) { $in.Dispose() }
            $client.Dispose()
        }
    }

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
        Report 'download' 0
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
            $handler = New-Object System.Net.Http.HttpClientHandler
            $handler.AllowAutoRedirect = $false
            $client = New-Object System.Net.Http.HttpClient($handler)
            $ask = New-Object System.Net.Http.HttpRequestMessage([System.Net.Http.HttpMethod]::Get, $asset.url)
            $ask.Headers.Add('Authorization', "Bearer $token")
            $ask.Headers.Add('Accept', 'application/octet-stream')
            $ask.Headers.Add('User-Agent', 'mytunnels-install')
            $answer = $client.SendAsync($ask).GetAwaiter().GetResult()
            if (-not $answer.Headers.Location) { throw "GitHub would not hand out the download: $($answer.StatusCode)" }
            $client.Dispose()
            Save $answer.Headers.Location.AbsoluteUri
        }
        else {
            $tag = (Invoke-RestMethod "https://api.github.com/repos/$repo/releases/latest" -UseBasicParsing).tag_name
            Save "https://github.com/$repo/releases/latest/download/windows-x64.zip"
        }
        Report 'unpack' $null
        [IO.Compression.ZipFile]::ExtractToDirectory($zip, $new)
        # The release in place, which the panel compares with the latest to offer an update.
        Set-Content (Join-Path $new 'release') $tag -NoNewline

        # An update stops the one running, swaps the files, then starts it again.
        Report 'restart' $null
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
        # Started on its own, not through this script's output: what `start`
        # leaves running would hold that output open, and this script, its
        # log with it, would never end.
        $started = Start-Process $exe -ArgumentList 'start' -WindowStyle Hidden -PassThru
        # Held now, so its exit code is still there to read once it ends.
        $null = $started.Handle
        $started.WaitForExit()
        if ($started.ExitCode -ne 0) { throw "mytunnels start failed with code $($started.ExitCode)" }
        Write-Host 'myTunnels is running again.'
    }
    else {
        Write-Host 'myTunnels is installed. Start it, now and with this computer from then on:'
        Write-Host ''
        Write-Host '  mytunnels start'
    }
}
