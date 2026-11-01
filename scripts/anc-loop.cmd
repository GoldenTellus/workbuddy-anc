@echo off
REM Local service: one tick per minute.
REM Do NOT pin --webhook-file here: production picks the webhook per chat binding.
REM Use --webhook-file + --chat-id only for single-chat debugging.
REM NOTE: do not call schtasks from here. Under LOCAL SERVICE that request is
REM refused (0x800710E0) and it also dirties this task's exit code. Recovery is
REM the guard's job; it carries its own once/repeating trigger.
"C:\Program Files\nodejs\node.exe" "C:\ProgramData\anc\service\cli.ts" loop --once --db "C:\ProgramData\anc\data\anc.db" >> "C:\ProgramData\anc\data\loop.log" 2>&1
exit /b %ERRORLEVEL%
