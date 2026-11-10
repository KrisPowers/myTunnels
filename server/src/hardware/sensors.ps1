# Run by the "myTunnels Hardware" task as SYSTEM: reads every sensor
# LibreHardwareMonitor's library finds, through the PawnIO driver, and each
# drive's reliability counters, and writes them to sensors.json beside this
# script every few seconds for the Hardware page to read. Anything that stops
# it is written to sensors.error.txt, which the page shows. -Once reads once
# and stops, to try it by hand.
param([switch]$Once)
$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$lib = Join-Path $here 'lib'
$out = Join-Path $here 'sensors.json'
$next = Join-Path $here 'sensors.json.new'
$errors = Join-Path $here 'sensors.error.txt'

trap {
    $why = $_.Exception
    while ($why.InnerException) { $why = $why.InnerException }
    $detail = if ($why -is [Reflection.ReflectionTypeLoadException]) { ($why.LoaderExceptions | ForEach-Object { $_.Message } | Select-Object -Unique) -join ' ' } else { $why.Message }
    [IO.File]::WriteAllText($errors, "$(Get-Date -Format o) $detail")
    exit 1
}

# The library's own references load from its folder, whatever version they
# ask for. The handler is compiled C#, not a script block, since the library
# loads some of them from threads of its own, where no script can run.
Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.Reflection;
public static class LibFolder {
    static string dir;
    public static void Use(string path) {
        dir = path;
        AppDomain.CurrentDomain.AssemblyResolve += (sender, e) => {
            string file = Path.Combine(dir, new AssemblyName(e.Name).Name + ".dll");
            return File.Exists(file) ? Assembly.LoadFrom(file) : null;
        };
    }
}
'@
[LibFolder]::Use($lib)
[void][Reflection.Assembly]::LoadFrom((Join-Path $lib 'LibreHardwareMonitorLib.dll'))

$computer = New-Object LibreHardwareMonitor.Hardware.Computer
$computer.IsCpuEnabled = $true
$computer.IsGpuEnabled = $true
$computer.IsMemoryEnabled = $true
$computer.IsMotherboardEnabled = $true
$computer.IsControllerEnabled = $true
$computer.IsStorageEnabled = $true
$computer.IsPsuEnabled = $true
$computer.Open()
Remove-Item -LiteralPath $errors -ErrorAction SilentlyContinue

function Read-Hardware($hw, $list) {
    $hw.Update()
    [void]$list.Add([ordered]@{
            type    = $hw.HardwareType.ToString()
            name    = $hw.Name
            id      = $hw.Identifier.ToString()
            sensors = @($hw.Sensors | Where-Object { $null -ne $_.Value } | ForEach-Object {
                    [ordered]@{ type = $_.SensorType.ToString(); name = $_.Name; value = [math]::Round([double]$_.Value, 2) }
                })
        })
    foreach ($sub in $hw.SubHardware) { Read-Hardware $sub $list }
}

$drives = @()
$drivesAt = [datetime]::MinValue
while ($true) {
    try {
        $list = New-Object System.Collections.ArrayList
        foreach ($hw in $computer.Hardware) { Read-Hardware $hw $list }
        # Wear and error counters change slowly, so once a minute.
        if (((Get-Date) - $drivesAt).TotalSeconds -ge 60) {
            $drives = @(Get-PhysicalDisk | ForEach-Object {
                    $r = $_ | Get-StorageReliabilityCounter -ErrorAction SilentlyContinue
                    [ordered]@{
                        id           = "$($_.DeviceId)"
                        temperature  = $r.Temperature
                        wear         = $r.Wear
                        read_errors  = $r.ReadErrorsUncorrected
                        write_errors = $r.WriteErrorsUncorrected
                        hours        = $r.PowerOnHours
                    }
                })
            $drivesAt = Get-Date
        }
        $json = [ordered]@{ at = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds(); hardware = $list; drives = $drives } | ConvertTo-Json -Depth 6 -Compress
        [IO.File]::WriteAllText($next, $json)
        Move-Item -LiteralPath $next -Destination $out -Force
    }
    catch {
        [IO.File]::WriteAllText($errors, "$(Get-Date -Format o) $($_.Exception.Message)")
    }
    if ($Once) { break }
    Start-Sleep -Seconds 3
}
