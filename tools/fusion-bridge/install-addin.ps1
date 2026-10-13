# Install (or remove) the FusionBridge add-in, and optionally the diagnostic
# script, for Fusion 360.
#
# ASCII-only on purpose: this file must be safe under both Windows PowerShell
# 5.1 and pwsh 7 (see AGENTS.md section 2.1 -- no BOM, no backticks in
# comments, ASCII-only content).
#
#   powershell -ExecutionPolicy Bypass -File tools\fusion-bridge\install-addin.ps1
#   powershell -ExecutionPolicy Bypass -File tools\fusion-bridge\install-addin.ps1 -Probe
#   powershell -ExecutionPolicy Bypass -File tools\fusion-bridge\install-addin.ps1 -Uninstall

[CmdletBinding()]
param(
    [switch]$Uninstall,
    [switch]$Probe
)

$ErrorActionPreference = 'Stop'

$apiRoot  = Join-Path $env:APPDATA 'Autodesk\Autodesk Fusion 360\API'
$addins   = Join-Path $apiRoot 'AddIns'

$targets = @(
    @{ Name = 'FusionBridge';      Source = Join-Path $PSScriptRoot 'addin\FusionBridge';      Dest = Join-Path $addins 'FusionBridge';      Enabled = $true  },
    @{ Name = 'FusionBridgeProbe'; Source = Join-Path $PSScriptRoot 'diag\FusionBridgeProbe';  Dest = Join-Path $addins 'FusionBridgeProbe'; Enabled = [bool]$Probe }
)

$python = (Get-Command python -ErrorAction SilentlyContinue).Source
if (-not $python) { throw "python not found on PATH; it is needed to validate the payloads" }

$validator = "import ast, json, os, sys" + [char]10 +
             "json.load(open(sys.argv[1], encoding='utf-8'))" + [char]10 +
             "ast.parse(open(sys.argv[2], encoding='utf-8').read(), sys.argv[2])" + [char]10 +
             "print('manifest + syntax ok')"

foreach ($t in $targets) {
    if (-not $t.Enabled) { continue }

    if ($Uninstall) {
        if (Test-Path $t.Dest) {
            Remove-Item -Recurse -Force $t.Dest
            Write-Host ("removed: {0}" -f $t.Dest) -ForegroundColor Yellow
        } else {
            Write-Host ("not installed: {0}" -f $t.Dest)
        }
        continue
    }

    if (-not (Test-Path $t.Source)) { throw ("source folder not found: {0}" -f $t.Source) }

    # Guard against the one mistake that matters: deleting the wrong tree.
    $resolved = [System.IO.Path]::GetFullPath($t.Dest)
    if (-not $resolved.EndsWith($t.Name)) {
        throw ("refusing to touch unexpected target path: {0}" -f $resolved)
    }

    if (Test-Path $t.Dest) {
        Write-Host ("replacing existing: {0}" -f $t.Dest)
        Remove-Item -Recurse -Force $t.Dest
    }

    New-Item -ItemType Directory -Force -Path (Split-Path $t.Dest -Parent) | Out-Null
    Copy-Item -Recurse -Force $t.Source $t.Dest

    $manifest = Join-Path $t.Dest ($t.Name + '.manifest')
    $payload  = Join-Path $t.Dest ($t.Name + '.py')
    foreach ($f in @($manifest, $payload)) {
        if (-not (Test-Path $f)) { throw ("copy incomplete, missing: {0}" -f $f) }
    }

    # NOTE: do NOT use ConvertFrom-Json here. Fusion's own manifests use an
    # empty string as a description locale key ({"": "..."}), which is legal
    # JSON but makes ConvertFrom-Json throw unless -AsHashtable is passed.
    $check = & $python -c $validator $manifest $payload
    if ($LASTEXITCODE -ne 0) { throw ("payload validation failed for {0}" -f $t.Name) }

    Write-Host ("installed: {0}  [{1}]" -f $t.Dest, $check) -ForegroundColor Green
}

if ($Uninstall) {
    Write-Host ""
    Write-Host "Also untick it in Fusion: Tools > Scripts and Add-Ins > Add-Ins."
    return
}

Write-Host ""
Write-Host "Next, in Fusion 360:" -ForegroundColor Cyan
Write-Host "  1. Tools (UTILITIES) > Scripts and Add-Ins  (Shift+S)"
Write-Host "  2. Add-Ins tab > select FusionBridge > Run"
Write-Host "  3. Tick 'Run on Startup' so it comes back after a restart"
if ($Probe) {
    Write-Host "  4. Add-Ins tab > select FusionBridgeProbe > Run (writes a diagnostic log)"
}
Write-Host ""
Write-Host "Then verify from a shell:"
Write-Host "  python tools\fusion-bridge\bridge_client.py ping"
