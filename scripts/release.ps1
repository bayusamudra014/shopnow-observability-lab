<#
.SYNOPSIS
  Builds every ShopNow image, pushes them to the registry and renders the two deploy kits:

    dist/shopnow-kit-<tag>.tar.gz          for each student VM (Ubuntu + minikube)
    dist/shopnow-instructor-<tag>.tar.gz   for the instructor host (MockPay + traffic generator)

.DESCRIPTION
  No hosts or URLs are baked in: each kit has an env file (shopnow.env / .env) whose host and
  URL values are left empty, to be filled in on the machine. Only the registry, the tag and the
  shared secrets are prefilled.

  The registry comes from -Registry or $env:SHOPNOW_REGISTRY (<registry host>/<project>).
  Log in to it once first:  docker login <registry host>

    .\scripts\release.ps1 -Registry <registry host>/<project>     # build, push, render kits
    .\scripts\release.ps1 -Tag 1.0.0
    .\scripts\release.ps1 -SkipBuild -SkipPush -Tag 1.0.0         # only re-render the kits
    .\scripts\release.ps1 ... -NoTools                            # kit without bundled CLI tools
    .\scripts\release.ps1 ... -Clean                              # kit WITHOUT the incident challenges

  By default the student kit is the challenge kit: the shop has the incidents of
  deploy/overlays/lab built in, and "last night's release" (-BadTag, default: the next patch
  version) is rolled out by deploy.sh after the first install. -Clean renders the shop as it
  should be (deploy/overlays/vm), e.g. for an introduction session.

  The student kit bundles Linux binaries of minikube, kubectl and helm (pinned versions,
  checked against the published SHA-256), so the VMs can install them without internet.
  Downloads are cached in .cache/tools/.

  Shared secrets (MockPay API key / webhook secret / admin token, seed-user password, generator
  token) live in .secrets/shopnow.env and are reused on every release, so a re-deployed VM or
  instructor host keeps working with the other side.
#>
[CmdletBinding()]
param(
  [string]$Tag = (Get-Date -Format "yyyy.MM.dd-HHmm"),
  [string]$Registry = $env:SHOPNOW_REGISTRY,
  [string]$StrimziVersion = "0.48.0",
  # Helm charts bundled into the student kit (charts/): the VMs cannot reach GitHub, where
  # the SigNoz chart packages are hosted.
  [string]$SignozChartVersion = "0.151.0",
  [string]$K8sInfraChartVersion = "0.17.1",
  # ClickHouse UDF binary SigNoz's ClickHouse normally downloads from GitHub at start-up.
  [string]$HistogramQuantileVersion = "v0.0.1",
  # CLI tools bundled into the student kit for offline installation (tools/ in the kit).
  [ValidateSet("amd64", "arm64")][string]$Arch = "amd64",
  [string]$MinikubeVersion = "v1.39.0",
  [string]$KubectlVersion = "v1.37.0",
  [string]$HelmVersion = "v4.3.2",
  [switch]$NoTools,
  # Tag of "last night's release" (challenge 8): order with a bug, catalog unchanged.
  [string]$BadTag,
  # Render the kit without the incident challenges.
  [switch]$Clean,
  [switch]$SkipBuild,
  [switch]$SkipPush
)

$ErrorActionPreference = "Stop"
if (-not $Registry) { throw "Set the registry: -Registry <registry host>/<project>, or `$env:SHOPNOW_REGISTRY" }
$Registry = $Registry.TrimEnd("/")
$Root = Split-Path -Parent $PSScriptRoot
$Dist = Join-Path $Root "dist"
if (-not $BadTag) {
  $BadTag = if ($Tag -match '^(\d+)\.(\d+)\.(\d+)$') { "$($Matches[1]).$($Matches[2]).$([int]$Matches[3] + 1)" } else { "$Tag-1" }
}
if ($BadTag -eq $Tag) { throw "-BadTag must differ from -Tag" }

