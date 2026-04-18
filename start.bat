@echo off
setlocal EnableExtensions
title Codex Rich Presence
pushd "%~dp0" >nul

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not on PATH. Install it from https://nodejs.org/ and retry.
  pause >nul
  popd >nul
  exit /b 1
)

powershell -NoProfile -ExecutionPolicy Bypass -File "scripts\run-daemon.ps1"
set "CODE=%ERRORLEVEL%"

popd >nul
endlocal & exit /b %CODE%
