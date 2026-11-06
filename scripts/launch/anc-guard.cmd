@echo off
REM anc-patch-guard: run the patch guard every minute (via run-hidden.vbs, no console window).
REM Deployed to %ProgramData%\anc\bin\anc-guard.cmd. ASCII only: cmd.exe reads .cmd in the OEM code page.
powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "%ProgramData%\anc\bin\patch-guard.ps1"
