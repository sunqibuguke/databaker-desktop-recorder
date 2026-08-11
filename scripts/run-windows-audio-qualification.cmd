@echo off
setlocal
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0run-windows-audio-qualification.ps1" %*
exit /b %ERRORLEVEL%
