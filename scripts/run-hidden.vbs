' 隐藏启动：wscript //B run-hidden.vbs "命令或 .cmd 路径"
' 计划任务用它包一层，避免每次触发都闪一个控制台窗口
If WScript.Arguments.Count = 0 Then WScript.Quit 2
Set sh = CreateObject("WScript.Shell")
sh.Run WScript.Arguments(0), 0, False
