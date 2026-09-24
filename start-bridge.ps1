$ErrorActionPreference = "Stop"

$projectRoot = $PSScriptRoot
$bridgePath = Join-Path $projectRoot "bridge.js"
$managedNode = Join-Path $env:USERPROFILE ".workbuddy\binaries\node\versions\22.22.2-3\node.exe"

if (-not (Test-Path $bridgePath)) {
    throw "bridge.js was not found in $projectRoot"
}

$nodePath = $null
if (Test-Path $managedNode) {
    $nodePath = $managedNode
} else {
    $nodeCommand = Get-Command node -ErrorAction SilentlyContinue
    if ($nodeCommand) {
        $nodePath = $nodeCommand.Source
    }
}

if (-not $nodePath) {
    throw "Node.js 22 or newer was not found. Install it or add node.exe to PATH."
}

$nodeVersion = (& $nodePath --version).Trim()
if ($nodeVersion -notmatch "^v?(\d+)\.") {
    throw "Could not determine the Node.js version from '$nodeVersion'."
}
if ([int]$Matches[1] -lt 22) {
    throw "Node.js 22 or newer is required; found $nodeVersion at $nodePath."
}

$port = 8787
if ($env:BRIDGE_PORT) {
    $port = [int]$env:BRIDGE_PORT
} else {
    $envPath = Join-Path $projectRoot ".env"
    if (Test-Path $envPath) {
        $portSetting = Get-Content $envPath | Where-Object { $_ -match '^\s*BRIDGE_PORT\s*=' } | Select-Object -Last 1
        if ($portSetting -and $portSetting -match '^\s*BRIDGE_PORT\s*=\s*["'']?(\d+)') {
            $port = [int]$Matches[1]
        }
    }
}

try {
    $health = Invoke-RestMethod -Uri "http://127.0.0.1:$port/healthz" -TimeoutSec 2
    if ($health.status -eq "ok") {
        Write-Host "Azure OpenAI Responses Bridge is already running at http://127.0.0.1:$port."
        return
    }
} catch {
    # No healthy bridge answered on this port; start it below.
}

if (-not (Test-Path (Join-Path $projectRoot ".env"))) {
    Write-Warning "No .env file was found. Configure Azure credentials before sending requests."
}

Write-Host "Starting Azure OpenAI Responses Bridge with $nodeVersion. Press Ctrl+C to stop."
Push-Location $projectRoot
try {
    & $nodePath $bridgePath
    if ($LASTEXITCODE -ne 0) {
        throw "The bridge exited with code $LASTEXITCODE."
    }
} finally {
    Pop-Location
}