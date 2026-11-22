@echo off
setlocal
cd /d "%~dp0"
if errorlevel 1 (
  echo No se pudo abrir la carpeta del proyecto.
  pause
  exit /b 1
)

title Stream Deck casero

where node >nul 2>&1
if errorlevel 1 (
  echo No se encontro Node.js. Instala Node.js 18 o superior y vuelve a intentarlo.
  pause
  exit /b 1
)

where npm >nul 2>&1
if errorlevel 1 (
  echo No se encontro npm. Reinstala Node.js y asegurate de agregarlo al PATH.
  pause
  exit /b 1
)

if not exist "node_modules\express\package.json" (
  echo Instalando dependencias...
  call npm.cmd install
  if errorlevel 1 (
    echo No se pudieron instalar las dependencias.
    pause
    exit /b 1
  )
)

echo Iniciando Stream Deck casero...
echo Deja esta ventana abierta mientras uses el panel.
echo.
call npm.cmd start
if errorlevel 1 (
  echo.
  echo El servidor no pudo iniciarse. Revisa el error anterior.
  pause
  exit /b 1
)

endlocal
