@echo off
setlocal
cd /d "%~dp0"

if not exist node_modules\.bin\vite.cmd (
  echo Instalando dependencias de la pagina de farmacia...
  call npm install
  if errorlevel 1 (
    echo No se pudieron instalar las dependencias.
    pause
    exit /b 1
  )
)

start "FarmaNorte - pagina de farmacia" cmd /k "cd /d ""%~dp0"" && npm run dev -- --host 127.0.0.1"
timeout /t 3 /nobreak >nul
start "" http://127.0.0.1:5173

echo La pagina se esta ejecutando en http://127.0.0.1:5173
echo Puedes cerrar esta ventana cuando termines de revisar la interfaz.
endlocal
