@echo off
setlocal
REM Local HTTP surface: loopback only, long-running. Token is read from secrets by cli.ts serve.
set "LOGF=C:\ProgramData\anc\data\http.log"
for %%F in ("%LOGF%") do if %%~zF GTR 5242880 (
  if exist "%LOGF%.1" del /Q "%LOGF%.1" >nul 2>&1
  move /Y "%LOGF%" "%LOGF%.1" >nul 2>&1
)
"C:\Program Files\nodejs\node.exe" --no-warnings "C:\ProgramData\anc\service\cli.ts" serve --db "C:\ProgramData\anc\data\anc.db" --port 17891 >> "%LOGF%" 2>&1
exit /b %ERRORLEVEL%