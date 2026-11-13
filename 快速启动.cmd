@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"

rem Same env cleanup as the dev launcher (see AGENTS.md section 6).
set "NODE_OPTIONS="
set "ELECTRON_RUN_AS_NODE="

rem Fast path: run the prebuilt out/ bundle (no dev server, no rebuild).
if not exist "out\main\index.js" (
  echo No build found. Building first...
  if not exist "node_modules" call npm install
  call npm run build || goto :fail
)

echo Starting DGUT Deadline (prebuilt)...
call npx electron .
if errorlevel 1 goto :fail
goto :end

:fail
echo.
echo Startup failed - see the error output above.

:end
endlocal
pause
