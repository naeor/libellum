@echo off
title Libellum dev server (LAN - phone testing)
cd /d "%~dp0"

rem Makes the web dev server listen on every interface so a phone on the same
rem Wi-Fi can reach it. The API stays on loopback: the phone only ever talks to
rem this server, and Vite forwards /api to the API locally.
set LIBELLUM_LAN=1

for /f "usebackq delims=" %%i in (`powershell -NoProfile -Command "(Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254.*' -and $_.InterfaceAlias -notlike '*Radmin*' } | Select-Object -First 1).IPAddress"`) do set LANIP=%%i

rem Double-clicking twice is an easy mistake, and the second run would only
rem report a port conflict. Say what is already true and get out of the way.
netstat -an | findstr /r /c:"TCP .*:5173 .*LISTENING" >nul 2>&1
if not errorlevel 1 (
  echo.
  echo   The server is ALREADY RUNNING - nothing to start.
  echo.
  echo     On this computer:      http://localhost:5173
  echo     On your phone:         http://%LANIP%:5173
  echo.
  echo   Opening the browser. To stop the server, close its other window.
  echo.
  start "" "http://localhost:5173"
  timeout /t 6 >nul
  exit /b 0
)

echo.
echo   ================================================================
echo     Libellum - LAN mode (for testing on your phone)
echo   ================================================================
echo.
echo     On this computer:      http://localhost:5173
echo     On your phone:         http://%LANIP%:5173
echo.
echo     Your phone must be on the SAME Wi-Fi as this computer.
echo.
echo     Windows may ask once whether to allow Node.js through the
echo     firewall. Choose Allow. If it does not ask, the rule from a
echo     previous run is already in place.
echo.
echo     Keep THIS window open while testing - closing it stops
echo     everything. To stop: close this window, or press Ctrl+C.
echo   ================================================================
echo.

start "" /min powershell -NoProfile -Command "Start-Sleep -Seconds 15; Start-Process 'http://localhost:5173'"

call pnpm.cmd dev

echo.
echo   Dev server stopped.
pause
