echo off

set exe=%1
set src=%2
set dst=%3
set sysroot=%4

ping -n 2 127.0.0.1
xcopy /e /y /i %src% %dst%
rmdir /s /q %src%

if [%sysroot%] NEQ [] (
  start "" %sysroot%\ie4uinit.exe -ClearIconCache
  start "" %sysroot%\ie4uinit.exe -show
)

start "" %exe%
