@echo off
rem ====================================================================
rem  ImaTask - clasp push & deploy (template)
rem  - Uploads source files via clasp push
rem  - Then updates the existing deployment specified by DEPLOY_ID
rem
rem  First-time setup:
rem    1) Copy this file to deploy.bat
rem    2) Run "clasp deploy" once manually (without -i) to get a Deployment ID
rem    3) Set the ID into DEPLOY_ID below
rem ====================================================================

setlocal EnableDelayedExpansion

rem --- Set the Deployment ID for this project ---
set DEPLOY_ID=__SET_IMATASK_DEPLOY_ID__

cd /d "%~dp0"

if "%DEPLOY_ID%"=="__SET_IMATASK_DEPLOY_ID__" (
  echo [ERROR] DEPLOY_ID is not set.
  echo         Edit deploy.bat and set DEPLOY_ID to the Deployment ID
  echo         of the ImaTask web app.
  echo         For the first time, run "clasp deploy" to obtain it.
  goto :end
)

rem Prefer clasp.cmd to avoid PowerShell wrapper killing the shell
set CLASP_CMD=clasp
where clasp.cmd >nul 2>&1
if %ERRORLEVEL% EQU 0 set CLASP_CMD=clasp.cmd

echo ==== [1/2] clasp push (ImaTask) ====
call %CLASP_CMD% push
set RC=%ERRORLEVEL%
if !RC! NEQ 0 (
  echo.
  echo [ERROR] push failed. exit code=!RC!
  goto :end
)

echo.
echo ==== [2/2] clasp deploy (ImaTask) ====
call %CLASP_CMD% deploy -i %DEPLOY_ID% -d "auto-deploy ImaTask"
set RC=%ERRORLEVEL%
if !RC! NEQ 0 (
  echo.
  echo [ERROR] deploy failed. exit code=!RC!
  goto :end
)

echo.
echo [OK] ImaTask push and deploy completed.

:end
echo.
echo ----- Press any key to close -----
pause >nul
endlocal
