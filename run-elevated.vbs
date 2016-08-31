Set Shell = CreateObject("Shell.Application")

Set ArgObj = WScript.Arguments
bat = ArgObj(0)
exe = ArgObj(1)
src = ArgObj(2)
dst = ArgObj(3)
sysroot = ArgObj(4)

' lol looks crazy
Shell.ShellExecute "cmd", "/c """"" & bat & """ """ & exe & """ """ & src & """ """ & dst & """ """ & sysroot & """""", , "runas", 0
