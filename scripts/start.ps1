# Starts the API (port 7310) and the web app (port 5310) as detached background processes,
# so they keep running after this window or the session that started them closes.
# Logs go to data\logs. Safe to run twice: a port that is already serving is left alone.
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$logs = Join-Path $root 'data\logs'
New-Item -ItemType Directory -Force -Path $logs | Out-Null

function Test-Listening([int]$port) {
  [bool](Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue)
}

$python = Join-Path $root 'backend\.venv\Scripts\python.exe'
if (-not (Test-Path $python)) { throw "Backend not installed. Run scripts\setup.ps1 first." }
if (-not (Test-Path (Join-Path $root 'frontend\node_modules'))) { throw "Frontend not installed. Run scripts\setup.ps1 first." }

if (Test-Listening 7310) {
  Write-Host 'API already running on port 7310'
} else {
  Start-Process -FilePath 'cmd.exe' -WindowStyle Hidden -WorkingDirectory (Join-Path $root 'backend') `
    -ArgumentList '/c', "set PYTHONUNBUFFERED=1&& .venv\Scripts\python.exe -m uvicorn app.main:app --host 127.0.0.1 --port 7310 > `"$logs\api.log`" 2>&1"
  Write-Host 'Starting API on port 7310'
}

if (Test-Listening 5310) {
  Write-Host 'Web app already running on port 5310'
} else {
  Start-Process -FilePath 'cmd.exe' -WindowStyle Hidden -WorkingDirectory (Join-Path $root 'frontend') `
    -ArgumentList '/c', "npm run dev > `"$logs\web.log`" 2>&1"
  Write-Host 'Starting web app on port 5310'
}

$deadline = (Get-Date).AddSeconds(40)
while ((Get-Date) -lt $deadline -and -not ((Test-Listening 7310) -and (Test-Listening 5310))) {
  Start-Sleep -Milliseconds 500
}
if ((Test-Listening 7310) -and (Test-Listening 5310)) {
  Write-Host ''
  Write-Host 'Ready. Open http://localhost:5310 in Chrome or Edge.'
} else {
  Write-Warning "Not ready after 40 s. Check $logs\api.log and $logs\web.log"
  exit 1
}
