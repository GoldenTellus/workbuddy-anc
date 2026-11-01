@echo off
REM 本地小服务每分钟一次 tick。不要在这里钉死 --webhook-file：
REM 生产按群里绑定表的 webhook_file 逐个选；只有联调单群时才用 --webhook-file + --chat-id。
"C:\Program Files\nodejs\node.exe" "%ProgramData%\anc\service\cli.ts" loop --once --db "%ProgramData%\anc\data\anc.db" >> "%ProgramData%\anc\data\loop.log" 2>&1
exit /b %ERRORLEVEL%
