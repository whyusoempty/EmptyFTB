@echo off
cd /d "%~dp0"
node src\cli.js ui
if errorlevel 1 pause
