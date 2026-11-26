<#
.SYNOPSIS
  Renders the ShopNow student kit on Windows from images that are already in the registry
  (no build, no push). Optionally renders one ready-to-run kit per VM.

.DESCRIPTION
  Uses scripts/release.ps1 with -SkipBuild -SkipPush, so the kit contents (manifests, charts,
  offline tools, shared secrets) are exactly what a release produces.

    # generic kits: Linux (MODE=local or vm, set in shopnow.env) and Windows (MODE=local)
    .\scripts\render-student-kit.ps1 -Registry <registry host>/<project> -Tag 1.0.0

    # plus one Linux kit per VM (MODE=vm), shopnow.env already filled in from your env files
    .\scripts\render-student-kit.ps1 -Registry <registry host>/<project> -Tag 1.0.0 `
        -VmEnvFile .\vms\node1.env, .\vms\node2.env

  A VM env file holds the per-VM settings (see deploy/student-kit/vm.env.example):
    SHOP_HOST, MAIL_HOST, SIGNOZ_HOST, SHOP_PUBLIC_URL, PROVIDER_URL, WEBHOOK_CALLBACK_URL
  Its file name (without .env) names the kit: dist\shopnow-kit-<name>-<tag>.tar.gz.

  -Tag is required and must be a tag that was pushed with release.ps1, otherwise the VMs
  cannot pull the images. -Clean renders the kit without the incident challenges.
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory)][string]$Tag,
  [string]$Registry = $env:SHOPNOW_REGISTRY,
  [string[]]$VmEnvFile = @(),
  [ValidateSet("amd64", "arm64")][string]$Arch = "amd64",
  [switch]$NoTools,
  # Kit without the incident challenges (see release.ps1).
  [switch]$Clean,
  [string]$BadTag
)

$ErrorActionPreference = "Stop"
if (-not $Registry) { throw "Set the registry: -Registry <registry host>/<project>, or `$env:SHOPNOW_REGISTRY" }
$Root = Split-Path -Parent $PSScriptRoot
$Dist = Join-Path $Root "dist"
$Required = "SHOP_HOST", "MAIL_HOST", "SIGNOZ_HOST", "SHOP_PUBLIC_URL", "PROVIDER_URL", "WEBHOOK_CALLBACK_URL"

function Step([string]$Message) { Write-Host "`n==> $Message" -ForegroundColor Cyan }
function Info([string]$Message) { Write-Host "    $Message" -ForegroundColor DarkGray }
function Write-Lf([string]$Path, [string]$Text) {
  [IO.File]::WriteAllText($Path, ($Text -replace "`r`n", "`n"), (New-Object Text.UTF8Encoding $false))
}
function Read-EnvFile([string]$Path) {
  $values = [ordered]@{}
  foreach ($line in [IO.File]::ReadAllLines($Path)) {
    if ($line -match '^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$') { $values[$Matches[1]] = $Matches[2].Trim('"', "'") }
  }
  $values
}

# Check the VM env files before doing any work.
$vms = @()
foreach ($f in $VmEnvFile) {
  if (-not (Test-Path $f)) { throw "VM env file not found: $f" }
  $values = Read-EnvFile (Resolve-Path $f)
  $missing = $Required | Where-Object { -not $values[$_] }
  if ($missing) { throw "$f is missing: $($missing -join ', ')" }
  $name = [IO.Path]::GetFileNameWithoutExtension($f)
  if ($name -notmatch '^[A-Za-z0-9._-]+$') { throw "use a simple file name for $f (letters, digits, . _ -)" }
  $vms += [pscustomobject]@{ Name = $name; Values = $values; File = $f }
}

# ------------------------------------------------------------------ generic kit (release)
Step "Rendering the student kit $Tag for $Registry (no build, no push)"
$releaseArgs = @{ Registry = $Registry; Tag = $Tag; Arch = $Arch; SkipBuild = $true; SkipPush = $true }
if ($NoTools) { $releaseArgs.NoTools = $true }
if ($Clean) { $releaseArgs.Clean = $true }
if ($BadTag) { $releaseArgs.BadTag = $BadTag }
& (Join-Path $PSScriptRoot "release.ps1") @releaseArgs | Out-Null
$Kit = Join-Path $Dist "shopnow-kit"
if (-not (Test-Path (Join-Path $Kit "shopnow.env"))) { throw "release.ps1 did not produce $Kit" }
Info "generic kit: $(Join-Path $Dist "shopnow-kit-$Tag.tar.gz")"

