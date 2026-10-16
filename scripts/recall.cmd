@echo off
rem Start Recall on Windows. Double-click this file, or create a shortcut to it.
rem   recall.cmd            start Recall, or open the running one
rem   recall.cmd --stop     stop Recall
rem Other options: --port N, --data-dir DIR, --no-open
setlocal
cd /d "%~dp0.."

set "NODE="
for %%N in (node.exe) do set "NODE=%%~$PATH:N"
if not defined NODE if exist "%ProgramFiles%\nodejs\node.exe" set "NODE=%ProgramFiles%\nodejs\node.exe"
if not defined NODE if exist "%LOCALAPPDATA%\Programs\nodejs\node.exe" set "NODE=%LOCALAPPDATA%\Programs\nodejs\node.exe"
if not defined NODE if exist "%LOCALAPPDATA%\Volta\bin\node.exe" set "NODE=%LOCALAPPDATA%\Volta\bin\node.exe"
if not defined NODE if exist "%NVM_SYMLINK%\node.exe" set "NODE=%NVM_SYMLINK%\node.exe"

if not defined NODE (
  echo.
  echo   Recall needs Node.js 24 to run, and it is not installed.
  echo   Download Node.js 24 LTS from https://nodejs.org and run the installer, then start Recall again.
  echo.
  start "" "https://nodejs.org/en/download"
  pause
  exit /b 1
)

"%NODE%" -e "const [a,b]=process.versions.node.split('.').map(Number);process.exit(a>22||(a===22&&b>=18)?0:1)"
if errorlevel 1 (
  echo.
  echo   Recall needs Node.js 24 to run. This computer has an older Node.js:
  "%NODE%" -v
  echo   Download Node.js 24 LTS from https://nodejs.org and run the installer, then start Recall again.
  echo.
  start "" "https://nodejs.org/en/download"
  pause
  exit /b 1
)

"%NODE%" server\launcher.ts %*
if errorlevel 1 pause
