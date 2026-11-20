# Run by the "myTunnels Apps" task, as the signed-in account with its
# administrator rights: installs, updates and removes the catalog's apps with
# winget as myTunnels asks, so no installer stops for the admin prompt. Put in
# place once, with the admin's yes, by `mytunnels grant` when myTunnels is
# installed, and started by myTunnels for each ask.
#
# Each ask is <job>.json in %ProgramData%\myTunnels\apps, which only that
# account may write to: winget's arguments. Only install, upgrade and
# uninstall, from winget's own source, with the flags myTunnels passes, are
# run; anything else is refused. What winget says goes to <job>.log as it
# runs, and its exit code to <job>.exit once it ends.
$ErrorActionPreference = 'Stop'
$asks = Join-Path $env:ProgramData 'myTunnels\apps'
$flags = '--exact', '--silent', '--disable-interactivity', '--accept-package-agreements', '--accept-source-agreements', '--force'
$valued = '--id', '--version', '--source'

function Test-Ask($words) {
    if ($words.Count -lt 2 -or $words[0] -notin 'install', 'upgrade', 'uninstall') { return $false }
    for ($i = 1; $i -lt $words.Count; $i++) {
        $w = [string]$words[$i]
        if ($w -in $flags) { continue }
        if ($w -notin $valued -or $i + 1 -ge $words.Count) { return $false }
        $value = [string]$words[++$i]
        if ($value -notmatch '^[A-Za-z0-9][A-Za-z0-9._+~:-]{0,127}$') { return $false }
        if ($w -eq '--source' -and $value -ne 'winget') { return $false }
    }
    return $true
}

$winget = Join-Path $env:LOCALAPPDATA 'Microsoft\WindowsApps\winget.exe'
foreach ($file in Get-ChildItem $asks -Filter '*.json' -File) {
    $job = $file.BaseName
    if ($job -notmatch '^[A-Za-z0-9_-]{1,64}$') {
        Remove-Item -LiteralPath $file.FullName -Force -ErrorAction SilentlyContinue
        continue
    }
    $log = Join-Path $asks "$job.log"
    $code = 1
    try {
        # Windows PowerShell hands a JSON array on as one item, so it is held
        # first and spread after; read straight into @() every ask is one word.
        $parsed = Get-Content $file.FullName -Raw | ConvertFrom-Json
        $words = @($parsed)
        Remove-Item -LiteralPath $file.FullName -Force
        if (-not (Test-Ask $words)) { throw 'That is not an ask myTunnels makes' }
        # A line at a time as winget says it, in UTF-8, for the panel to follow.
        & $winget @words 2>&1 | ForEach-Object { [IO.File]::AppendAllText($log, "$_`n") }
        $code = $LASTEXITCODE
    }
    catch {
        try { [IO.File]::AppendAllText($log, "$($_.Exception.Message)`n") } catch { }
        Remove-Item -LiteralPath $file.FullName -Force -ErrorAction SilentlyContinue
    }
    [IO.File]::WriteAllText((Join-Path $asks "$job.exit"), [string]$code)
}
