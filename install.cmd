@echo off
chcp 65001 >nul
title dsh-douyin-chat installer
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1"
if errorlevel 1 (
  echo.
  echo Install failed. See messages above.
  pause
  exit /b 1
)
pause
