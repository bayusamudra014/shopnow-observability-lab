<#
.SYNOPSIS
  ShopNow observability lab: deploy the whole shop on this Windows computer with minikube.
  Nothing is built here; every image is pulled from the course registry.

.DESCRIPTION
  Double-click deploy.cmd, or run:  powershell -ExecutionPolicy Bypass -File .\deploy.ps1

  Needs: Windows 10/11 with Docker Desktop running (WSL 2), 4+ CPUs and 12+ GB of memory
  given to Docker, 40 GB disk. minikube, kubectl and helm come with the kit (tools\); no
  administrator rights, no hosts file and no `minikube tunnel` are needed.

  Settings are in shopnow.env (MODE=local by default: everything runs on this computer,
  including the payment provider). Re-running is safe: the shop's manifests are applied again
  only when shopnow.yaml or shopnow.env changed, so changes made with kubectl are kept. Optional environment: MINIKUBE_CPUS, MINIKUBE_MEMORY
  (e.g. 12g), MINIKUBE_DISK (e.g. 40g), MINIKUBE_PROFILE (default shopnow).
#>
[CmdletBinding()]
param([string]$EnvFile)

$ErrorActionPreference = "Stop"
$KitDir = $PSScriptRoot
if (-not $EnvFile) { $EnvFile = Join-Path $KitDir "shopnow.env" }

function Step([string]$Message) { Write-Host "`n==> $Message" -ForegroundColor Cyan }
function Info([string]$Message) { Write-Host "    $Message" -ForegroundColor DarkGray }
function Warn([string]$Message) { Write-Host "WARNING: $Message" -ForegroundColor Yellow }
# Run a native command; Windows PowerShell turns stderr lines (progress, warnings) into errors,
# so judge by the exit code only. Default: show the output as it comes. -Capture: return the
# output instead. -Quiet: show nothing unless it fails.
function Exec {
  param([Parameter(Mandatory)][scriptblock]$Command, [string]$What = "command", [switch]$Quiet, [switch]$Capture)
  $saved = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  $out = New-Object System.Collections.Generic.List[string]
  try {
    & $Command 2>&1 | ForEach-Object {
      $line = if ($_ -is [System.Management.Automation.ErrorRecord]) { $_.ToString() } else { "$_" }
      $out.Add($line)
      if (-not $Quiet -and -not $Capture) { Write-Host "    $line" -ForegroundColor DarkGray }
    }
  } finally {
    $ErrorActionPreference = $saved
  }
  if ($LASTEXITCODE -ne 0) {
    if ($Quiet -or $Capture) { $out | Select-Object -Last 15 | ForEach-Object { Write-Host "    $_" -ForegroundColor DarkGray } }
    throw "$What failed (exit code $LASTEXITCODE)"
  }
  if ($Capture) { $out.ToArray() }
}
function Read-EnvFile([string]$Path) {
  $values = @{}
  foreach ($raw in [IO.File]::ReadAllLines($Path)) {
    $line = $raw.TrimStart([char]0xFEFF)   # Notepad may save with a byte-order mark
    if ($line -match '^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$') { $values[$Matches[1]] = $Matches[2].Trim('"', "'") }
  }
  $values
}
function Write-Utf8([string]$Path, [string]$Text) {
  [IO.File]::WriteAllText($Path, $Text, (New-Object Text.UTF8Encoding $false))
}

