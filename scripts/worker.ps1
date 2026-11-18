#Requires -Version 7.4
# Puts the short install address in place, or brings it up to date after the
# install scripts change:
#
#   $env:CLOUDFLARE_API_TOKEN = '<token>'; pwsh scripts/worker.ps1
#
# It deploys scripts/worker.js as the Worker "install", with install.ps1 and
# install.sh written into it, and routes krispowers.dev/mytunnels to it. Then
#
#   irm krispowers.dev/mytunnels | iex           (Windows)
#   curl -fsSL krispowers.dev/mytunnels | sh     (macOS and Linux)
#
# install myTunnels. The token needs Workers Scripts and Workers Routes, Edit.
param(
    [string]$Address = 'krispowers.dev/mytunnels',
    [string]$Name = 'install'
)
$ErrorActionPreference = 'Stop'
$token = $env:CLOUDFLARE_API_TOKEN
if (-not $token) { throw 'Set CLOUDFLARE_API_TOKEN first' }
$api = 'https://api.cloudflare.com/client/v4'
$headers = @{ Authorization = "Bearer $token" }

function Ask($method, $path, $body) {
    $with = @{ Method = $method; Uri = "$api$path"; Headers = $headers }
    if ($body) { $with.Body = $body | ConvertTo-Json -Depth 5; $with.ContentType = 'application/json' }
    $answer = Invoke-RestMethod @with
    if (-not $answer.success) { throw "Cloudflare: $($answer.errors | ConvertTo-Json -Compress)" }
    $answer.result
}

# The scripts go in as JSON strings, which are JavaScript strings too.
$scripts = Join-Path $PSScriptRoot '.'
$code = (Get-Content (Join-Path $scripts 'worker.js') -Raw).
    Replace('"__PS1__"', (Get-Content (Join-Path $scripts 'install.ps1') -Raw | ConvertTo-Json)).
    Replace('"__SH__"', (Get-Content (Join-Path $scripts 'install.sh') -Raw | ConvertTo-Json))

$zoneName = $Address.Split('/')[0]
$zone = @(Ask GET "/zones?name=$zoneName")[0]
if (-not $zone) { throw "$zoneName is not on this Cloudflare account" }
$account = $zone.account.id

# A module Worker is uploaded as a form: its metadata, then the module.
Add-Type -AssemblyName System.Net.Http
$form = [System.Net.Http.MultipartFormDataContent]::new()
$meta = [System.Net.Http.StringContent]::new((@{ main_module = 'worker.js'; compatibility_date = '2025-01-01' } | ConvertTo-Json))
$meta.Headers.ContentType = 'application/json'
$form.Add($meta, 'metadata')
$module = [System.Net.Http.StringContent]::new($code)
$module.Headers.ContentType = 'application/javascript+module'
$form.Add($module, 'worker.js', 'worker.js')
$client = [System.Net.Http.HttpClient]::new()
$client.DefaultRequestHeaders.Authorization = [System.Net.Http.Headers.AuthenticationHeaderValue]::new('Bearer', $token)
$put = $client.PutAsync("$api/accounts/$account/workers/scripts/$Name", $form).GetAwaiter().GetResult()
$said = $put.Content.ReadAsStringAsync().GetAwaiter().GetResult() | ConvertFrom-Json
$client.Dispose()
if (-not $said.success) { throw "Cloudflare: $($said.errors | ConvertTo-Json -Compress)" }
Write-Host "Deployed the Worker $Name"

# The route, made once.
$routes = @(Ask GET "/zones/$($zone.id)/workers/routes")
if (-not ($routes | Where-Object pattern -eq $Address)) {
    Ask POST "/zones/$($zone.id)/workers/routes" @{ pattern = $Address; script = $Name } | Out-Null
    Write-Host "Routed $Address to it"
}
Write-Host "Install with: irm $Address | iex"
