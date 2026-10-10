# One-time install: Python virtual environment for the API, npm packages for the web app.
# Needs Python 3.13 (the py launcher) and Node 22 or newer. Nothing is installed globally.
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot

Push-Location (Join-Path $root 'backend')
try {
  if (-not (Test-Path '.venv')) { py -3.13 -m venv .venv }
  & '.venv\Scripts\python.exe' -m pip install --quiet -r requirements-dev.txt
} finally { Pop-Location }

Push-Location (Join-Path $root 'frontend')
try { npm install --no-audit --no-fund } finally { Pop-Location }

Write-Host 'Installed. Start the app with scripts\start.ps1'
