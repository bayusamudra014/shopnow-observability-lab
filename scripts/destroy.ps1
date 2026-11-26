<#
.SYNOPSIS
  Removes the lab. Stops the Compose projects first (they are attached to minikube's
  Docker network), then deletes the minikube cluster.

    .\scripts\destroy.ps1              # stop everything, delete the cluster
    .\scripts\destroy.ps1 -KeepCluster # only stop the Compose projects
    .\scripts\destroy.ps1 -Volumes     # also delete the provider's database volume
#>
[CmdletBinding()]
param([switch]$KeepCluster, [switch]$Volumes)

$ErrorActionPreference = "Continue"
$Root = Split-Path -Parent $PSScriptRoot
foreach ($v in "DOCKER_TLS_VERIFY", "DOCKER_HOST", "DOCKER_CERT_PATH", "MINIKUBE_ACTIVE_DOCKERD") { Remove-Item "Env:$v" -ErrorAction SilentlyContinue }

$down = @("down", "--remove-orphans")
if ($Volumes) { $down += "--volumes" }
Write-Host "==> Stopping traffic generator" -ForegroundColor Cyan
docker compose -f (Join-Path $Root "tools/traffic-generator/docker-compose.yml") @down
Write-Host "==> Stopping payment provider" -ForegroundColor Cyan
docker compose -f (Join-Path $Root "external/payment-provider/docker-compose.yml") @down

if (-not $KeepCluster) {
  Write-Host "==> Deleting minikube cluster" -ForegroundColor Cyan
  minikube delete
}
