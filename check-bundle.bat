@echo off
REM Pulls the live game bundle into bundles\ and checks it for drift against what
REM Garden Companion sends and reads. Pass --dir bundles\bundle-VERSION-DATE to check offline.
cd /d "%~dp0"
call npm run check-bundle -- %*
pause
