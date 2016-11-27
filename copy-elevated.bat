echo off

set exe=%1
set src=%2
set dst=%3
set sysroot=%4

ping -n 2 127.0.0.1

xcopy /e /y /i "%src%" "%dst%"
set xcopy_result=%errorlevel%

rmdir /s /q "%src%"

if [%sysroot%] NEQ [] (
  if exist %sysroot%\ie4uinit.exe (
    start "" "%sysroot%\ie4uinit.exe" -ClearIconCache
    start "" "%sysroot%\ie4uinit.exe" -show
  )
)

start "" "%exe%" --install-result=%xcopy_result%
