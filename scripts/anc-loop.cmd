@echo off
REM Local service: one tick per minute.
REM Do NOT pin --webhook-file here: production picks the webhook per chat binding.
REM Use --webhook-file + --chat-id only for single-chat debugging.
setlocal
"C:\Program Files\nodejs\node.exe" "C:\ProgramData\anc\service\cli.ts" loop --once --db "C:\ProgramData\anc\data\anc.db" >> "C:\ProgramData\anc\data\loop.log" 2>&1
set RC=%ERRORLEVEL%

REM After a reboot the logon task may be terminated by the OS, and the guard's
REM every-minute trigger only resumes at the next daily boundary. So: if
REM WorkBuddy is not running, start the interactive guard task right away.
tasklist /fi "imagename eq WorkBuddy.exe" 2>nul | find /i "WorkBuddy.exe" >nul
if errorlevel 1 schtasks /run /tn "anc-patch-guard" >nul 2>&1

exit /b %RC%
