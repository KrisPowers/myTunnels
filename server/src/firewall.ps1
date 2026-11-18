# Run by the "myTunnels Firewall" task as SYSTEM: opens and closes the
# firewall rules myTunnels' router ports need, as myTunnels asks, so it never
# needs the admin prompt for them. Put in place once, with the admin's yes, by
# `mytunnels grant` when myTunnels is installed.
#
# Each ask is <forward id>.json in %ProgramData%\myTunnels\firewall, which
# only the account myTunnels runs as may write to: whether to open or close,
# and the rules, each named myTunnels-<forward id>-<tcp|udp>. Nothing else is
# touched. An ask is taken away once done; one that fails leaves its reason
# in <forward id>.error.
$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
# A relay is myTunnels listening, so its rules name the program as well.
$program = (Get-Content (Join-Path $here 'program.txt') -Raw).Trim()
$asks = Join-Path $env:ProgramData 'myTunnels\firewall'
$watch = New-Object IO.FileSystemWatcher $asks, '*.json'

while ($true) {
    foreach ($file in Get-ChildItem $asks -Filter '*.json' -File) {
        $id = $file.BaseName
        try {
            if ($id -notmatch '^[A-Za-z0-9_-]{1,64}$') { throw "$($file.Name) is not an ask" }
            $ask = Get-Content $file.FullName -Raw | ConvertFrom-Json
            foreach ($rule in @($ask.rules)) {
                $proto = ([string]$rule.protocol).ToUpper()
                $port = [int]$rule.port
                $name = [string]$rule.name
                if ($proto -notin 'TCP', 'UDP' -or $port -lt 1 -or $port -gt 65535 -or $name -cne "myTunnels-$id-$($proto.ToLower())") {
                    throw "$name is not a rule myTunnels makes"
                }
                Remove-NetFirewallRule -Name $name -ErrorAction SilentlyContinue
                if ($ask.open -eq $true) {
                    $with = @{
                        Name = $name; DisplayName = "myTunnels port $port $proto"; Direction = 'Inbound'
                        Action = 'Allow'; Protocol = $proto; LocalPort = $port; Profile = 'Any'
                    }
                    if ($ask.relay -eq $true) { $with.Program = $program }
                    New-NetFirewallRule @with | Out-Null
                }
            }
        }
        catch {
            try { [IO.File]::WriteAllText((Join-Path $asks "$id.error"), $_.Exception.Message) } catch { }
        }
        Remove-Item -LiteralPath $file.FullName -Force -ErrorAction SilentlyContinue
    }
    # Woken by the next ask, and every few seconds in case one was missed.
    [void]$watch.WaitForChanged([IO.WatcherChangeTypes]::All, 5000)
}
