@echo off
rem Runs destroy.ps1 without changing the PowerShell execution policy.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0destroy.ps1" %*
if "%~1"=="" pause
