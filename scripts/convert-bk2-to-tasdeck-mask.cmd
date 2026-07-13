@echo off
setlocal
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0convert-bk2-to-tasdeck-mask.ps1" %*
exit /b %errorlevel%