function Step([string]$Message) { Write-Host "`n==> $Message" -ForegroundColor Cyan }
function Info([string]$Message) { Write-Host "    $Message" -ForegroundColor DarkGray }
function Exec {
  param([Parameter(Mandatory)][scriptblock]$Command, [string]$What = "command")
  $saved = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  try {
    & $Command 2>&1 | ForEach-Object { if ($_ -is [System.Management.Automation.ErrorRecord]) { Write-Host $_.ToString() } else { $_ } }
  } finally {
    $ErrorActionPreference = $saved
  }
  if ($LASTEXITCODE -ne 0) { throw "$What failed (exit code $LASTEXITCODE)" }
}
# Kit files run on Linux: write them with LF line endings and no BOM.
function Write-Lf([string]$Path, [string]$Text) {
  [IO.File]::WriteAllText($Path, ($Text -replace "`r`n", "`n"), (New-Object Text.UTF8Encoding $false))
}
function Copy-Lf([string]$From, [string]$To) { Write-Lf $To ([IO.File]::ReadAllText($From)) }

# ------------------------------------------------------------------------- downloads
# Download a file once into the cache and check it against the published SHA-256.
function Get-Verified([string]$Url, [string]$ShaUrl, [string]$Dest) {
  if (-not (Test-Path $Dest)) {
    Info "downloading $Url"
    $tmp = "$Dest.part"
    Exec { curl.exe -fsSL --retry 3 -o $tmp $Url } "download $Url"
    Move-Item -Force $tmp $Dest
  }
  $want = ((Exec { curl.exe -fsSL --retry 3 $ShaUrl } "download $ShaUrl") -join " ").Trim().Split(" ")[0].ToLower()
  $have = (Get-FileHash -Algorithm SHA256 $Dest).Hash.ToLower()
  if ($want -ne $have) {
    Remove-Item -Force $Dest
    throw "checksum mismatch for $Url (expected $want, got $have); the download was deleted, run again"
  }
}

# Download a file once into the cache (for files without a published checksum).
function Get-Cached([string]$Url, [string]$Dest) {
  if (-not (Test-Path $Dest)) {
    Info "downloading $Url"
    $tmp = "$Dest.part"
    Exec { curl.exe -fsSL --retry 3 -o $tmp $Url } "download $Url"
    Move-Item -Force $tmp $Dest
  }
  Info "sha256 $((Get-FileHash -Algorithm SHA256 $Dest).Hash.ToLower())  $(Split-Path -Leaf $Dest)"
}

# helm: winget installs it without updating PATH for already-open terminals.
if (-not (Get-Command helm -ErrorAction SilentlyContinue)) {
  $wingetHelm = Get-ChildItem "$env:LOCALAPPDATA\Microsoft\WinGet\Packages" -Recurse -Filter helm.exe -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($wingetHelm) { $env:Path = "$($wingetHelm.DirectoryName);$env:Path" }
}
if (-not (Get-Command helm -ErrorAction SilentlyContinue)) { throw "helm is not installed (winget install Helm.Helm)" }

# SigNoz's ClickHouse fetches the histogramQuantile UDF from GitHub when it starts. Bake the
# binary into a tiny image instead, so student VMs never need GitHub.
Step "ClickHouse UDF histogram-quantile $HistogramQuantileVersion (linux/$Arch)"
$UdfDir = Join-Path $Root ".cache/clickhouse-udf/$HistogramQuantileVersion-$Arch"
New-Item -ItemType Directory -Force $UdfDir | Out-Null
$udfTgz = Join-Path $UdfDir "histogram-quantile.tar.gz"
Get-Cached "https://github.com/SigNoz/signoz/releases/download/histogram-quantile%2F$HistogramQuantileVersion/histogram-quantile_linux_$Arch.tar.gz" $udfTgz
if (-not (Test-Path (Join-Path $UdfDir "histogram-quantile"))) { Exec { tar -xzf $udfTgz -C $UdfDir } "extract histogram-quantile" }
Copy-Item -Force (Join-Path $Root "deploy/images/clickhouse-udf/Dockerfile") (Join-Path $UdfDir "Dockerfile")

