@echo off
setlocal
cd /d "%~dp0"
set "FORMDIGITAL_TESSERACT_HOME=%LOCALAPPDATA%\Formdigital\Tesseract-OCR"
if exist "%FORMDIGITAL_TESSERACT_HOME%\tesseract.exe" set "PATH=%FORMDIGITAL_TESSERACT_HOME%;%PATH%"
if not exist local-service-config.json node setup-local-service.mjs
node local-data-service.mjs
