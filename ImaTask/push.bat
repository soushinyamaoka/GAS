@echo off
rem ====================================================================
rem  ImaTask - clasp push only
rem  Uploads source files to GAS without updating any deployment.
rem  Use this when you only want to test the latest code in GAS editor.
rem ====================================================================

setlocal EnableDelayedExpansion

cd /d "%~dp0"

echo ==== clasp push (ImaTask) ====
echo.

rem Prefer clasp.cmd to avoid PowerShell wrapper killing the shell
set CLASP_CMD=clasp
where clasp.cmd >nul 2>&1
if %ERRORLEVEL% EQU 0 set CLASP_CMD=clasp.cmd

call %CLASP_CMD% push
set RC=%ERRORLEVEL%

echo.
if !RC! NEQ 0 (
  echo [ERROR] push failed. exit code=!RC!
) else (
  echo [OK] ImaTask push completed.
)

echo.
echo ----- Press any key to close -----
pause >nul
endlocal
