[CmdletBinding()]
param(
    [string]$NodePath = $env:BRIDGE_NODE,
    [string]$EnvFile,
    [switch]$NoEnvFile,
    [switch]$CheckOnly
)
$ErrorActionPreference = "Stop"
$projectRoot = $PSScriptRoot
$bridgePath = Join-Path $projectRoot "bridge.js"
if (-not (Test-Path -LiteralPath $bridgePath -PathType Leaf)) { throw "Bridge entrypoint not found." }
if ($EnvFile -and $NoEnvFile) { throw "Choose -EnvFile or -NoEnvFile, not both." }
# Resolve caller-relative paths once, before runtime changes its working directory.
if ($EnvFile) {
    if (-not (Test-Path -LiteralPath $EnvFile -PathType Leaf)) { throw "Explicit environment file not found." }
    $EnvFile = (Resolve-Path -LiteralPath $EnvFile).ProviderPath
}

# Explicit override wins. Otherwise PATH, then discovered WorkBuddy-managed versions.
if ($NodePath) {
    if (-not (Test-Path -LiteralPath $NodePath -PathType Leaf)) { throw "Explicit Node executable not found." }
    $NodePath = (Resolve-Path -LiteralPath $NodePath).ProviderPath
    $candidates = @($NodePath)
} else {
    $candidates = @()
    $command = Get-Command node -ErrorAction SilentlyContinue
    if ($command) { $candidates += $command.Source }
    $versions = Join-Path $env:USERPROFILE ".workbuddy\binaries\node\versions"
    if (Test-Path -LiteralPath $versions) {
        $candidates += @(Get-ChildItem -LiteralPath $versions -Directory | Sort-Object LastWriteTime -Descending |
            ForEach-Object { Join-Path $_.FullName "node.exe" } | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf })
    }
}
$selectedNode = $null
foreach ($candidate in $candidates) {
    $nodeVersion = (& $candidate --version | Out-String).Trim()
    if ($LASTEXITCODE -eq 0 -and $nodeVersion -match '^v?(\d+)\.' -and [int]$Matches[1] -ge 22) {
        $selectedNode = $candidate
        break
    }
    if ($NodePath) { throw "Explicit Node executable must be Node.js 22 or newer." }
}
if (-not $selectedNode) { throw "Node.js 22+ not found. Set BRIDGE_NODE, use -NodePath, or add node.exe to PATH." }

# Node's own dotenv/config parser is shared by launcher and runtime. Never parse .env in PowerShell.
$runtimeArgs = @($bridgePath)
if ($NoEnvFile) { $runtimeArgs += "--no-env-file" }
elseif ($EnvFile) { $runtimeArgs += @("--env-file", $EnvFile) }
$summaryText = (& $selectedNode @runtimeArgs --check-config-json | Out-String).Trim()
if ($LASTEXITCODE -ne 0) { throw "Configuration validation failed; no listener started. See migration guidance." }
$summary = $summaryText | ConvertFrom-Json
if ($summary.host -ne "127.0.0.1" -or $summary.port -lt 1 -or $summary.port -gt 65535) { throw "Invalid safe startup summary." }
if ($CheckOnly) { Write-Output $summaryText; return }

$health = $null
try { $health = Invoke-RestMethod -Uri "http://127.0.0.1:$($summary.port)/healthz" -TimeoutSec 2 } catch { }
if ($health) {
    if ($health.service -ne $summary.service -or $health.protocol -ne $summary.protocol -or
        $health.build -ne $summary.build -or $health.configId -ne $summary.configId) {
        throw "This port answers with another service/build/configuration. Stop it explicitly before restarting; launcher will not replace it."
    }
    $ready = Invoke-RestMethod -Uri "http://127.0.0.1:$($summary.port)/readyz" -TimeoutSec 2
    if ($ready.status -ne "ready") { throw "Bridge is live but not ready; it was not restarted." }
    Write-Host "Matching bridge is already ready at http://127.0.0.1:$($summary.port)."
    return
}
Write-Host "Starting Azure Responses Bridge with $nodeVersion. Press Ctrl+C to stop."
Push-Location $projectRoot
try {
    & $selectedNode @runtimeArgs
    if ($LASTEXITCODE -ne 0) { throw "Bridge exited unsuccessfully (code $LASTEXITCODE)." }
} finally { Pop-Location }
