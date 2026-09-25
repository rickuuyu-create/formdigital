@echo off
setlocal
rem Formdigital WB-01 Windows local development launcher.
rem Resolve everything from this batch file, never from the caller's cwd.
pushd "%~dp0"
if errorlevel 1 (
  endlocal
  exit /b 1
)
node "%~dp0scripts\start-dev-runtime.mjs"
set "FORMDIGITAL_EXIT_CODE=%ERRORLEVEL%"
popd
endlocal & exit /b %FORMDIGITAL_EXIT_CODE%
