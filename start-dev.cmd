@echo off
chcp 65001 >nul
title Libellum 本地服务
cd /d "%~dp0"

echo.
echo   ================================================================
echo     Libellum 本地服务
echo   ================================================================
echo.
echo     网站地址   http://localhost:5173
echo     API 地址   http://127.0.0.1:3000
echo.
echo     浏览器会在约 15 秒后自动打开。
echo     要停止服务：关闭这个窗口，或按 Ctrl+C。
echo.
echo     注意：关掉这个窗口网站就打不开了，这不是网站坏了。
echo   ================================================================
echo.

rem Give the dev server time to boot before opening the browser.
start "Libellum browser" /min cmd /c "timeout /t 15 /nobreak >nul && start "" http://localhost:5173"

call pnpm.cmd dev

echo.
echo   本地服务已停止。双击本文件可再次启动。
pause
