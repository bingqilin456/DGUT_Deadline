@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"

rem DSH injects NODE_OPTIONS and ELECTRON_RUN_AS_NODE on this machine; both break
rem Electron startup (see AGENTS.md section 6). set "VAR=" deletes the variable.
set "NODE_OPTIONS="
set "ELECTRON_RUN_AS_NODE="

if not exist "node_modules" (
  echo First run: installing dependencies...
  call npm install || goto :fail
)

echo Starting DGUT Deadline...
call npm run dev
if errorlevel 1 goto :fail
goto :end

:fail
echo.
echo Startup failed - see the error output above.

:end
endlocal
pause
