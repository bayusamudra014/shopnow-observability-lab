<#
.SYNOPSIS
  Shows the state of the lab: minikube, pods per namespace, ingresses and the Compose projects.
#>
$Root = Split-Path -Parent $PSScriptRoot
foreach ($v in "DOCKER_TLS_VERIFY", "DOCKER_HOST", "DOCKER_CERT_PATH", "MINIKUBE_ACTIVE_DOCKERD") { Remove-Item "Env:$v" -ErrorAction SilentlyContinue }

Write-Host "==> minikube" -ForegroundColor Cyan
minikube status
foreach ($ns in "shop", "infra", "platform") {
  Write-Host "`n==> pods in $ns" -ForegroundColor Cyan
  kubectl --context minikube -n $ns get pods -o wide
}
Write-Host "`n==> ingresses" -ForegroundColor Cyan
kubectl --context minikube get ingress -A
Write-Host "`n==> external systems (Docker Compose)" -ForegroundColor Cyan
docker compose -f (Join-Path $Root "external/payment-provider/docker-compose.yml") ps
docker compose -f (Join-Path $Root "tools/traffic-generator/docker-compose.yml") ps
