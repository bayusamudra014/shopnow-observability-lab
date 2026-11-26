<#
.SYNOPSIS
  ShopNow incident challenges: check which tickets (TICKETS.md) are fixed.

.DESCRIPTION
  Double-click check.cmd, or run:  powershell -ExecutionPolicy Bypass -File .\check.ps1
  The check runs inside the cluster (a short-lived Job, read-only) and changes nothing.
  Send its output to your instructor.
#>
$ErrorActionPreference = "Stop"
$tools = Join-Path $PSScriptRoot "tools"
if (Test-Path (Join-Path $tools "kubectl.exe")) { $env:Path = "$tools;$env:Path" }
$ctx = if ($env:MINIKUBE_PROFILE) { $env:MINIKUBE_PROFILE } else { "shopnow" }
# Native command output as plain text (Windows PowerShell turns stderr lines into errors).
function Kube { $saved = $ErrorActionPreference; $ErrorActionPreference = "Continue"; & kubectl --context $ctx @args 2>&1 | ForEach-Object { "$_" }; $ErrorActionPreference = $saved }

Kube -n shop get cronjob lab-check | Out-Null
if ($LASTEXITCODE -ne 0) { Write-Host "the checker is not installed: run deploy.cmd first" -ForegroundColor Red; exit 1 }
$job = "lab-check-$([DateTimeOffset]::UtcNow.ToUnixTimeSeconds())"
try {
  Kube -n shop create job $job --from=cronjob/lab-check | Out-Null
  Kube -n shop wait --for=condition=Ready pod -l "job-name=$job" --timeout=180s | Out-Null
  Kube -n shop logs -f "job/$job" --pod-running-timeout=180s | ForEach-Object { Write-Host $_ }
} finally {
  Kube -n shop delete job $job --ignore-not-found --wait=false | Out-Null
}
