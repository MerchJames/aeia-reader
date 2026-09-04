# Put the Aeia Bridge into SillyTavern.
#
#   Right-click → Run with PowerShell, or:
#   powershell -ExecutionPolicy Bypass -File install.ps1
#   powershell -ExecutionPolicy Bypass -File install.ps1 -SillyTavern "D:\ST"
#
# Copies one folder. Touches nothing else in SillyTavern, and tells you every
# path it is going to use before it uses it.

param(
    [string]$SillyTavern = "",
    [string]$User = "default-user"
)

$ErrorActionPreference = "Stop"
$source = Join-Path $PSScriptRoot "aeia-bridge"

if (-not (Test-Path (Join-Path $source "manifest.json"))) {
    Write-Host "Could not find aeia-bridge\manifest.json next to this script." -ForegroundColor Red
    Write-Host "Run it from inside the st-extension folder."
    exit 1
}

# Does this look like a SillyTavern install? `data` is the giveaway — every
# version since 1.12 keeps per-user folders under it.
function Test-SillyTavern($path) {
    return $path -and (Test-Path (Join-Path $path "data")) -and
        ((Test-Path (Join-Path $path "server.js")) -or (Test-Path (Join-Path $path "package.json")))
}

if (-not $SillyTavern) {
    # The launcher's path first: it is what most people on Windows actually have.
    $guesses = @(
        "$env:USERPROFILE\sillytavern\SillyTavern-Launcher\SillyTavern",
        "$env:USERPROFILE\SillyTavern",
        "$env:USERPROFILE\Documents\SillyTavern",
        "C:\SillyTavern",
        "D:\SillyTavern"
    )
    $SillyTavern = $guesses | Where-Object { Test-SillyTavern $_ } | Select-Object -First 1
}

if (-not (Test-SillyTavern $SillyTavern)) {
    Write-Host "Could not find SillyTavern." -ForegroundColor Yellow
    Write-Host "Run this again with the folder that contains its 'data' directory:"
    Write-Host '  powershell -ExecutionPolicy Bypass -File install.ps1 -SillyTavern "C:\path\to\SillyTavern"'
    exit 1
}

$extensions = Join-Path (Join-Path (Join-Path $SillyTavern "data") $User) "extensions"
$target = Join-Path $extensions "aeia-bridge"

Write-Host "SillyTavern : $SillyTavern"
Write-Host "Installing to: $target"

if (-not (Test-Path $extensions)) { New-Item -ItemType Directory -Path $extensions -Force | Out-Null }

if (Test-Path $target) {
    # Replaced, not merged: a half-old half-new extension is a bug report nobody
    # can read. Only this one folder is removed.
    Write-Host "Replacing the existing copy." -ForegroundColor Yellow
    Remove-Item $target -Recurse -Force
}

Copy-Item $source $target -Recurse
Write-Host ""
Write-Host "Installed." -ForegroundColor Green
Write-Host "Now: reload SillyTavern in your browser, then open Extensions and look for 'Aeia Bridge'."
