@echo off
setlocal
echo ===================================================
echo  Route Studio - local delivery simulator
echo ===================================================

where python >nul 2>nul || (echo Python 3.10+ is required: https://www.python.org/downloads/ & pause & exit /b 1)
where npm >nul 2>nul || (echo Node.js 20.19+ is required: https://nodejs.org/ & pause & exit /b 1)

echo Installing backend requirements (first run only takes a minute)...
python -m pip install -q -r "%~dp0backend\requirements.txt"

if not exist "%~dp0frontend\node_modules" (
  echo Installing frontend packages...
  pushd "%~dp0frontend" & call npm install --no-audit --no-fund & popd
)

echo Backend API:  http://127.0.0.1:8060
echo Frontend UI:  http://localhost:5173
start "Route Studio Backend" cmd /k "cd /d %~dp0backend && python run.py"
start "Route Studio Frontend" cmd /k "cd /d %~dp0frontend && npm run dev"
timeout /t 4 >nul
start "" http://localhost:5173
