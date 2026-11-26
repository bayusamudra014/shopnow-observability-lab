# Shows the state of ShopNow on this computer: minikube, pods, hosts and the local MockPay.
$KitDir = $PSScriptRoot
$MkProfile = if ($env:MINIKUBE_PROFILE) { $env:MINIKUBE_PROFILE } else { "shopnow" }
$tools = Join-Path $KitDir "tools"
if (Test-Path (Join-Path $tools "minikube.exe")) { $env:Path = "$tools;$env:Path" }
$ErrorActionPreference = "Continue"
function H([string]$m) { Write-Host "`n==> $m" -ForegroundColor Cyan }
H "minikube ($MkProfile)"
minikube -p $MkProfile status 2>&1 | ForEach-Object { "$_" }
foreach ($ns in "shop", "infra", "platform") {
  H "pods in $ns"
  kubectl --context $MkProfile -n $ns get pods 2>&1 | ForEach-Object { "$_" }
}
H "ingresses"
kubectl --context $MkProfile get ingress -A 2>&1 | ForEach-Object { "$_" }
$mockpayEnv = Join-Path $KitDir ".mockpay.env"
if (Test-Path $mockpayEnv) {
  H "local payment provider (MockPay)"
  docker compose -f (Join-Path $KitDir "local\mockpay-compose.yml") --env-file $mockpayEnv ps 2>&1 | ForEach-Object { "$_" }
}
