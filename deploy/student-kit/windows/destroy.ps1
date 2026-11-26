# Deletes ShopNow from this computer: the local MockPay and the minikube cluster, with all
# their data. The generated passwords in .secrets.env are kept for the next deploy.
$KitDir = $PSScriptRoot
$MkProfile = if ($env:MINIKUBE_PROFILE) { $env:MINIKUBE_PROFILE } else { "shopnow" }
$tools = Join-Path $KitDir "tools"
if (Test-Path (Join-Path $tools "minikube.exe")) { $env:Path = "$tools;$env:Path" }
$answer = Read-Host "Delete the '$MkProfile' minikube cluster and ALL ShopNow data on this computer? [y/N]"
if ($answer -notmatch '^[yY]') { Write-Host "cancelled"; exit 0 }
$ErrorActionPreference = "Continue"
$mockpayEnv = Join-Path $KitDir ".mockpay.env"
if (Test-Path $mockpayEnv) {
  docker compose -f (Join-Path $KitDir "local\mockpay-compose.yml") --env-file $mockpayEnv down -v 2>&1 | ForEach-Object { "$_" }
}
minikube -p $MkProfile delete 2>&1 | ForEach-Object { "$_" }
