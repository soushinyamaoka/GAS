@echo off
chcp 65001 >nul
setlocal

cd /d "%~dp0"

echo ==== clasp push ====
call clasp push -f
set RC=%ERRORLEVEL%

echo.
if %RC% NEQ 0 (
  echo [ERROR] push failed. exit code=%RC%
) else (
  echo [OK] push done.
)

echo.
pause
endlocal
