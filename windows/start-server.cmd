@echo off
rem Start de BBT-server (wordt gestart door de geplande taak "VAG BBT-server").
cd /d "%~dp0.."
if not exist "C:\vag-bbt\logs" mkdir "C:\vag-bbt\logs"
node --env-file=C:\vag-bbt\.env server\http.js >> "C:\vag-bbt\logs\server.log" 2>&1
exit /b %ERRORLEVEL%
