@echo off
setlocal EnableExtensions
title Codex Rich Presence — stop
pushd "%~dp0" >nul

set "LOCK=%LOCALAPPDATA%\codex-rich-presence\instance.lock"

if not exist "%LOCK%" (
  echo No running instance found.
  goto :pause_end
)

rem Read the PID from the lock file (JSON record or legacy plain integer).
for /f "usebackq tokens=*" %%A in (`powershell -NoProfile -Command ^
  "$r = Get-Content -Raw '%LOCK%'; try { (ConvertFrom-Json $r).pid } catch { $r.Trim() }"`) do set "PID=%%A"

if "%PID%"=="" (
  echo Could not read PID from %LOCK%.
  goto :pause_end
)

echo Stopping Rich Presence ^(PID %PID%^)...
taskkill /PID %PID% /F >nul 2>nul
if errorlevel 1 (
  echo Process %PID% was not alive. Removing stale lock.
)
del /f /q "%LOCK%" >nul 2>nul
echo Stopped.

:pause_end
popd >nul
echo.
pause >nul
endlocal
