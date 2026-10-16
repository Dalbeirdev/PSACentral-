@echo off
rem PSA Edge appliance helper for Command Prompt (cmd.exe) on a Windows machine whose Docker Engine runs inside WSL.
rem   psa-edge install "%USERPROFILE%\Downloads\psacc-dep-00030-package-1.zip"
rem   psa-edge status DEP-00030
rem   psa-edge stop   DEP-00030
rem   psa-edge wipe   DEP-00030
setlocal
set "PS1=%~dp0Install-EdgePackage.ps1"
if /i "%~1"=="install" ( powershell -NoProfile -ExecutionPolicy Bypass -File "%PS1%" -Zip "%~2" & exit /b %ERRORLEVEL% )
if /i "%~1"=="status"  ( powershell -NoProfile -ExecutionPolicy Bypass -File "%PS1%" -Status "%~2" & exit /b %ERRORLEVEL% )
if /i "%~1"=="stop"    ( powershell -NoProfile -ExecutionPolicy Bypass -File "%PS1%" -Stop "%~2" & exit /b %ERRORLEVEL% )
if /i "%~1"=="wipe"    ( powershell -NoProfile -ExecutionPolicy Bypass -File "%PS1%" -Wipe "%~2" & exit /b %ERRORLEVEL% )
echo Usage:
echo   psa-edge install "path\to\psacc-dep-nnnnn-package-n.zip"
echo   psa-edge status DEP-nnnnn
echo   psa-edge stop   DEP-nnnnn
echo   psa-edge wipe   DEP-nnnnn
exit /b 2
