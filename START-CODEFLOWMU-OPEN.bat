@echo off
setlocal
cd /d "%~dp0"

echo.
echo ============================================================
echo CodeFlowMu Open Dev Team Edition
echo ============================================================
echo Working directory: %CD%
echo Version: V1.1.24-open
echo Default URL: http://127.0.0.1:18765/
echo Install policy: one standard CodeFlowMu Open install per computer. Default path: D:\CodeFlowMu-open.
echo Update policy: full replacement update; preserves .git, node_modules, .venv, projects, legacy workspace projects, and external projects.
echo.

if not exist ".codeflowmu" mkdir ".codeflowmu"
if not exist ".codeflowmu\open-runtime-initialized.flag" (
  echo [init] Preparing clean open-edition runtime state...
  if exist "fcop\ledger" rmdir /s /q "fcop\ledger"
  if exist "fcop\chat" rmdir /s /q "fcop\chat"
  if exist "fcop\logs" rmdir /s /q "fcop\logs"
  if exist "fcop\reports" rmdir /s /q "fcop\reports"
  if exist "fcop\tasks" rmdir /s /q "fcop\tasks"
  if exist "fcop\issues" rmdir /s /q "fcop\issues"
  if exist "fcop\reviews" rmdir /s /q "fcop\reviews"
  if exist "fcop\_lifecycle" rmdir /s /q "fcop\_lifecycle"
  if exist ".codeflowmu\report-watcher" rmdir /s /q ".codeflowmu\report-watcher"
  if exist ".codeflowmu\pm-skills.manifest.json" del /q ".codeflowmu\pm-skills.manifest.json"
  if defined USERPROFILE if exist "%USERPROFILE%\.codeflowmu\projects\codeflowmu-open" rmdir /s /q "%USERPROFILE%\.codeflowmu\projects\codeflowmu-open"
  > ".codeflowmu\open-runtime-initialized.flag" echo initialized
)

where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js was not found.
  echo Install Node.js 22 or newer, then run this launcher again.
  echo https://nodejs.org/
  pause
  exit /b 1
)

where npm >nul 2>nul
if errorlevel 1 (
  echo [ERROR] npm was not found.
  echo Reinstall Node.js with npm enabled, then run this launcher again.
  pause
  exit /b 1
)

if not exist ".venv\Scripts\python.exe" (
  echo [setup] Creating local Python virtual environment: .venv
  where py >nul 2>nul
  if not errorlevel 1 (
    py -3.10 -m venv .venv 2>nul || py -3 -m venv .venv
  ) else (
    where python >nul 2>nul
    if errorlevel 1 (
      echo [ERROR] Python 3.10+ was not found.
      echo Install Python from https://www.python.org/downloads/
      echo Make sure "Add python.exe to PATH" is enabled.
      pause
      exit /b 1
    )
    python -m venv .venv
  )
)

if not exist ".venv\Scripts\python.exe" (
  echo [ERROR] Failed to create .venv.
  pause
  exit /b 1
)

set "PYTHON_BIN=%CD%\.venv\Scripts\python.exe"
set "CODEFLOW_PROVIDER=cursor"

"%PYTHON_BIN%" -m pip show fcop >nul 2>nul
if errorlevel 1 (
  echo [setup] Installing Python dependency: fcop
  "%PYTHON_BIN%" -m pip install -U pip
  if errorlevel 1 (
    echo [ERROR] pip upgrade failed.
    pause
    exit /b 1
  )
  "%PYTHON_BIN%" -m pip install fcop
  if errorlevel 1 (
    echo [ERROR] Failed to install fcop.
    pause
    exit /b 1
  )
)

"%PYTHON_BIN%" -m pip show fcop-mcp >nul 2>nul
if errorlevel 1 (
  echo [setup] Installing Python dependency: fcop-mcp
  "%PYTHON_BIN%" -m pip install fcop-mcp
  if errorlevel 1 (
    echo [ERROR] Failed to install fcop-mcp.
    pause
    exit /b 1
  )
)

if exist "packagescodeflowmu-runtimesrcwindows-usehostequirements.txt" (
  "%PYTHON_BIN%" -m pip show pywinauto >nul 2>nul
  if errorlevel 1 (
    echo [setup] Installing optional Windows Use dependencies
    "%PYTHON_BIN%" -m pip install -r "packagescodeflowmu-runtimesrcwindows-usehostequirements.txt"
    if errorlevel 1 (
      echo [WARN] Windows Use dependencies failed to install. Core CodeFlowMu can still start.
    )
  )
)

if not exist "node_modules" (
  echo [setup] Installing Node dependencies...
  call npm install
  if errorlevel 1 (
    echo [ERROR] npm install failed.
    pause
    exit /b 1
  )
)

echo.
echo [start] Opening CodeFlowMu Open Dev Team Edition
echo [start] URL: http://127.0.0.1:18765/
echo [guide] First run: open Settings - General, enter and verify Cursor API Key, then open Settings - Projects to initialize your development project.
echo.
call npm start
