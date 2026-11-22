@echo off
setlocal ENABLEDELAYEDEXPANSION
cd /d "%~dp0"

REM Puerto: se lee de config.json (por defecto 3000)
set PORT=3000
for /f %%P in ('node -p "require('./config.json').port" 2^>nul') do set PORT=%%P

echo Iniciando Stream Deck casero en el puerto %PORT%...

REM Abre el servidor en su propia ventana (si la cierras, se detiene)
start "Stream Deck casero" cmd /k npm start

REM Espera a que responda /health (hasta ~20 s)
set /a RETRIES=12
:wait_loop
ping -n 2 127.0.0.1 > nul
powershell -NoProfile -Command "try { $r=Invoke-WebRequest -UseBasicParsing http://localhost:%PORT%/health -TimeoutSec 1; if ($r.StatusCode -eq 200) { exit 0 } else { exit 1 } } catch { exit 1 }"
if !ERRORLEVEL! neq 0 (
  set /a RETRIES-=1
  if !RETRIES! gtr 0 goto wait_loop
  echo El servidor no respondio. Revisa la ventana "Stream Deck casero".
  pause
  exit /b 1
)

echo Servidor listo. En el telefono abre la direccion que aparece en la otra ventana.
timeout /t 3 > nul
endlocal
