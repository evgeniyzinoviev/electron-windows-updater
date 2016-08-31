echo off

set exe=%1
set src=%2
set dst=%3
set sysroot=%4

ping -n 2 127.0.0.1
xcopy /e /y /i %src% %dst%
rmdir /s /q %src%

for /f "tokens=4-5 delims=. " %%i in ('ver') do set VERSION=%%i.%%j
if "%version%" == "10.0" (
  start "" %sysroot%\ie4uinit.exe -show
) else (
  start "" %sysroot%\ie4uinit.exe -ClearIconCache
)

start "" %exe%
