Set Shell = CreateObject("Shell.Application")

Set ArgObj = WScript.Arguments
exe = ArgObj(0)
dst = ArgObj(1)
newexe = ArgObj(2)

Shell.ShellExecute exe, "--ewu-install """ & dst & """ """ & newexe & """", , "runas", 0
