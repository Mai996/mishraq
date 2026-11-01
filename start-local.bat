@echo off
start "" http://localhost:4173/
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0serve.ps1" -Port 4173
