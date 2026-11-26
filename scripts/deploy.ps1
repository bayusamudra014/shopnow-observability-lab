<#
.SYNOPSIS
  Deploys the whole observability lab: minikube + SigNoz + Kafka + the shop, and the two
  "outside" Docker Compose projects (payment provider, traffic generator).

.DESCRIPTION
  Safe to re-run: every step skips or updates what already exists.

    .\scripts\deploy.ps1                       # everything
    .\scripts\deploy.ps1 -SkipExternal         # only the cluster
    .\scripts\deploy.ps1 -Only catalog,order   # rebuild + restart just these services
    .\scripts\deploy.ps1 -SkipBuild            # re-apply manifests without building images

  Needs: Docker Desktop, minikube, kubectl, helm.
#>
[CmdletBinding()]
param(
  [switch]$SkipBuild,
  [switch]$SkipExternal,
  [string[]]$Only,
  [int]$Cpus = 6,
  [string]$Memory = "12g",
  [string]$DiskSize = "40g",
  [string]$StrimziVersion = "0.48.0"
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
$Ctx = "minikube"
$Services = @("api-gateway", "auth", "catalog", "cart", "order", "inventory", "payment", "notification")

function Step([string]$Message) { Write-Host "`n==> $Message" -ForegroundColor Cyan }
function Info([string]$Message) { Write-Host "    $Message" -ForegroundColor DarkGray }

# Run a native command and stop the script if it fails.
function Exec {
  param([Parameter(Mandatory)][scriptblock]$Command, [string]$What = "command")
  # Windows PowerShell turns any stderr line of a native tool (progress bars, warnings)
  # into an error record; with "Stop" that would abort. Judge by the exit code only.
  $saved = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  try {
    & $Command 2>&1 | ForEach-Object { if ($_ -is [System.Management.Automation.ErrorRecord]) { Write-Host $_.ToString() } else { $_ } }
  } finally {
    $ErrorActionPreference = $saved
  }
  if ($LASTEXITCODE -ne 0) { throw "$What failed (exit code $LASTEXITCODE)" }
}
function Kube {
  $kubeArgs = $args
  Exec { kubectl --context $Ctx @kubeArgs } "kubectl $($kubeArgs -join ' ')"
}

function Clear-MinikubeDockerEnv {
  foreach ($v in "DOCKER_TLS_VERIFY", "DOCKER_HOST", "DOCKER_CERT_PATH", "MINIKUBE_ACTIVE_DOCKERD") {
    Remove-Item "Env:$v" -ErrorAction SilentlyContinue
  }
}

# ---------------------------------------------------------------------------- preflight
Step "Checking prerequisites"
# winget installs helm without updating PATH for already-open terminals.
if (-not (Get-Command helm -ErrorAction SilentlyContinue)) {
  $wingetHelm = Get-ChildItem "$env:LOCALAPPDATA\Microsoft\WinGet\Packages" -Recurse -Filter helm.exe -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($wingetHelm) { $env:Path = "$($wingetHelm.DirectoryName);$env:Path" }
}
foreach ($tool in "docker", "minikube", "kubectl", "helm") {
  if (-not (Get-Command $tool -ErrorAction SilentlyContinue)) {
    throw "$tool is not installed or not on PATH. Install it (for example: winget install Helm.Helm) and run again."
  }
}
Clear-MinikubeDockerEnv
Exec { docker info --format "{{.ServerVersion}}" | Out-Null } "docker info (is Docker Desktop running?)"
$dockerMemGb = [math]::Round(([int64](docker info --format "{{.MemTotal}}")) / 1GB, 1)
Info "Docker Desktop has $dockerMemGb GB of memory"
$wantGb = [int]($Memory -replace "[^0-9]", "")
if ($dockerMemGb -lt ($wantGb + 1)) {
  Write-Warning "Docker has less than $($wantGb + 1) GB. Raise 'memory=' in %UserProfile%\.wslconfig, then run 'wsl --shutdown' and restart Docker Desktop."
}

# ------------------------------------------------------------------------------ cluster
Step "Starting minikube (driver=docker, $Cpus CPUs, $Memory memory)"
$hostState = (minikube status --format "{{.Host}}" 2>$null)
if ($hostState -ne "Running") {
  Exec { minikube start --driver=docker --container-runtime=docker --cpus=$Cpus --memory=$Memory --disk-size=$DiskSize } "minikube start"
} else {
  Info "minikube already running"
}
Exec { minikube addons enable ingress | Out-Null } "enable ingress addon"
Exec { minikube addons enable metrics-server | Out-Null } "enable metrics-server addon"
$MinikubeIp = (minikube ip).Trim()
$Prefix = ($MinikubeIp -split "\.")[0..2] -join "."
$ProviderIp = "$Prefix.100"
Info "minikube node IP $MinikubeIp, payment provider $ProviderIp"

# ------------------------------------------------------------------------------ secrets
Step "Preparing secrets (.secrets/secrets.env)"
$SecretsDir = Join-Path $Root ".secrets"
$SecretsFile = Join-Path $SecretsDir "secrets.env"
New-Item -ItemType Directory -Force $SecretsDir | Out-Null
$keys = "POSTGRES_PASSWORD", "SEED_USER_PASSWORD", "INSTRUCTOR_PASSWORD", "PROVIDER_DB_PASSWORD",
        "PROVIDER_API_KEY", "PROVIDER_WEBHOOK_SECRET", "PROVIDER_ADMIN_TOKEN", "TRAFFIC_CONTROL_TOKEN"
$S = @{}
if (Test-Path $SecretsFile) {
  foreach ($line in Get-Content $SecretsFile) { if ($line -match "^([A-Z_]+)=(.*)$") { $S[$Matches[1]] = $Matches[2] } }
}
$chars = [char[]]"abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789"
$changed = $false
foreach ($k in $keys) {
  if (-not $S[$k]) {
    $len = if ($k -like "*PASSWORD") { 16 } else { 32 }
    $S[$k] = -join (1..$len | ForEach-Object { $chars[(Get-Random -Maximum $chars.Length)] })
    $changed = $true
  }
}
if ($changed) {
  ($keys | ForEach-Object { "$_=$($S[$_])" }) | Set-Content -Encoding ascii $SecretsFile
  Info "generated new values in $SecretsFile"
} else {
  Info "reusing $SecretsFile"
}

Kube apply -f (Join-Path $Root "deploy/k8s/namespaces.yaml")
$shopSecret = kubectl --context $Ctx -n shop create secret generic shop-secrets --dry-run=client -o yaml `
  --from-literal=POSTGRES_PASSWORD=$($S.POSTGRES_PASSWORD) `
  --from-literal=SEED_USER_PASSWORD=$($S.SEED_USER_PASSWORD) `
  --from-literal=INSTRUCTOR_PASSWORD=$($S.INSTRUCTOR_PASSWORD) `
  --from-literal=PROVIDER_API_KEY=$($S.PROVIDER_API_KEY) `
  --from-literal=PROVIDER_WEBHOOK_SECRET=$($S.PROVIDER_WEBHOOK_SECRET)
$shopSecret | kubectl --context $Ctx apply -f - | Out-Null
$pgSecret = kubectl --context $Ctx -n infra create secret generic postgres-credentials --dry-run=client -o yaml `
  --from-literal=POSTGRES_PASSWORD=$($S.POSTGRES_PASSWORD)
$pgSecret | kubectl --context $Ctx apply -f - | Out-Null

# ------------------------------------------------------------------- operators / charts
if (-not $Only) {
  Step "Installing Strimzi operator $StrimziVersion (Kafka)"
  Exec { helm upgrade --install strimzi oci://quay.io/strimzi-helm/strimzi-kafka-operator --version $StrimziVersion `
      --kube-context $Ctx -n infra --wait --timeout 10m } "helm install strimzi"

  Step "Installing SigNoz (this takes a few minutes the first time)"
  Exec { helm repo add signoz https://charts.signoz.io --force-update | Out-Null } "helm repo add signoz"
  Exec { helm repo update signoz | Out-Null } "helm repo update"
  Exec { helm upgrade --install signoz signoz/signoz --kube-context $Ctx -n platform `
      -f (Join-Path $Root "deploy/helm/signoz-values.yaml") --wait --timeout 20m } "helm install signoz"
  Exec { helm upgrade --install k8s-infra signoz/k8s-infra --kube-context $Ctx -n platform `
      -f (Join-Path $Root "deploy/helm/k8s-infra-values.yaml") --wait --timeout 10m } "helm install k8s-infra"
}

# ------------------------------------------------------------------------------- images
$toBuild = if ($Only) { $Only } else { $Services + "frontend" }
if (-not $SkipBuild) {
  # With the docker runtime we build straight into minikube's Docker daemon. Clusters
  # created with containerd (minikube's newer default) get host-built images loaded instead.
  $runtime = kubectl --context $Ctx get nodes -o "jsonpath={.items[0].status.nodeInfo.containerRuntimeVersion}"
  $direct = "$runtime" -like "docker://*"
  Step "Building images ($(if ($direct) { "inside minikube's Docker" } else { "on the host, then minikube image load" })): $($toBuild -join ', ')"
  if ($direct) { Exec { minikube -p minikube docker-env --shell powershell } "minikube docker-env" | Invoke-Expression }
  try {
    foreach ($svc in $toBuild) {
      Info "shop/${svc}:dev"
      if ($svc -eq "frontend") {
        Exec { docker build -q -t "shop/frontend:dev" (Join-Path $Root "apps/frontend") | Out-Null } "build frontend"
      } else {
        Exec { docker build -q -t "shop/${svc}:dev" --build-arg "WORKSPACE=services/$svc" $Root | Out-Null } "build $svc"
      }
      if (-not $direct) { Exec { minikube image load --overwrite=true "shop/${svc}:dev" } "load $svc into minikube" }
    }
  } finally {
    Clear-MinikubeDockerEnv
  }
}

# ---------------------------------------------------------------------------- manifests
Step "Applying Kubernetes manifests (deploy/k8s)"
Kube apply -k (Join-Path $Root "deploy/k8s")
# Point the "external" Services at the Compose containers' IPs on the minikube network.
# (Re-applied from the file via stdin: Windows PowerShell mangles JSON in native arguments.)
$slice = (Get-Content -Raw (Join-Path $Root "deploy/k8s/external/endpoints.yaml")) -replace "192\.168\.49\.100", $ProviderIp
Exec { $slice | kubectl --context $Ctx apply -f - } "kubectl apply payment-provider endpoints"

if (-not $SkipBuild) {
  # Same ":dev" tag, new image: restart so pods pick it up.
  foreach ($svc in $toBuild) { Kube -n shop rollout restart "deployment/$svc" | Out-Null }
}

Step "Waiting for infrastructure"
Kube -n infra rollout status statefulset/postgres --timeout=300s
Kube -n infra rollout status deployment/redis --timeout=300s
Kube -n infra rollout status deployment/mailpit --timeout=300s
Info "waiting for Kafka (first start can take ~3 minutes)"
Kube -n infra wait kafka/kafka --for=condition=Ready --timeout=600s

Step "Waiting for shop services"
foreach ($svc in $Services + "frontend") { Kube -n shop rollout status "deployment/$svc" --timeout=600s }

# ----------------------------------------------------------------------------- external
if (-not $SkipExternal) {
  Step "Starting the external systems (Docker Compose, outside minikube)"
  Clear-MinikubeDockerEnv
  @(
    "PROVIDER_DB_PASSWORD=$($S.PROVIDER_DB_PASSWORD)",
    "PROVIDER_API_KEY=$($S.PROVIDER_API_KEY)",
    "PROVIDER_WEBHOOK_SECRET=$($S.PROVIDER_WEBHOOK_SECRET)",
    "PROVIDER_ADMIN_TOKEN=$($S.PROVIDER_ADMIN_TOKEN)",
    "MINIKUBE_IP=$MinikubeIp",
    "PROVIDER_IP=$ProviderIp"
  ) | Set-Content -Encoding ascii (Join-Path $Root "external/payment-provider/.env")
  @(
    "SEED_USER_PASSWORD=$($S.SEED_USER_PASSWORD)",
    "CONTROL_TOKEN=$($S.TRAFFIC_CONTROL_TOKEN)",
    "PROVIDER_ADMIN_TOKEN=$($S.PROVIDER_ADMIN_TOKEN)",
    "MINIKUBE_IP=$MinikubeIp",
    "PROVIDER_IP=$ProviderIp"
  ) | Set-Content -Encoding ascii (Join-Path $Root "tools/traffic-generator/.env")
  Exec { docker compose -f (Join-Path $Root "external/payment-provider/docker-compose.yml") up -d --build --wait } "payment provider compose"
  Exec { docker compose -f (Join-Path $Root "tools/traffic-generator/docker-compose.yml") up -d --build --wait } "traffic generator compose"
}

# ---------------------------------------------------------------------------- smoke test
Step "Smoke tests"
# Probes report failures themselves; a stderr line must not abort the script here.
$ErrorActionPreference = "Continue"
$curl = "curlimages/curl:8.11.1"
Exec { docker pull -q $curl | Out-Null } "docker pull $curl"
function Probe([string]$Name, [string[]]$CurlArgs) {
  # Windows PowerShell 5.1 drops embedded double quotes from native arguments.
  if ($PSVersionTable.PSVersion.Major -lt 7) { $CurlArgs = $CurlArgs | ForEach-Object { $_ -replace '"', '\"' } }
  $out = docker run --rm --network minikube --add-host "shop.local:$MinikubeIp" --add-host "otlp.local:$MinikubeIp" $curl -s -o /dev/null -w "%{http_code}" @CurlArgs
  $ok = $out -match "^2"
  Write-Host ("    {0,-48} {1}" -f $Name, $(if ($ok) { "OK ($out)" } else { "FAILED ($out)" })) -ForegroundColor $(if ($ok) { "Green" } else { "Red" })
}
Probe "storefront  http://shop.local/" @("http://shop.local/")
Probe "catalog     GET /api/catalog/products" @("http://shop.local/api/catalog/products?limit=1")
$tokenBody = "{`"grant_type`":`"password`",`"username`":`"shopper001`",`"password`":`"$($S.SEED_USER_PASSWORD)`",`"client_id`":`"deploy-smoke-test`"}"
Probe "auth        POST /api/auth/oauth/token" @("-X", "POST", "-H", "content-type: application/json", "-d", $tokenBody, "http://shop.local/api/auth/oauth/token")
Probe "telemetry   POST otlp.local/v1/traces" @("-X", "POST", "-H", "content-type: application/json", "-d", '{"resourceSpans":[]}', "http://otlp.local/v1/traces")
if (-not $SkipExternal) {
  $code = kubectl --context $Ctx -n shop run "smoke-$(Get-Random)" --rm -i --restart=Never --image=$curl --quiet -- `
    curl -s -o /dev/null -w "%{http_code}" http://payment-provider.external.svc.cluster.local:8080/health 2>$null
  $ok = "$code" -match "200"
  Write-Host ("    {0,-48} {1}" -f "pod -> external payment provider", $(if ($ok) { "OK" } else { "FAILED ($code)" })) -ForegroundColor $(if ($ok) { "Green" } else { "Red" })
}

# ------------------------------------------------------------------------------- summary
Step "Done"
Write-Host @"

  1. Add this line to C:\Windows\System32\drivers\etc\hosts (as Administrator):
       127.0.0.1 shop.local signoz.local mail.local

  2. Keep this running in a separate (Administrator) terminal:
       minikube tunnel

  3. Open
       Shop               http://shop.local
       SigNoz             http://signoz.local        (create the admin account on first visit)
       Mailpit inbox      http://mail.local
       Provider chaos     http://localhost:8090/admin   token: PROVIDER_ADMIN_TOKEN
       Traffic generator  http://localhost:8091           token: TRAFFIC_CONTROL_TOKEN
                          (instructor only: runs on this PC, not inside the shop)

  Accounts (passwords are in $SecretsFile)
       shopper001 .. shopper100   SEED_USER_PASSWORD
       instructor                 INSTRUCTOR_PASSWORD

"@
