# What Windows tells any signed-in account about this computer's parts, as
# one line of JSON: the memory slots and sticks, the drives and their health,
# the processor, the board and the graphics cards, and the last 30 days of
# crashes, hardware errors and power losses from the System log.
$ErrorActionPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$since = (Get-Date).AddDays(-30)

$events = @(Get-WinEvent -FilterHashtable @(
        @{ LogName = 'System'; ProviderName = 'Microsoft-Windows-WER-SystemErrorReporting'; Id = 1001; StartTime = $since },
        @{ LogName = 'System'; ProviderName = 'Microsoft-Windows-WHEA-Logger'; StartTime = $since },
        @{ LogName = 'System'; ProviderName = 'Microsoft-Windows-Kernel-Power'; Id = 41; StartTime = $since }
    ) -MaxEvents 200 | ForEach-Object {
        [ordered]@{
            at       = [DateTimeOffset]::new($_.TimeCreated).ToUnixTimeSeconds()
            provider = $_.ProviderName
            id       = $_.Id
            level    = $_.Level
            text     = ($_.Message -split "`r?`n" | Where-Object { $_ } | Select-Object -First 3) -join ' '
        }
    })

[ordered]@{
    slots  = [int](Get-CimInstance Win32_PhysicalMemoryArray | Measure-Object MemoryDevices -Sum).Sum
    ecc    = @(Get-CimInstance Win32_PhysicalMemoryArray | Where-Object { $_.MemoryErrorCorrection -in 5, 6, 7 }).Count -gt 0
    sticks = @(Get-CimInstance Win32_PhysicalMemory | ForEach-Object {
            [ordered]@{
                slot       = "$($_.DeviceLocator)".Trim()
                bank       = "$($_.BankLabel)".Trim()
                bytes      = [uint64]$_.Capacity
                speed      = [int]$_.Speed
                configured = [int]$_.ConfiguredClockSpeed
                maker      = "$($_.Manufacturer)".Trim()
                part       = "$($_.PartNumber)".Trim()
                serial     = "$($_.SerialNumber)".Trim()
            }
        })
    drives = @(Get-PhysicalDisk | ForEach-Object {
            [ordered]@{
                id     = "$($_.DeviceId)"
                name   = "$($_.FriendlyName)".Trim()
                media  = "$($_.MediaType)"
                bus    = "$($_.BusType)"
                health = "$($_.HealthStatus)"
                state  = (@($_.OperationalStatus) -join ', ')
                bytes  = [uint64]$_.Size
                serial = "$($_.SerialNumber)".Trim()
            }
        })
    cpus   = @(Get-CimInstance Win32_Processor | ForEach-Object {
            [ordered]@{ name = "$($_.Name)".Trim(); cores = [int]$_.NumberOfCores; threads = [int]$_.NumberOfLogicalProcessors; mhz = [int]$_.MaxClockSpeed }
        })
    board  = @(Get-CimInstance Win32_BaseBoard | ForEach-Object { "$($_.Manufacturer) $($_.Product)".Trim() }) | Select-Object -First 1
    # A device code other than 0 is a problem Windows sees with the card.
    gpus   = @(Get-CimInstance Win32_VideoController | ForEach-Object { [ordered]@{ name = "$($_.Name)".Trim(); driver = "$($_.DriverVersion)"; error = [int]$_.ConfigManagerErrorCode } })
    events = $events
} | ConvertTo-Json -Depth 5 -Compress
