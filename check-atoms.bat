@echo off
REM Checks every game atom Garden Companion hooks against the newest captured bundle.
cd /d "%~dp0"
call npm run check-atoms -- %*
pause
