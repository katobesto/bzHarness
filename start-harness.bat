@echo off
rem Arranca bzHarness: mata cualquier proceso ocupando el puerto (segun config.json, por defecto 4321),
rem lanza node src\server.js y abre la web en el navegador.
setlocal
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -Command "$port=4321; try { $c = Get-Content 'config\config.json' -Raw -Encoding UTF8 | ConvertFrom-Json; if ($c.port) { $port=[int]$c.port } } catch {}; $cs = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue; if ($cs) { $cs | Select-Object -ExpandProperty OwningProcess -Unique | ForEach-Object { Write-Host ('Puerto ' + $port + ' ocupado por PID ' + $_ + ' -> matando'); Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue }; $i=0; while ((Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue) -and $i -lt 10) { Start-Sleep -Milliseconds 500; $i++ } } else { Write-Host ('Puerto ' + $port + ' libre') }; Write-Host ('Arrancando server.js en http://127.0.0.1:' + $port); Start-Process -FilePath 'node' -ArgumentList 'src\server.js'; Start-Sleep -Seconds 2; Start-Process ('http://127.0.0.1:' + $port)"
endlocal