@echo off
rem ---------------------------------------------------------------------------
rem 双击这个文件，就会生成一个新的邀请码。
rem
rem 说明：项目是开源的，但不开放注册 —— 每个账号都要用一个一次性邀请码来开。
rem 这个脚本只是把你本来要在命令行里敲的东西做成了双击即可运行。
rem
rem 真实的逻辑不在这里，而在 apps/api/src/scripts/create-invite.ts（唯一一份，
rem 避免两处实现慢慢不一致）；再由 new-invite.mjs 负责找到项目目录并调用它。
rem ---------------------------------------------------------------------------

setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   没有找到 Node.js。请先安装 Node，然后再双击本文件。
  echo.
  goto :end
)

node "%~dp0new-invite.mjs"
if errorlevel 1 (
  echo.
  echo   生成失败。上面有原因。
)

:end
echo.
echo 按任意键关闭这个窗口...
pause >nul
endlocal