# Images: name in the registry -> how to build it. APP_VERSION becomes service.version.
$images = [ordered]@{}
$ver = @("--build-arg", "APP_VERSION=$Tag")
foreach ($svc in "api-gateway", "auth", "catalog", "cart", "order", "inventory", "payment", "notification") {
  $images["shopnow-$svc"] = @{ Context = $Root; Args = @("--build-arg", "WORKSPACE=services/$svc") + $ver }
}
$images["shopnow-frontend"] = @{ Context = (Join-Path $Root "apps/frontend"); Args = @() }
$images["shopnow-payment-provider"] = @{ Context = $Root; Args = @("--build-arg", "WORKSPACE=external/payment-provider", "--build-arg", "INSTRUMENT=false") + $ver }
$images["shopnow-traffic-generator"] = @{ Context = $Root; Args = @("--build-arg", "WORKSPACE=tools/traffic-generator", "--build-arg", "INSTRUMENT=false") + $ver }
$images["shopnow-lab-check"] = @{ Context = $Root; Args = @("--build-arg", "WORKSPACE=tools/lab-check", "--build-arg", "INSTRUMENT=false") + $ver }
$images["shopnow-clickhouse-udf"] = @{ Context = $UdfDir; Args = @() }
# "Last night's release" for challenge 8, tagged $BadTag only (never :latest): order gets the
# buggy bulk-pricing feature, catalog is an unchanged rebuild (the red herring).
$badImages = [ordered]@{
  "shopnow-order"   = @("--build-arg", "WORKSPACE=services/order", "--build-arg", "APP_VERSION=$BadTag", "--build-arg", "RELEASE_FEATURES=bulk-pricing")
  "shopnow-catalog" = @("--build-arg", "WORKSPACE=services/catalog", "--build-arg", "APP_VERSION=$BadTag")
}

# Build on this PC's Docker, never inside minikube.
foreach ($v in "DOCKER_TLS_VERIFY", "DOCKER_HOST", "DOCKER_CERT_PATH", "MINIKUBE_ACTIVE_DOCKERD") { Remove-Item "Env:$v" -ErrorAction SilentlyContinue }

# ------------------------------------------------------------------------------- build
if (-not $SkipBuild) {
  Step "Building $($images.Count) images (linux/$Arch), tag $Tag"
  foreach ($name in $images.Keys) {
    $img = $images[$name]
    $ref = "$Registry/${name}:$Tag"
    Info $ref
    $buildArgs = @("build", "-q", "--platform", "linux/$Arch", "-t", $ref, "-t", "$Registry/${name}:latest") + $img.Args + @($img.Context)
    Exec { docker @buildArgs | Out-Null } "build $name"
  }
  Step "Building last night's release (challenge 8), tag $BadTag"
  foreach ($name in $badImages.Keys) {
    $ref = "$Registry/${name}:$BadTag"
    Info $ref
    $buildArgs = @("build", "-q", "--platform", "linux/$Arch", "-t", $ref) + $badImages[$name] + @($Root)
    Exec { docker @buildArgs | Out-Null } "build $name $BadTag"
  }
}

# -------------------------------------------------------------------------------- push
if (-not $SkipPush) {
  Step "Pushing to $Registry"
  foreach ($name in $images.Keys) {
    foreach ($t in $Tag, "latest") {
      $ref = "$Registry/${name}:$t"
      Info $ref
      try {
        Exec { docker push -q $ref | Out-Null } "push $ref"
      } catch {
        throw "$($_.Exception.Message). Are you logged in? Run: docker login $($Registry.Split('/')[0])"
      }
    }
  }
  foreach ($name in $badImages.Keys) {
    $ref = "$Registry/${name}:$BadTag"
    Info $ref
    Exec { docker push -q $ref | Out-Null } "push $ref"
  }
}

