#Requires -RunAsAdministrator
<#
.SYNOPSIS
  Point local tenant domains at 127.0.0.1.

.DESCRIPTION
  Windows does not resolve *.localhost, so multi-domain dev fails silently
  without hosts entries. Idempotent — safe to re-run.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts/dev-hosts.ps1
  powershell -ExecutionPolicy Bypass -File scripts/dev-hosts.ps1 acme.localhost shop.localhost
#>
param(
  [string[]]$Domains = @('acme.localhost', 'studio.localhost', 'shop.localhost')
)

$ErrorActionPreference = 'Stop'
$hostsFile = Join-Path $env:SystemRoot 'System32\drivers\etc\hosts'
$existing = Get-Content -Path $hostsFile

$missing = $Domains | Where-Object {
  $pattern = '(^|\s)' + [regex]::Escape($_) + '(\s|$)'
  -not ($existing | Where-Object { $_ -notmatch '^\s*#' -and $_ -match $pattern })
}

if (-not $missing) {
  Write-Host "All $($Domains.Count) domain(s) already in $hostsFile"
  exit 0
}

Add-Content -Path $hostsFile -Value ($missing | ForEach-Object { "127.0.0.1`t$_" })
Write-Host "Added: $($missing -join ', ')"

ipconfig /flushdns | Out-Null
Write-Host 'DNS cache flushed.'
