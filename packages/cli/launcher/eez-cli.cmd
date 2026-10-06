@echo off
rem eez-cli on PATH: runs eez-cli.js with the app's Electron as Node
setlocal
set ELECTRON_RUN_AS_NODE=1
"%~dp0..\..\EEZ Studio.exe" "%~dp0eez-cli.js" %*
exit /b %ERRORLEVEL%
