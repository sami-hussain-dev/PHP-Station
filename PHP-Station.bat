@echo off
setlocal EnableExtensions
title PHP Station
rem PHP Station launcher: starts the panel (if it is not running yet) and opens the app window.
rem Node is looked up in this order: <PHP Station>\runtimes\node\node.exe, "where node",
rem C:\nvm4w\nodejs\node.exe. If none is found, PHP Station offers to download the portable
rem Node.js LTS from nodejs.org into <PHP Station>\runtimes\node (tools\get-node.ps1).

if not exist "%~dp0server.js" goto noserver

:findnode
set "NODE="
if exist "%~dp0runtimes\node\node.exe" set "NODE=%~dp0runtimes\node\node.exe"
if not defined NODE for /f "delims=" %%i in ('where node.exe 2^>nul') do if not defined NODE set "NODE=%%i"
if not defined NODE if exist "C:\nvm4w\nodejs\node.exe" set "NODE=C:\nvm4w\nodejs\node.exe"
if not defined NODE goto nonode

echo PHP Station khul raha hai, zara intezar karein...
"%NODE%" "%~dp0server.js" --launch
if errorlevel 1 goto failed
endlocal
exit /b 0

:nonode
if defined DP_NODE_TRIED goto nodefailed
echo.
echo  Node.js nahi mila. PHP Station chalane ke liye Node.js zaroori hai.
echo  (Node.js was not found. PHP Station needs Node.js to run.)
echo.
echo  PHP Station nodejs.org se Node.js LTS ka portable version download kar ke
echo  sirf is folder me rakh sakta hai: %~dp0runtimes\node
echo  Admin ki zaroorat nahi, system PATH nahi badalta, SHA-256 check hota hai.
echo  (PHP Station can download the portable Node.js LTS from nodejs.org into this
echo   folder only. No admin rights, no PATH change, the SHA-256 is verified.)
echo.
choice /c YN /n /m " Download karein? / Download now? [Y/N] "
if errorlevel 2 goto nodeno
set "DP_NODE_TRIED=1"
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0tools\get-node.ps1"
if errorlevel 1 goto nodefailed
goto findnode

:nodeno
echo.
echo  Theek hai. Node.js khud install karein: https://nodejs.org/
echo  (OK. Please install Node.js yourself: https://nodejs.org/ )
echo  Phir PHP-Station.bat dobara double-click karein. (Then run PHP-Station.bat again.)
echo.
pause
endlocal
exit /b 1

:nodefailed
echo.
echo  Node.js tayyar nahi ho saka. Internet check karein, ya khud install karein:
echo  https://nodejs.org/
echo  (Node.js could not be set up. Check the internet connection, or install it
echo   yourself from https://nodejs.org/ and run PHP-Station.bat again.)
echo.
pause
endlocal
exit /b 1

:noserver
echo.
echo  server.js is folder me nahi mila: %~dp0
echo  PHP Station ki files poori nahi hain.
echo  (server.js is missing in this folder - the PHP Station files are incomplete.)
echo.
pause
endlocal
exit /b 1

:failed
echo.
echo  PHP Station start nahi ho saka.
echo  Tafseel ke liye ye log file dekhein: %~dp0data\logs\panel.log
echo  (PHP Station did not start. See the log file above for details.)
echo.
pause
endlocal
exit /b 1
