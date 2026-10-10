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
  echo     On this computer:      https://localhost:5173
  echo     On your phone:         https://%LANIP%:5173
  echo.
  echo   Opening the browser. To stop the server, close its other window.
  echo.
  start "" "https://localhost:5173"
  timeout /t 6 >nul
  exit /b 0
)

rem Reached from a phone, the browser only defines the recording and offline APIs
rem on a SECURE origin. Over plain http those APIs do not exist at all, and --
rem this is the part that misleads -- no permission prompt appears, because there
rem is nothing to prompt for. The dev server therefore serves https, using a
rem self-signed certificate that has to be trusted once on the phone.
if not exist "apps\web\.certs\dev-cert.pem" (
  echo.
  echo   ================================================================
  echo     NO CERTIFICATE - running on http
  echo   ================================================================
  echo.
  echo     On the phone this means:
  echo       - recording will say the address is not secure
  echo       - offline mode will not work
  echo       - and NO permission prompt will appear, because the browser
  echo         does not provide the API at all over http
  echo.
  echo     To fix it, run this once:
  echo.
  echo         pnpm dev:cert
  echo.
  echo     Then run this file again. See docs\README.md for the one-time
  echo     trust step on the phone.
  echo   ================================================================
  echo.
  timeout /t 8 >nul
)

echo.
echo   ================================================================
echo     Libellum - LAN mode (for testing on your phone)
echo   ================================================================
echo.
echo     On this computer:      https://localhost:5173
echo     On your phone:         https://%LANIP%:5173
echo.
echo     NOTE the https. Over http the phone cannot record -- see above.
echo.
echo     Your phone must be on the SAME Wi-Fi as this computer.
echo.
echo     The first visit shows a certificate warning. That is expected for
echo     a self-signed certificate; the one-time trust step is in
echo     docs\README.md.
echo.
echo     Windows may ask once whether to allow Node.js through the
echo     firewall. Choose Allow. If it does not ask, the rule from a
echo     previous run is already in place.
echo.
echo     Keep THIS window open while testing - closing it stops
echo     everything. To stop: close this window, or press Ctrl+C.
echo   ================================================================
echo.

start "" /min powershell -NoProfile -Command "Start-Sleep -Seconds 15; Start-Process 'https://localhost:5173'"

call pnpm.cmd dev

echo.
echo   Dev server stopped.
pause
