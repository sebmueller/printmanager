@echo off
setlocal
cd /d "%~dp0"

where python >nul 2>&1
if errorlevel 1 (
    echo Python wurde nicht gefunden. Bitte Python installieren und zum PATH hinzufuegen.
    pause
    exit /b 1
)

echo Starte PrintManager auf http://localhost:5000 ...
start "" http://localhost:5000
python app.py

echo.
echo Der PrintManager wurde beendet.
pause