# ----------------------------------------------------------------------------- secrets
Step "Shared secrets (.secrets/shopnow.env)"
$SecretsDir = Join-Path $Root ".secrets"
$SecretsFile = Join-Path $SecretsDir "shopnow.env"
New-Item -ItemType Directory -Force $SecretsDir | Out-Null
$keys = "PROVIDER_API_KEY", "PROVIDER_WEBHOOK_SECRET", "PROVIDER_ADMIN_TOKEN", "PROVIDER_DB_PASSWORD", "SEED_USER_PASSWORD", "CONTROL_TOKEN"
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
  Write-Lf $SecretsFile ((($keys | ForEach-Object { "$_=$($S[$_])" }) -join "`n") + "`n")
  Info "generated new values in $SecretsFile"
} else {
  Info "reusing $SecretsFile"
}

# Fill __NAME__ placeholders in a template with the release values and shared secrets.
$fill = @{ REGISTRY = $Registry; TAG = $Tag }
foreach ($k in $keys) { $fill[$k] = $S[$k] }
function Expand-Template([string]$From, [string]$To) {
  $text = [IO.File]::ReadAllText($From)
  foreach ($k in $fill.Keys) { $text = $text.Replace("__${k}__", $fill[$k]) }
  Write-Lf $To $text
}

$ToolsCache = $null
$WinToolsCache = $null
if (-not $NoTools) {
  Step "Offline tools for linux/${Arch}: minikube $MinikubeVersion, kubectl $KubectlVersion, helm $HelmVersion"
  $ToolsCache = Join-Path $Root ".cache/tools/linux-$Arch"
  New-Item -ItemType Directory -Force $ToolsCache | Out-Null
  $mk = "https://storage.googleapis.com/minikube/releases/$MinikubeVersion/minikube-linux-$Arch"
  Get-Verified $mk "$mk.sha256" (Join-Path $ToolsCache "minikube-$MinikubeVersion")
  $kc = "https://dl.k8s.io/release/$KubectlVersion/bin/linux/$Arch/kubectl"
  Get-Verified $kc "$kc.sha256" (Join-Path $ToolsCache "kubectl-$KubectlVersion")
  $hm = "https://get.helm.sh/helm-$HelmVersion-linux-$Arch.tar.gz"
  $hmTgz = Join-Path $ToolsCache "helm-$HelmVersion.tar.gz"
  Get-Verified $hm "$hm.sha256sum" $hmTgz
  $hmDir = Join-Path $ToolsCache "helm-$HelmVersion"
  if (-not (Test-Path (Join-Path $hmDir "linux-$Arch/helm"))) {
    New-Item -ItemType Directory -Force $hmDir | Out-Null
    Exec { tar -xzf $hmTgz -C $hmDir } "extract helm"
  }
  Info "verified and cached in $ToolsCache"

  # Windows (amd64) for the Windows kit: used straight from the kit's tools\ folder.
  Step "Offline tools for windows/amd64"
  $WinToolsCache = Join-Path $Root ".cache/tools/windows-amd64"
  New-Item -ItemType Directory -Force $WinToolsCache | Out-Null
  $mkw = "https://storage.googleapis.com/minikube/releases/$MinikubeVersion/minikube-windows-amd64.exe"
  Get-Verified $mkw "$mkw.sha256" (Join-Path $WinToolsCache "minikube-$MinikubeVersion.exe")
  $kcw = "https://dl.k8s.io/release/$KubectlVersion/bin/windows/amd64/kubectl.exe"
  Get-Verified $kcw "$kcw.sha256" (Join-Path $WinToolsCache "kubectl-$KubectlVersion.exe")
  $hmw = "https://get.helm.sh/helm-$HelmVersion-windows-amd64.zip"
  $hmwZip = Join-Path $WinToolsCache "helm-$HelmVersion.zip"
  Get-Verified $hmw "$hmw.sha256sum" $hmwZip
  $hmwDir = Join-Path $WinToolsCache "helm-$HelmVersion"
  if (-not (Test-Path (Join-Path $hmwDir "windows-amd64/helm.exe"))) { Expand-Archive -Force $hmwZip $hmwDir }
  Info "verified and cached in $WinToolsCache"
}

