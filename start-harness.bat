@echo off
rem Arranca bzHarness: mata cualquier proceso ocupando el puerto (segun config.json,
rem por defecto 4321), lanza node src\server.js y abre la web en el navegador.
rem Toda la logica esta en start-harness.ps1 (sin '%' en el comando: un '%' a medio
rem linea en un .bat se expande mal por cmd y rompe el argumento de PowerShell).
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0start-harness.ps1"
endlocal