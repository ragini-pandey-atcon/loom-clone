# Stops whatever is listening on the app's two ports (7310 API, 5310 web app).
foreach ($port in 7310, 5310) {
  $owners = Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue |
    Select-Object -ExpandProperty OwningProcess -Unique
  if (-not $owners) { Write-Host "Nothing on port $port"; continue }
  foreach ($procId in $owners) {
    Stop-Process -Id $procId -Force -ErrorAction SilentlyContinue
    Write-Host "Stopped process $procId on port $port"
  }
}
