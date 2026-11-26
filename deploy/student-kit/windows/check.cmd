@echo off
rem Runs check.ps1 without changing the PowerShell execution policy.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0check.ps1" %*
if "%~1"=="" pause
