@echo off
rem Runs deploy.ps1 without changing the PowerShell execution policy.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0deploy.ps1" %*
if "%~1"=="" pause
