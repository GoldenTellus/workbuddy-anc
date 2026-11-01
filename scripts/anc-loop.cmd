@echo off
setlocal
REM Local service: one tick per minute.
REM Do NOT pin --webhook-file here: production picks the webhook per chat binding.
REM Use --webhook-file + --chat-id only for single-chat debugging.
REM NOTE: do not call schtasks from here. Under LOCAL SERVICE that request is
REM refused (0x800710E0) and it also dirties this task's exit code. Recovery is
REM the guard's job; it carries its own once/repeating trigger.
set "LOGF=C:\ProgramData\anc\data\loop.log"
REM Rotate past 5 MB, keeping one previous file: the current log must never grow without bound.
for %%F in ("%LOGF%") do if %%~zF GTR 5242880 (
  if exist "%LOGF%.1" del /Q "%LOGF%.1" >nul 2>&1
  move /Y "%LOGF%" "%LOGF%.1" >nul 2>&1
)
"C:\Program Files\nodejs\node.exe" --no-warnings "C:\ProgramData\anc\service\cli.ts" loop --once --db "C:\ProgramData\anc\data\anc.db" >> "%LOGF%" 2>&1
exit /b %ERRORLEVEL%