@echo off
setlocal
cd /d "%~dp0"
set "FORMDIGITAL_TESSERACT_HOME=%LOCALAPPDATA%\Formdigital\Tesseract-OCR"
if exist "%FORMDIGITAL_TESSERACT_HOME%\tesseract.exe" set "PATH=%FORMDIGITAL_TESSERACT_HOME%;%PATH%"
node local-data-service.mjs > local-service-startup.log 2>&1