try {
  # ------------------------------------------------------------------------- settings
  $K = Read-EnvFile (Join-Path $KitDir "kit.env")          # REGISTRY, TAG, STRIMZI_VERSION, *_CHART
  if (-not (Test-Path $EnvFile)) { throw "missing $EnvFile" }
  $E = Read-EnvFile $EnvFile
  $Mode = "$($E.MODE)".ToLower()
  if ($Mode -notin "local", "vm") { throw "Set MODE=local (this computer) or MODE=vm (a server) in $EnvFile" }
  $HttpPort = if ($E.HTTP_PORT) { $E.HTTP_PORT } else { "80" }
  $MockpayPort = if ($E.MOCKPAY_PORT) { $E.MOCKPAY_PORT } else { "8090" }
  $PortSuffix = if ($HttpPort -eq "80") { "" } else { ":$HttpPort" }
  $MkProfile = if ($env:MINIKUBE_PROFILE) { $env:MINIKUBE_PROFILE } else { "shopnow" }
  if ($Mode -eq "local") {
    if (-not $E.SHOP_HOST) { $E.SHOP_HOST = "shop.localhost" }
    if (-not $E.MAIL_HOST) { $E.MAIL_HOST = "mail.$($E.SHOP_HOST)" }
    if (-not $E.SIGNOZ_HOST) { $E.SIGNOZ_HOST = "signoz.$($E.SHOP_HOST)" }
    if (-not $E.SHOP_PUBLIC_URL) { $E.SHOP_PUBLIC_URL = "http://$($E.SHOP_HOST)$PortSuffix" }
    $required = "PROVIDER_API_KEY", "PROVIDER_WEBHOOK_SECRET", "SEED_USER_PASSWORD"
  } else {
    $required = "SHOP_HOST", "MAIL_HOST", "SIGNOZ_HOST", "SHOP_PUBLIC_URL", "PROVIDER_URL", "WEBHOOK_CALLBACK_URL",
                "PROVIDER_API_KEY", "PROVIDER_WEBHOOK_SECRET", "SEED_USER_PASSWORD"
  }
  $missing = $required | Where-Object { -not $E[$_] }
  if ($missing) { throw "MODE=${Mode}: fill in these values in $EnvFile first: $($missing -join ', ')" }
  $Ctx = $MkProfile
  $Services = "api-gateway", "auth", "catalog", "cart", "order", "inventory", "payment", "notification", "frontend"

  # ------------------------------------------------------------------- prerequisites
  Step "Checking prerequisites (MODE=$Mode)"
  # Bundled tools first on PATH (this session only): no installation, no admin rights.
  $tools = Join-Path $KitDir "tools"
  if (Test-Path (Join-Path $tools "minikube.exe")) {
    $env:Path = "$tools;$env:Path"
    Info "using minikube, kubectl and helm from $tools"
  }
  foreach ($t in "docker", "minikube", "kubectl", "helm", "curl") {
    if (-not (Get-Command $t -ErrorAction SilentlyContinue)) {
      if ($t -eq "docker") { throw "Docker Desktop is not installed. Install it (https://docs.docker.com/desktop/setup/install/windows-install/), start it, then run this again." }
      throw "$t is missing"
    }
  }
  foreach ($v in "DOCKER_TLS_VERIFY", "DOCKER_HOST", "DOCKER_CERT_PATH", "MINIKUBE_ACTIVE_DOCKERD") { Remove-Item "Env:$v" -ErrorAction SilentlyContinue }
  try { Exec { docker info --format "{{.ServerVersion}}" } "docker info" -Capture | Out-Null } catch { throw "Docker is not running. Start Docker Desktop, wait until it says 'Engine running', then run this again." }
  $dockerMemMb = [int64]((Exec { docker info --format "{{.MemTotal}}" } "docker info" -Capture) -join "") / 1MB
  $dockerCpus = [int]((Exec { docker info --format "{{.NCPU}}" } "docker info" -Capture) -join "")
  Info ("Docker Desktop: {0} CPUs, {1:N1} GB memory" -f $dockerCpus, ($dockerMemMb / 1024))
  if ($dockerMemMb -lt 10 * 1024) { Warn "Docker has less than 10 GB of memory; give it more (Docker Desktop settings, or memory= in %UserProfile%\.wslconfig)." }

  # ------------------------------------------------------------------------- cluster
  $cpus = if ($env:MINIKUBE_CPUS) { $env:MINIKUBE_CPUS } else { [math]::Min(6, $dockerCpus) }
  $memory = if ($env:MINIKUBE_MEMORY) { $env:MINIKUBE_MEMORY } else { "$([math]::Min(12288, $dockerMemMb - 2048))m" }
  $disk = if ($env:MINIKUBE_DISK) { $env:MINIKUBE_DISK } else { "40g" }
  Step "Starting minikube profile '$MkProfile' ($cpus CPUs, $memory memory), port $HttpPort -> ingress"
  $state = ""
  try { $state = (Exec { minikube -p $MkProfile status --format "{{.Host}}" } "minikube status" -Capture) -join "" } catch { $state = "" }
  if ($state -notmatch "Running") {
    $profiles = ""
    try { $profiles = (Exec { minikube profile list -o json } "minikube profile list" -Capture) -join "" } catch { $profiles = "" }
    if ($profiles -match "`"Name`":`"$MkProfile`"") {
      Exec { minikube -p $MkProfile start } "minikube start"
    } else {
      Exec { minikube -p $MkProfile start --driver=docker --container-runtime=docker --cpus=$cpus --memory=$memory --disk-size=$disk "--ports=${HttpPort}:80" } "minikube start"
    }
  } else {
    Info "minikube already running"
  }
  Exec { minikube -p $MkProfile addons enable ingress } "enable ingress" -Quiet
  Exec { minikube -p $MkProfile addons enable metrics-server } "enable metrics-server" -Quiet
  $MinikubeIp = ((Exec { minikube -p $MkProfile ip } "minikube ip" -Capture) -join "").Trim()

  # ------------------------------------------------------------------------- secrets
  Step "Preparing secrets"
  $SecretsFile = Join-Path $KitDir ".secrets.env"
  $S = if (Test-Path $SecretsFile) { Read-EnvFile $SecretsFile } else { @{} }
  $chars = [char[]]"abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789"
  $changed = $false
  foreach ($pair in @(@("POSTGRES_PASSWORD", 16), @("INSTRUCTOR_PASSWORD", 16), @("PROVIDER_DB_PASSWORD", 16), @("PROVIDER_ADMIN_TOKEN", 32))) {
    if (-not $S[$pair[0]]) { $S[$pair[0]] = -join (1..$pair[1] | ForEach-Object { $chars[(Get-Random -Maximum $chars.Length)] }); $changed = $true }
  }
  if ($changed) {
    Write-Utf8 $SecretsFile ((("POSTGRES_PASSWORD", "INSTRUCTOR_PASSWORD", "PROVIDER_DB_PASSWORD", "PROVIDER_ADMIN_TOKEN") | ForEach-Object { "$_=$($S[$_])" }) -join "`n")
    Info "generated $SecretsFile"
  }

  $tmp = Join-Path ([IO.Path]::GetTempPath()) "shopnow-$([guid]::NewGuid().ToString('N'))"
  New-Item -ItemType Directory -Force $tmp | Out-Null
  function Apply-Yaml([string]$Yaml, [string]$What) {
    $f = Join-Path $tmp "apply-$([guid]::NewGuid().ToString('N')).yaml"
    Write-Utf8 $f $Yaml
    Exec { kubectl --context $Ctx apply -f $f } $What -Quiet
  }
  foreach ($ns in "shop", "infra", "external", "platform") {
    Apply-Yaml ((Exec { kubectl --context $Ctx create namespace $ns --dry-run=client -o yaml } "namespace" -Capture) -join "`n") "namespace $ns"
  }
  Apply-Yaml ((Exec { kubectl --context $Ctx -n shop create secret generic shop-secrets --dry-run=client -o yaml `
          "--from-literal=POSTGRES_PASSWORD=$($S.POSTGRES_PASSWORD)" `
          "--from-literal=SEED_USER_PASSWORD=$($E.SEED_USER_PASSWORD)" `
          "--from-literal=INSTRUCTOR_PASSWORD=$($S.INSTRUCTOR_PASSWORD)" `
          "--from-literal=PROVIDER_API_KEY=$($E.PROVIDER_API_KEY)" `
          "--from-literal=PROVIDER_WEBHOOK_SECRET=$($E.PROVIDER_WEBHOOK_SECRET)" } "secret shop-secrets" -Capture) -join "`n") "secret shop-secrets"
  Apply-Yaml ((Exec { kubectl --context $Ctx -n infra create secret generic postgres-credentials --dry-run=client -o yaml `
          "--from-literal=POSTGRES_PASSWORD=$($S.POSTGRES_PASSWORD)" } "secret postgres-credentials" -Capture) -join "`n") "secret postgres-credentials"

  # ----------------------------------------------------------- local payment provider
  if ($Mode -eq "local") {
    $prefix = ($MinikubeIp -split "\.")[0..2] -join "."
    $ProviderIp = "$prefix.100"
    $E.PROVIDER_URL = "http://${ProviderIp}:8080"
    # Inside the Docker network the ingress listens on the node's port 80.
    $E.WEBHOOK_CALLBACK_URL = "http://$($E.SHOP_HOST)/webhooks/payment-provider"
    Step "Starting the local payment provider (MockPay) at $ProviderIp"
    $mockpayEnv = Join-Path $KitDir ".mockpay.env"
    Write-Utf8 $mockpayEnv ((@(
          "REGISTRY=$($K.REGISTRY)", "TAG=$($K.TAG)",
          "PROVIDER_API_KEY=$($E.PROVIDER_API_KEY)", "PROVIDER_WEBHOOK_SECRET=$($E.PROVIDER_WEBHOOK_SECRET)",
          "PROVIDER_ADMIN_TOKEN=$($S.PROVIDER_ADMIN_TOKEN)", "PROVIDER_DB_PASSWORD=$($S.PROVIDER_DB_PASSWORD)",
          "MINIKUBE_NETWORK=$MkProfile", "MINIKUBE_IP=$MinikubeIp", "PROVIDER_IP=$ProviderIp", "SHOP_HOST=$($E.SHOP_HOST)",
          "MOCKPAY_PORT=$MockpayPort",
          "CHAOS_SCHEDULE=$(if ($K.LAB -eq 'challenges') { 'slow-waves' })"
        ) -join "`n") + "`n")
    Exec { docker compose -f (Join-Path $KitDir "local\mockpay-compose.yml") --env-file $mockpayEnv up -d --wait } "start MockPay"
  }

  # --------------------------------------------------------------- operators / charts
  # Charts come with the kit (charts\): no chart repositories, nothing from GitHub.
  Step "Installing Strimzi $($K.STRIMZI_VERSION) (Kafka operator)"
  Exec { helm upgrade --install strimzi (Join-Path $KitDir $K.STRIMZI_CHART) --kube-context $Ctx -n infra --wait --timeout 10m } "helm strimzi" -Quiet
  Step "Installing SigNoz (a few minutes the first time)"
  Exec { helm upgrade --install signoz (Join-Path $KitDir $K.SIGNOZ_CHART) --kube-context $Ctx -n platform `
      -f (Join-Path $KitDir "helm\signoz-values.yaml") -f (Join-Path $KitDir "helm\signoz-values-no-github.yaml") --wait --timeout 20m } "helm signoz" -Quiet
  Exec { helm upgrade --install k8s-infra (Join-Path $KitDir $K.K8S_INFRA_CHART) --kube-context $Ctx -n platform `
      -f (Join-Path $KitDir "helm\k8s-infra-values.yaml") --wait --timeout 10m } "helm k8s-infra" -Quiet

  # --------------------------------------------------------------------------- shop
  Step "Deploying ShopNow $($K.TAG) ($($K.REGISTRY)) for $($E.SHOP_PUBLIC_URL)"
  $yaml = [IO.File]::ReadAllText((Join-Path $KitDir "shopnow.yaml"))
  # (Not $k: PowerShell names are case-insensitive, and $K holds the kit settings.)
  foreach ($name in "SHOP_HOST", "MAIL_HOST", "SIGNOZ_HOST", "SHOP_PUBLIC_URL", "PROVIDER_URL", "WEBHOOK_CALLBACK_URL") {
    $yaml = $yaml.Replace("__${name}__", $E[$name])
  }
  $sha = [Security.Cryptography.SHA256]::Create()
  $hash = (-join ($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes(($yaml -replace "`r`n", "`n"))) | ForEach-Object { $_.ToString("x2") })).Substring(0, 16)
  # A field of a shop object, or "" if the object does not exist (quietly).
  function Get-Live([string]$What, [string]$Path) {
    $saved = $ErrorActionPreference; $ErrorActionPreference = "Continue"
    $o = & kubectl --context $Ctx -n shop get $What -o "jsonpath=$Path" 2>$null
    $code = $LASTEXITCODE; $ErrorActionPreference = $saved
    if ($code -ne 0) { "" } else { ($o -join "").Trim() }
  }
  function Get-State([string]$Key) { Get-Live "configmap/shopnow-kit-state" "{.data.$Key}" }
  $prevTag = Get-State "kitTag"; $prevHash = Get-State "appliedHash"; $prevUpdate = Get-State "updateTag"
  if (-not (Get-Live "configmap/shopnow-kit-state" "{.metadata.name}") -and (Get-Live "deployment/order" "{.metadata.name}") -and $K.LAB -eq "challenges") {
    throw ("This cluster was set up with an older kit. Reset only the shop (SigNoz, Kafka and Postgres stay), keep the old kit's .secrets.env in this folder, then run deploy.cmd again:`n" +
      "  kubectl --context $Ctx delete namespace shop`n  kubectl --context $Ctx -n infra delete kafkatopic order.placed order.confirmed order.cancelled")
  }
  if ($prevTag -eq $K.TAG -and $prevHash -eq $hash) {
    Info "shopnow.yaml and shopnow.env are unchanged since the last deploy: not re-applied (your changes in the cluster are kept)"
  } else {
    if ($prevTag) { Warn "shopnow.yaml or shopnow.env changed: re-applying the shop's manifests (changes made only with kubectl are reset)" }
    if ($prevTag -eq $K.TAG) {
      # Same release: keep whatever image order/catalog run now (a rollout or rollback stays).
      foreach ($d in "order", "catalog") {
        $live = Get-Live "deployment/$d" "{.spec.template.spec.containers[0].image}"
        if ($live) { $yaml = [regex]::Replace($yaml, "image: $([regex]::Escape($K.REGISTRY))/shopnow-${d}:\S+", "image: $live") }
      }
    }
    $cmBefore = Get-Live "configmap/shop-common" "{.data}"
    Apply-Yaml $yaml "apply shopnow.yaml"
    $cmAfter = Get-Live "configmap/shop-common" "{.data}"
    # Changed settings only reach running pods on restart.
    if ($prevTag -and $cmBefore -ne $cmAfter) {
      Info "settings changed: restarting the shop's services"
      foreach ($svc in $Services) { Exec { kubectl --context $Ctx -n shop rollout restart "deployment/$svc" } "restart $svc" -Quiet }
    }
  }

  Step "Waiting for infrastructure"
  Exec { kubectl --context $Ctx -n infra rollout status statefulset/postgres --timeout=300s } "postgres"
  Exec { kubectl --context $Ctx -n infra rollout status deployment/redis --timeout=300s } "redis"
  Exec { kubectl --context $Ctx -n infra rollout status deployment/mailpit --timeout=300s } "mailpit"
  Info "waiting for Kafka (first start can take ~3 minutes)"
  Exec { kubectl --context $Ctx -n infra wait kafka/kafka --for=condition=Ready --timeout=600s } "kafka"
  Step "Waiting for the shop (first start pulls the images)"
  # Wait until a deployment's pods are ready; give up on it (with a warning) when one of its
  # pods keeps crashing, instead of waiting the full timeout.
  function Wait-Deploy([string]$D) {
    $deadline = (Get-Date).AddMinutes(10)
    while ((Get-Date) -lt $deadline) {
      $want = Get-Live "deployment/$D" "{.spec.replicas}"
      $ready = Get-Live "deployment/$D" "{.status.updatedReplicas}/{.status.readyReplicas}/{.status.replicas}"
      if ($want -and $ready -eq "$want/$want/$want") { Info "$D ready"; return }
      $restarts = (Get-Live "pods" "{range .items[?(@.metadata.labels.app=='$D')]}{.status.containerStatuses[0].restartCount}{' '}{end}") -split "\s+" | Where-Object { $_ }
      if ($restarts | Where-Object { [int]$_ -ge 3 }) { Warn "$D keeps restarting (see status.cmd); continuing"; return }
      Start-Sleep -Seconds 5
    }
    Warn "$D is not ready after 10 minutes (see status.cmd); continuing"
  }
  foreach ($svc in $Services) { Wait-Deploy $svc }

  # A release rolled out over the first install, like an update shipped later (once).
  if ($K.UPDATE_TAG -and $prevUpdate -ne $K.UPDATE_TAG) {
    Step "Rolling out release $($K.UPDATE_TAG)"
    $u = $K.UPDATE_TAG
    # Image first, then the note: the note then lands on the new revision only.
    Exec { kubectl --context $Ctx -n shop set image deployment/order "order=$($K.REGISTRY)/shopnow-order:$u" } "update order" -Quiet
    Exec { kubectl --context $Ctx -n shop annotate deployment/order --overwrite "kubernetes.io/change-cause=release ${u}: bulk pricing for premium items" } "annotate order" -Quiet
    Exec { kubectl --context $Ctx -n shop set image deployment/catalog "catalog=$($K.REGISTRY)/shopnow-catalog:$u" } "update catalog" -Quiet
    Exec { kubectl --context $Ctx -n shop annotate deployment/catalog --overwrite "kubernetes.io/change-cause=release ${u}: catalog dependency updates" } "annotate catalog" -Quiet
    Wait-Deploy "order"
    Wait-Deploy "catalog"
    $prevUpdate = $u
  }
  Apply-Yaml ((Exec { kubectl --context $Ctx -n shop create configmap shopnow-kit-state --dry-run=client -o yaml `
          "--from-literal=kitTag=$($K.TAG)" "--from-literal=appliedHash=$hash" "--from-literal=updateTag=$prevUpdate" } "state" -Capture) -join "`n") "kit state"

  # --------------------------------------------------------------------- smoke tests
  Step "Smoke tests"
  $base = "http://127.0.0.1:$HttpPort"
  function Check([string]$Name, [string]$Want, [string[]]$CurlArgs) {
    $saved = $ErrorActionPreference; $ErrorActionPreference = "Continue"
    $code = (& curl.exe -s -o NUL -m 10 -w "%{http_code}" @CurlArgs 2>$null) -join ""
    $ErrorActionPreference = $saved
    $ok = $code -like $Want
    Write-Host ("    {0,-46} {1}" -f $Name, $(if ($ok) { "OK ($code)" } else { "FAILED ($code)" })) -ForegroundColor $(if ($ok) { "Green" } else { "Red" })
  }
  # JSON bodies go through a file: Windows PowerShell drops quotes in native arguments.
  $loginBody = Join-Path $tmp "login.json"
  Write-Utf8 $loginBody ('{"grant_type":"password","username":"shopper001","password":"' + $E.SEED_USER_PASSWORD + '"}')
  $emptyBody = Join-Path $tmp "empty.json"
  Write-Utf8 $emptyBody "{}"
  Check "storefront   $($E.SHOP_HOST)" "200" @("-H", "Host: $($E.SHOP_HOST)", "$base/")
  Check "catalog API  /api/catalog/products" "200" @("-H", "Host: $($E.SHOP_HOST)", "$base/api/catalog/products?limit=1")
  Check "seed login   /api/auth/oauth/token" "200" @("-H", "Host: $($E.SHOP_HOST)", "-H", "content-type: application/json", "--data-binary", "@$loginBody", "$base/api/auth/oauth/token")
  if ($K.LAB -ne "challenges") { Check "webhook      unsigned POST -> 4xx" "4*" @("-H", "Host: $($E.SHOP_HOST)", "-H", "content-type: application/json", "--data-binary", "@$emptyBody", "$base/webhooks/payment-provider") }
  Check "mailpit      $($E.MAIL_HOST)" "200" @("-H", "Host: $($E.MAIL_HOST)", "$base/")
  Check "signoz       $($E.SIGNOZ_HOST)" "200" @("-H", "Host: $($E.SIGNOZ_HOST)", "$base/")
  if ($Mode -eq "local") {
    # *.localhost: curl resolves it to 127.0.0.1 like browsers do.
    Check "browser URL  $($E.SHOP_PUBLIC_URL)" "200" @("$($E.SHOP_PUBLIC_URL)/")
    Check "mockpay      http://localhost:$MockpayPort/health" "200" @("http://127.0.0.1:$MockpayPort/health")
  } else {
    Check "public URL   $($E.SHOP_PUBLIC_URL) (via DNS)" "200" @("$($E.SHOP_PUBLIC_URL)/")
  }
  $saved = $ErrorActionPreference; $ErrorActionPreference = "Continue"
  $code = (& kubectl --context $Ctx -n shop run "smoke-$(Get-Random)" --rm -i --restart=Never --image=curlimages/curl:8.11.1 --quiet -- `
      curl -s -o /dev/null -m 10 -w "%{http_code}" "$($E.PROVIDER_URL)/health" 2>$null) -join ""
  $ErrorActionPreference = $saved
  $ok = $code -match "200"
  Write-Host ("    {0,-46} {1}" -f "pod -> payment provider", $(if ($ok) { "OK" } else { "FAILED ($code)" })) -ForegroundColor $(if ($ok) { "Green" } else { "Red" })
  Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue

  $mockpayLine = if ($Mode -eq "local") { "    MockPay     http://localhost:$MockpayPort/admin   (token: PROVIDER_ADMIN_TOKEN in .secrets.env)" } else { "" }
  Write-Host @"

  ShopNow is running (MODE=$Mode, minikube profile $MkProfile).

    Shop        $($E.SHOP_PUBLIC_URL)
    SigNoz      http://$($E.SIGNOZ_HOST)$PortSuffix   (create the admin account on first visit;
                                          telemetry starts flowing after that)
    Mailpit     http://$($E.MAIL_HOST)$PortSuffix
$mockpayLine

    Accounts    shopper001 .. shopper100 / SEED_USER_PASSWORD from shopnow.env,
                or create your own on the Register page
    Secrets     $SecretsFile

    Status      status.cmd         Remove      destroy.cmd
$(if ($K.LAB -eq "challenges") { "    Tickets     TICKETS.md         Check       check.cmd" })

"@
} catch {
  Write-Host "`nDeploy failed: $($_.Exception.Message)" -ForegroundColor Red
  exit 1
}
