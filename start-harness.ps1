# start-harness.ps1 — logica de start-harness.bat (separada para poder validar su sintaxis
# con [System.Management.Automation.Language.Parser]::ParseFile). No usa '%' en ninguna
# parte: en un .bat, un '%' a medio linea destruye el comando (expandido por cmd antes
# de que PowerShell lo vea).
$ErrorActionPreference = "Stop"
$root = $PSScriptRoot
Set-Location $root

$port = 4321
try {
  $c = Get-Content (Join-Path $root "config\config.json") -Raw -Encoding UTF8 | ConvertFrom-Json
  if ($c.port) { $port = [int]$c.port }
} catch { }

$cs = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
if ($cs) {
  $cs | Select-Object -ExpandProperty OwningProcess -Unique | ForEach-Object {
    Write-Host ("Puerto " + $port + " ocupado por PID " + $_ + " -> matando")
    Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue
  }
  $i = 0
  while ((Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue) -and $i -lt 10) {
    Start-Sleep -Milliseconds 500
    $i++
  }
} else {
  Write-Host ("Puerto " + $port + " libre")
}

Write-Host ("Arrancando server.js en http://127.0.0.1:" + $port)
Start-Process -FilePath "node" -ArgumentList "src\server.js" -WorkingDirectory $root

$i = 0
while ($i -lt 40) {
  if (Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue) { break }
  Start-Sleep -Milliseconds 500
  $i++
}
if (Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue) {
  # querystring con timestamp: obliga a Chrome a navegar de nuevo en vez de reactivar
  # una pestaña vieja con JS antiguo
  $t = [DateTimeOffset]::Now.ToUnixTimeSeconds()
  Start-Process ("http://127.0.0.1:" + $port + "/?t=" + $t)
} else {
  Write-Host "Timeout: el servidor no escucho en el puerto $port"
}