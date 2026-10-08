@echo off
title Libellum local dev server
cd /d "%~dp0"

echo.
echo   ================================================================
echo     Libellum local development server
echo   ================================================================
echo.
echo     Web    http://localhost:5173
echo     API    http://127.0.0.1:3000
echo.
echo     The browser opens by itself after about 15 seconds.
echo     To stop:  close this window, or press Ctrl+C.
echo.
echo     NOTE: closing this window takes the site offline. That is not
echo           a fault -- run this file again to bring it back.
echo   ================================================================
echo.

rem Give the dev server time to boot before opening the browser.
rem PowerShell is used here because nested quotes in a bare `start` line
rem are parsed unreliably by cmd.
start "" /min powershell -NoProfile -Command "Start-Sleep -Seconds 15; Start-Process 'http://localhost:5173'"

call pnpm.cmd dev

echo.
echo   Dev server stopped. Run this file again to restart it.
pause