# ------------------------------------------------------------------------- per-VM kits
if ($vms.Count -gt 0) {
  Step "Rendering $($vms.Count) per-VM kit(s)"
  $template = [IO.File]::ReadAllText((Join-Path $Kit "shopnow.env"))
  $packNames = @()
  foreach ($vm in $vms) {
    $dirName = "shopnow-kit-$($vm.Name)"
    $dir = Join-Path $Dist $dirName
    if (Test-Path $dir) { Remove-Item -Recurse -Force $dir }
    Copy-Item -Recurse $Kit $dir
    # Fill this VM's values into shopnow.env; shared secrets stay as the release set them.
    $text = [regex]::Replace($template, "(?m)^MODE=.*$", "MODE=vm")
    foreach ($k in $Required) {
      $v = $vm.Values[$k]
      $text = [regex]::Replace($text, "(?m)^$k=.*$", { param($m) "$k=$v" })
    }
    Write-Lf (Join-Path $dir "shopnow.env") $text
    $packNames += $dirName
    Info "$dirName  <- $($vm.File)  ($($vm.Values.SHOP_PUBLIC_URL))"
  }

  # Pack with Linux permissions (scripts executable, env files owner-only), like release.ps1.
  $packScript = Join-Path $Dist ".pack.sh"
  Write-Lf $packScript @'
set -e
tag="$1"; shift
for d in "$@"; do
  rm -rf "/tmp/$d"; cp -r "/dist/$d" "/tmp/shopnow-kit"
  find /tmp/shopnow-kit -type d -exec chmod 755 {} +
  find /tmp/shopnow-kit -type f -exec chmod 644 {} +
  find /tmp/shopnow-kit -name '*.sh' -exec chmod 755 {} +
  find /tmp/shopnow-kit -name '*.env' -exec chmod 600 {} +
  if [ -d /tmp/shopnow-kit/tools ]; then chmod 755 /tmp/shopnow-kit/tools/minikube /tmp/shopnow-kit/tools/kubectl /tmp/shopnow-kit/tools/helm; fi
  chown -R 0:0 /tmp/shopnow-kit
  # Every archive extracts to shopnow-kit/, whatever VM it is for.
  tar -czf "/dist/$d-$tag.tar.gz" -C /tmp shopnow-kit
  rm -rf /tmp/shopnow-kit
done
'@
  try {
    $saved = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    docker run --rm -v "${Dist}:/dist" alpine:3.22 sh /dist/.pack.sh $Tag @packNames 2>&1 | ForEach-Object { "$_" } | Write-Host
    $code = $LASTEXITCODE
    $ErrorActionPreference = $saved
    if ($code -ne 0) { throw "packing per-VM kits failed (exit code $code)" }
  } finally {
    Remove-Item $packScript -ErrorAction SilentlyContinue
  }
}

Step "Done"
Write-Host "    $(Join-Path $Dist "shopnow-kit-$Tag.tar.gz")   Linux: set MODE=local or MODE=vm in shopnow.env"
Write-Host "    $(Join-Path $Dist "shopnow-kit-windows-$Tag.zip")   Windows: extract, double-click deploy.cmd"
Write-Host "    $(Join-Path $Dist "shopnow-kit-macos-arm64-$Tag.tar.gz") / -amd64   macOS (Apple Silicon / Intel): ./deploy.sh"
foreach ($vm in $vms) {
  Write-Host "    $(Join-Path $Dist "shopnow-kit-$($vm.Name)-$Tag.tar.gz")   for $($vm.Values.SHOP_HOST): ready to run"
}
Write-Host @"

  Linux:     tar -xzf <kit>.tar.gz && cd shopnow-kit && ./deploy.sh --install-deps

"@
