@echo off
setlocal EnableExtensions
title PHP Station - band karein
rem Stops ONLY the PHP Station panel. Projects and DB servers keep running.
rem Node lookup is the same as in PHP-Station.bat (runtimes\node first).

set "NODE="
if exist "%~dp0runtimes\node\node.exe" set "NODE=%~dp0runtimes\node\node.exe"
if not defined NODE for /f "delims=" %%i in ('where node.exe 2^>nul') do if not defined NODE set "NODE=%%i"
if not defined NODE if exist "C:\nvm4w\nodejs\node.exe" set "NODE=C:\nvm4w\nodejs\node.exe"
if not defined NODE goto nonode

echo PHP Station band ho raha hai...
"%NODE%" "%~dp0server.js" --stop
echo.
echo  Note: sirf panel band hota hai. Jo projects aur DB servers chal rahe hain
echo  wo chalte rahenge. Unhein band karna ho to pehle PHP Station kholein aur
echo  wahan se Stop karein.
echo  (Only the panel stops. Running projects and DB servers keep running.)
echo.
pause
endlocal
exit /b 0

:nonode
echo.
echo  Node.js nahi mila, is liye PHP Station band nahi kiya ja saka.
echo  (Node.js was not found, so PHP Station could not be stopped.)
echo  PHP-Station.bat chalayein - wo Node.js ka intezam kar dega.
echo.
pause
endlocal
exit /b 1
