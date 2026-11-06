@echo off
REM anc-workbuddy-launch: start WorkBuddy with the patch at logon (via run-hidden.vbs).
REM Deployed to %ProgramData%\anc\bin\anc-launch.cmd. Must point at the deployed patch dir,
REM never at a git working copy (switching branches there would change the live patch).
powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "%ProgramData%\anc\patch\launch-patched.ps1"
