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

  Shared secrets (MockPay API key / webhook secret / admin token, seed-user password, generator
  token) live in .secrets/shopnow.env and are reused on every release, so a re-deployed VM or
  instructor host keeps working with the other side.
#>
[CmdletBinding()]
param(
  [string]$Tag = (Get-Date -Format "yyyy.MM.dd-HHmm"),
  [string]$Registry = $env:SHOPNOW_REGISTRY,
  [string]$StrimziVersion = "0.48.0",
  [switch]$SkipBuild,
  [switch]$SkipPush
)

$ErrorActionPreference = "Stop"
if (-not $Registry) { throw "Set the registry: -Registry <registry host>/<project>, or `$env:SHOPNOW_REGISTRY" }
$Registry = $Registry.TrimEnd("/")
$Root = Split-Path -Parent $PSScriptRoot
$Dist = Join-Path $Root "dist"

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

# Images: name in the registry -> how to build it.
$images = [ordered]@{}
foreach ($svc in "api-gateway", "auth", "catalog", "cart", "order", "inventory", "payment", "notification") {
  $images["shopnow-$svc"] = @{ Context = $Root; Args = @("--build-arg", "WORKSPACE=services/$svc") }
}
$images["shopnow-frontend"] = @{ Context = (Join-Path $Root "apps/frontend"); Args = @() }
$images["shopnow-payment-provider"] = @{ Context = $Root; Args = @("--build-arg", "WORKSPACE=external/payment-provider", "--build-arg", "INSTRUMENT=false") }
$images["shopnow-traffic-generator"] = @{ Context = $Root; Args = @("--build-arg", "WORKSPACE=tools/traffic-generator", "--build-arg", "INSTRUMENT=false") }

# Build on this PC's Docker, never inside minikube.
foreach ($v in "DOCKER_TLS_VERIFY", "DOCKER_HOST", "DOCKER_CERT_PATH", "MINIKUBE_ACTIVE_DOCKERD") { Remove-Item "Env:$v" -ErrorAction SilentlyContinue }

# ------------------------------------------------------------------------------- build
if (-not $SkipBuild) {
  Step "Building $($images.Count) images (linux/amd64), tag $Tag"
  foreach ($name in $images.Keys) {
    $img = $images[$name]
    $ref = "$Registry/${name}:$Tag"
    Info $ref
    $buildArgs = @("build", "-q", "--platform", "linux/amd64", "-t", $ref, "-t", "$Registry/${name}:latest") + $img.Args + @($img.Context)
    Exec { docker @buildArgs | Out-Null } "build $name"
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

# --------------------------------------------------------------------------- student kit
Step "Rendering the student kit"
$kitName = "shopnow-kit"
$Kit = Join-Path $Dist $kitName
if (Test-Path $Kit) { Remove-Item -Recurse -Force $Kit }
New-Item -ItemType Directory -Force (Join-Path $Kit "helm") | Out-Null
$rendered = Exec { kubectl kustomize (Join-Path $Root "deploy/overlays/vm") } "kubectl kustomize deploy/overlays/vm"
$yaml = ($rendered -join "`n").Replace("KIT_REGISTRY", $Registry).Replace("KIT_TAG", $Tag)
Write-Lf (Join-Path $Kit "shopnow.yaml") ("# ShopNow $Tag - rendered from deploy/overlays/vm by scripts/release.ps1`n" + $yaml + "`n")
foreach ($f in "deploy.sh", "status.sh", "destroy.sh", "README.md") { Copy-Lf (Join-Path $Root "deploy/student-kit/$f") (Join-Path $Kit $f) }
foreach ($f in "signoz-values.yaml", "k8s-infra-values.yaml") { Copy-Lf (Join-Path $Root "deploy/helm/$f") (Join-Path $Kit "helm/$f") }
Write-Lf (Join-Path $Kit "kit.env") ((@(
      "# ShopNow release $Tag (set by scripts/release.ps1). Your settings go in shopnow.env.",
      "REGISTRY=$Registry",
      "TAG=$Tag",
      "STRIMZI_VERSION=$StrimziVersion"
    ) -join "`n") + "`n")
Expand-Template (Join-Path $Root "deploy/student-kit/shopnow.env.template") (Join-Path $Kit "shopnow.env")

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

Write-Host @"

  Images            $Registry/shopnow-*:$Tag  (and :latest)

  Student VMs       copy dist\$kitName-$Tag.tar.gz, extract, fill in shopnow-kit/shopnow.env,
                    then ./deploy.sh --install-deps
  Instructor host   copy dist\$instName-$Tag.tar.gz, extract, fill in shopnow-instructor/.env,
                    then ./deploy.sh

  Shared secrets    $SecretsFile (prefilled into both kits)

"@