# ------------------------------------------------------------------------------ charts
Step "Helm charts: signoz $SignozChartVersion, k8s-infra $K8sInfraChartVersion, strimzi $StrimziVersion"
$ChartsCache = Join-Path $Root ".cache/charts"
New-Item -ItemType Directory -Force $ChartsCache | Out-Null
$charts = @{
  SIGNOZ_CHART    = "signoz-$SignozChartVersion.tgz"
  K8S_INFRA_CHART = "k8s-infra-$K8sInfraChartVersion.tgz"
  STRIMZI_CHART   = "strimzi-kafka-operator-$StrimziVersion.tgz"
}
if (-not ((Test-Path (Join-Path $ChartsCache $charts.SIGNOZ_CHART)) -and (Test-Path (Join-Path $ChartsCache $charts.K8S_INFRA_CHART)))) {
  Exec { helm repo add signoz https://charts.signoz.io --force-update | Out-Null } "helm repo add signoz"
  Exec { helm repo update signoz | Out-Null } "helm repo update signoz"
}
if (-not (Test-Path (Join-Path $ChartsCache $charts.SIGNOZ_CHART))) { Exec { helm pull signoz/signoz --version $SignozChartVersion -d $ChartsCache } "helm pull signoz" }
if (-not (Test-Path (Join-Path $ChartsCache $charts.K8S_INFRA_CHART))) { Exec { helm pull signoz/k8s-infra --version $K8sInfraChartVersion -d $ChartsCache } "helm pull k8s-infra" }
if (-not (Test-Path (Join-Path $ChartsCache $charts.STRIMZI_CHART))) {
  Exec { helm pull oci://quay.io/strimzi-helm/strimzi-kafka-operator --version $StrimziVersion -d $ChartsCache } "helm pull strimzi"
}
foreach ($c in $charts.Values) { Info "$c  sha256 $((Get-FileHash -Algorithm SHA256 (Join-Path $ChartsCache $c)).Hash.ToLower())" }

# --------------------------------------------------------------------------- student kit
$overlay = if ($Clean) { "vm" } else { "lab" }
Step "Rendering the student kit ($(if ($Clean) { 'clean, no challenges' } else { "with the incident challenges, last night's release $BadTag" }))"
$kitName = "shopnow-kit"
$Kit = Join-Path $Dist $kitName
if (Test-Path $Kit) { Remove-Item -Recurse -Force $Kit }
New-Item -ItemType Directory -Force (Join-Path $Kit "helm") | Out-Null
$rendered = Exec { kubectl kustomize (Join-Path $Root "deploy/overlays/$overlay") } "kubectl kustomize deploy/overlays/$overlay"
$yaml = ($rendered -join "`n").Replace("KIT_REGISTRY", $Registry).Replace("KIT_BAD_TAG", $BadTag).Replace("KIT_TAG", $Tag)
# Neutral header: the kit must not say which values are the incidents.
Write-Lf (Join-Path $Kit "shopnow.yaml") ("# ShopNow $Tag - the shop's Kubernetes manifests (generated, do not edit by hand unless you mean to)`n" + $yaml + "`n")
$kitScripts = "deploy.sh", "status.sh", "destroy.sh", "README.md"
if (-not $Clean) { $kitScripts += "check.sh", "TICKETS.md" }
foreach ($f in $kitScripts) { Copy-Lf (Join-Path $Root "deploy/student-kit/$f") (Join-Path $Kit $f) }
New-Item -ItemType Directory -Force (Join-Path $Kit "local") | Out-Null
Copy-Lf (Join-Path $Root "deploy/student-kit/local/mockpay-compose.yml") (Join-Path $Kit "local/mockpay-compose.yml")
foreach ($f in "signoz-values.yaml", "k8s-infra-values.yaml") { Copy-Lf (Join-Path $Root "deploy/helm/$f") (Join-Path $Kit "helm/$f") }
Expand-Template (Join-Path $Root "deploy/helm/signoz-values-no-github.yaml") (Join-Path $Kit "helm/signoz-values-no-github.yaml")
New-Item -ItemType Directory -Force (Join-Path $Kit "charts") | Out-Null
foreach ($c in $charts.Values) { Copy-Item (Join-Path $ChartsCache $c) (Join-Path $Kit "charts/$c") }
Write-Lf (Join-Path $Kit "kit.env") ((@(
      "# ShopNow release $Tag (set by scripts/release.ps1). Your settings go in shopnow.env.",
      "REGISTRY=$Registry",
      "TAG=$Tag",
      "STRIMZI_VERSION=$StrimziVersion",
      "SIGNOZ_CHART=charts/$($charts.SIGNOZ_CHART)",
      "K8S_INFRA_CHART=charts/$($charts.K8S_INFRA_CHART)",
      "STRIMZI_CHART=charts/$($charts.STRIMZI_CHART)",
      "# challenges: the incident-challenge kit (local MockPay has slow waves); clean: none.",
      "LAB=$(if ($Clean) { 'clean' } else { 'challenges' })",
      "# Release rolled out over the first install (empty: none).",
      "UPDATE_TAG=$(if ($Clean) { '' } else { $BadTag })"
    ) -join "`n") + "`n")
Expand-Template (Join-Path $Root "deploy/student-kit/shopnow.env.template") (Join-Path $Kit "shopnow.env")
# Linux kit: the student picks MODE=local (own computer) or MODE=vm (server).
Write-Lf (Join-Path $Kit "shopnow.env") ([IO.File]::ReadAllText((Join-Path $Kit "shopnow.env")).Replace("MODE=__MODE__", "MODE="))
if ($ToolsCache) {
  $KitTools = Join-Path $Kit "tools"
  New-Item -ItemType Directory -Force $KitTools | Out-Null
  Copy-Item (Join-Path $ToolsCache "minikube-$MinikubeVersion") (Join-Path $KitTools "minikube")
  Copy-Item (Join-Path $ToolsCache "kubectl-$KubectlVersion") (Join-Path $KitTools "kubectl")
  Copy-Item (Join-Path $ToolsCache "helm-$HelmVersion/linux-$Arch/helm") (Join-Path $KitTools "helm")
  Write-Lf (Join-Path $KitTools "VERSIONS") ((@(
        "ARCH=$Arch",
        "MINIKUBE=$MinikubeVersion",
        "KUBECTL=$KubectlVersion",
        "HELM=$HelmVersion"
      ) -join "`n") + "`n")
}

# -------------------------------------------------------------------- Windows student kit
# Same cluster content; PowerShell scripts with double-click .cmd launchers, Windows tools,
# MODE=local preset (a student's own computer).
Step "Rendering the Windows student kit"
$winKitName = "shopnow-kit-windows"
$WinKit = Join-Path $Dist $winKitName
if (Test-Path $WinKit) { Remove-Item -Recurse -Force $WinKit }
New-Item -ItemType Directory -Force $WinKit | Out-Null
$winItems = "shopnow.yaml", "kit.env", "README.md", "helm", "charts", "local"
if (-not $Clean) { $winItems += "TICKETS.md" }
foreach ($item in $winItems) { Copy-Item -Recurse (Join-Path $Kit $item) (Join-Path $WinKit $item) }
Get-ChildItem (Join-Path $Root "deploy/student-kit/windows") |
  Where-Object { -not ($Clean -and $_.Name -like "check.*") } |
  ForEach-Object { Copy-Item $_.FullName (Join-Path $WinKit $_.Name) }
[IO.File]::WriteAllText((Join-Path $WinKit "shopnow.env"),
  ([IO.File]::ReadAllText((Join-Path $Kit "shopnow.env")).Replace("`nMODE=`n", "`nMODE=local`n") -replace "`r?`n", "`r`n"),
  (New-Object Text.UTF8Encoding $false))
if ($WinToolsCache) {
  $wt = Join-Path $WinKit "tools"
  New-Item -ItemType Directory -Force $wt | Out-Null
  Copy-Item (Join-Path $WinToolsCache "minikube-$MinikubeVersion.exe") (Join-Path $wt "minikube.exe")
  Copy-Item (Join-Path $WinToolsCache "kubectl-$KubectlVersion.exe") (Join-Path $wt "kubectl.exe")
  Copy-Item (Join-Path $WinToolsCache "helm-$HelmVersion/windows-amd64/helm.exe") (Join-Path $wt "helm.exe")
  Set-Content -Encoding ascii (Join-Path $wt "VERSIONS") @("ARCH=amd64", "MINIKUBE=$MinikubeVersion", "KUBECTL=$KubectlVersion", "HELM=$HelmVersion")
}

# ---------------------------------------------------------------------- instructor kit
Step "Rendering the instructor kit"
$instName = "shopnow-instructor"
$Inst = Join-Path $Dist $instName
if (Test-Path $Inst) { Remove-Item -Recurse -Force $Inst }
New-Item -ItemType Directory -Force $Inst | Out-Null
foreach ($f in "docker-compose.yml", "deploy.sh") { Copy-Lf (Join-Path $Root "deploy/provider-host/$f") (Join-Path $Inst $f) }
Expand-Template (Join-Path $Root "deploy/provider-host/env.template") (Join-Path $Inst ".env")

# ------------------------------------------------------------------------------ archives
Step "Packing"
# Pack in a Linux container so the archive carries Linux permissions: scripts executable,
# env files (secrets) readable by their owner only. Windows tar would make all files 666.
# (Script in a file: Windows PowerShell mangles quotes in native command arguments.)
$packScript = Join-Path $Dist ".pack.sh"
Write-Lf $packScript @'
set -e
tag="$1"; shift
for d in "$@"; do
  rm -rf "/tmp/$d"; cp -r "/dist/$d" "/tmp/$d"
  find "/tmp/$d" -type d -exec chmod 755 {} +
  find "/tmp/$d" -type f -exec chmod 644 {} +
  find "/tmp/$d" -name '*.sh' -exec chmod 755 {} +
  find "/tmp/$d" -name '*.env' -exec chmod 600 {} +
  if [ -d "/tmp/$d/tools" ]; then chmod 755 "/tmp/$d/tools/minikube" "/tmp/$d/tools/kubectl" "/tmp/$d/tools/helm"; fi
  chown -R 0:0 "/tmp/$d"
  tar -czf "/dist/$d-$tag.tar.gz" -C /tmp "$d"
done
'@
try {
  Exec { docker run --rm -v "${Dist}:/dist" alpine:3.22 sh /dist/.pack.sh $Tag $kitName $instName } "pack kits"
} finally {
  Remove-Item $packScript -ErrorAction SilentlyContinue
}
foreach ($name in $kitName, $instName) { Info (Join-Path $Dist "$name-$Tag.tar.gz") }
$winZip = Join-Path $Dist "$winKitName-$Tag.zip"
if (Test-Path $winZip) { Remove-Item -Force $winZip }
Compress-Archive -Path $WinKit -DestinationPath $winZip -CompressionLevel Optimal
Info $winZip

Write-Host @"

  Images            $Registry/shopnow-*:$Tag  (and :latest)$(if (-not $Clean) { "`n                    last night's release: shopnow-order, shopnow-catalog :$BadTag" })
  Kit               $(if ($Clean) { 'clean (no challenges)' } else { 'incident challenges (TICKETS.md, check.sh); answer key: docs/challenges.md' })

  Linux             dist\$kitName-$Tag.tar.gz: extract, set MODE=local (own computer) or
                    MODE=vm (server) in shopnow-kit/shopnow.env, then ./deploy.sh --install-deps
  Windows           dist\$winKitName-$Tag.zip: extract, double-click deploy.cmd (MODE=local)
  Instructor host   copy dist\$instName-$Tag.tar.gz, extract, fill in shopnow-instructor/.env,
                    then ./deploy.sh

  Shared secrets    $SecretsFile (prefilled into both kits)

"@
