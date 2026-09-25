@echo off
setlocal
rem Formdigital local production runtime. Uses existing dist only; never starts dev.
pushd "%~dp0"
if errorlevel 1 (
  endlocal
  exit /b 1
)
node "%~dp0scripts\start-production-runtime.mjs"
set "FORMDIGITAL_EXIT_CODE=%ERRORLEVEL%"
popd
endlocal & exit /b %FORMDIGITAL_EXIT_CODE%
