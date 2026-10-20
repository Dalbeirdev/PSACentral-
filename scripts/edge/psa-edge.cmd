@echo off
rem PSA Edge appliance helper for Command Prompt (cmd.exe) on a Windows machine whose Docker Engine runs inside WSL.
rem   psa-edge install "%USERPROFILE%\Downloads\psacc-dep-00030-package-1.zip"
rem   psa-edge status DEP-00030
rem   psa-edge stop   DEP-00030
rem   psa-edge wipe   DEP-00030
rem   psa-edge repoint DEP-00030   (after this machine changed network)
rem Exit code: the helper's (0 only when the appliance verifies).
setlocal
set "PS1=%~dp0Install-EdgePackage.ps1"
rem PowerShell 7 when installed, otherwise Windows PowerShell 5.1 (both are supported).
set "PS=powershell.exe"
if exist "%ProgramFiles%\PowerShell\7\pwsh.exe" set "PS=%ProgramFiles%\PowerShell\7\pwsh.exe"
if /i "%~1"=="install" goto install
if /i "%~1"=="status" goto status
if /i "%~1"=="stop" goto stop
if /i "%~1"=="wipe" goto wipe
if /i "%~1"=="repoint" goto repoint
echo Usage:
echo   psa-edge install "path\to\psacc-dep-nnnnn-package-n.zip"
echo   psa-edge status DEP-nnnnn
echo   psa-edge stop   DEP-nnnnn
echo   psa-edge wipe   DEP-nnnnn
echo   psa-edge repoint DEP-nnnnn
exit /b 2

:install
"%PS%" -NoProfile -ExecutionPolicy Bypass -File "%PS1%" -Zip "%~2"
exit /b %ERRORLEVEL%
:status
"%PS%" -NoProfile -ExecutionPolicy Bypass -File "%PS1%" -Status "%~2"
exit /b %ERRORLEVEL%
:stop
"%PS%" -NoProfile -ExecutionPolicy Bypass -File "%PS1%" -Stop "%~2"
exit /b %ERRORLEVEL%
:wipe
"%PS%" -NoProfile -ExecutionPolicy Bypass -File "%PS1%" -Wipe "%~2"
exit /b %ERRORLEVEL%
:repoint
"%PS%" -NoProfile -ExecutionPolicy Bypass -File "%PS1%" -Repoint "%~2"
exit /b %ERRORLEVEL%
