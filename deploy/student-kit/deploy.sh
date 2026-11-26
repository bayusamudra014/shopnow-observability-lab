#!/usr/bin/env bash
# ShopNow observability lab: deploy the whole shop with minikube (Linux or macOS).
# Nothing is built here; every image is pulled from the course registry.
#
#   1. Fill in shopnow.env: MODE=local (your own computer) or MODE=vm (a server), see there.
#   2. ./deploy.sh --install-deps    first time: also installs docker, minikube, kubectl, helm
#      ./deploy.sh                   later runs / updates
#
# Re-running is safe: the shop's manifests (shopnow.yaml) are applied again only when they
# or shopnow.env changed, so changes you made in the cluster with kubectl are kept.
# Needs: Ubuntu 22.04+/24.04 (desktop or server) or macOS 13+ with Docker Desktop, 4+ CPUs and
# 12+ GB of memory for Docker, 40 GB disk, a normal user (not root; on Linux in the "docker"
# group). MODE=vm also needs DNS for its hosts.
# Optional environment: MINIKUBE_CPUS, MINIKUBE_MEMORY (e.g. 12g), MINIKUBE_DISK (e.g. 40g),
# MINIKUBE_PROFILE (default shopnow), ENV_FILE (default: shopnow.env next to this script).
set -euo pipefail

KIT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OS="$(uname -s)"
# macOS: use the kit's own minikube, kubectl and helm (tools/darwin-<arch>), nothing installed.
if [[ "$(uname -s)" == Darwin ]]; then
  case "$(uname -m)" in arm64) _arch=arm64 ;; *) _arch=amd64 ;; esac
  [[ -d "$KIT_DIR/tools/darwin-$_arch" ]] && PATH="$KIT_DIR/tools/darwin-$_arch:$PATH"
fi
INSTALL_DEPS=false
for a in "$@"; do
  case "$a" in
    --install-deps) INSTALL_DEPS=true ;;
    -h|--help) sed -n '2,16p' "$0"; exit 0 ;;
    *) echo "unknown option: $a" >&2; exit 2 ;;
  esac
done

# shellcheck source=/dev/null
source "$KIT_DIR/kit.env"   # REGISTRY, TAG, STRIMZI_VERSION, *_CHART (set by the release)
ENV_FILE="${ENV_FILE:-$KIT_DIR/shopnow.env}"
[[ -f "$ENV_FILE" ]] || { echo "missing $ENV_FILE" >&2; exit 1; }
# Tolerate files saved on Windows (byte-order mark, CRLF line endings). (eval, not
# `source <(...)`: macOS's bash 3.2 silently sources nothing from a process substitution.)
# BSD sed (macOS) knows no hex or CR escapes: build the BOM with printf, drop CRs with tr.
bom="$(printf '\357\273\277')"
eval "$(LC_ALL=C tr -d '\r' < "$ENV_FILE" | LC_ALL=C sed -e "1s/^$bom//")"

MODE="$(echo "${MODE:-}" | tr '[:upper:]' '[:lower:]')"
case "$MODE" in
  local|vm) ;;
  *) echo "Set MODE=local (your own computer) or MODE=vm (a server) in $ENV_FILE" >&2; exit 1 ;;
esac
HTTP_PORT="${HTTP_PORT:-80}"
MOCKPAY_PORT="${MOCKPAY_PORT:-8090}"
PROFILE="${MINIKUBE_PROFILE:-shopnow}"
if [[ "$MODE" == local ]]; then
  SHOP_HOST="${SHOP_HOST:-shop.localhost}"
  MAIL_HOST="${MAIL_HOST:-mail.$SHOP_HOST}"
  SIGNOZ_HOST="${SIGNOZ_HOST:-signoz.$SHOP_HOST}"
  port_suffix=""; [[ "$HTTP_PORT" == 80 ]] || port_suffix=":$HTTP_PORT"
  SHOP_PUBLIC_URL="${SHOP_PUBLIC_URL:-http://$SHOP_HOST$port_suffix}"
  REQUIRED=(PROVIDER_API_KEY PROVIDER_WEBHOOK_SECRET SEED_USER_PASSWORD)
else
  REQUIRED=(SHOP_HOST MAIL_HOST SIGNOZ_HOST SHOP_PUBLIC_URL PROVIDER_URL WEBHOOK_CALLBACK_URL
            PROVIDER_API_KEY PROVIDER_WEBHOOK_SECRET SEED_USER_PASSWORD)
fi
missing=()
for v in "${REQUIRED[@]}"; do [[ -n "${!v:-}" ]] || missing+=("$v"); done
if (( ${#missing[@]} )); then
  echo "MODE=$MODE: fill in these values in $ENV_FILE first: ${missing[*]}" >&2
  exit 1
fi

CTX="$PROFILE"
SERVICES=(api-gateway auth catalog cart order inventory payment notification frontend)
step() { printf '\n\033[36m==> %s\033[0m\n' "$*"; }
info() { printf '\033[90m    %s\033[0m\n' "$*"; }
warn() { printf '\033[33mWARNING: %s\033[0m\n' "$*" >&2; }
kube() { kubectl --context "$CTX" "$@"; }
mk() { minikube -p "$PROFILE" "$@"; }

if [[ $EUID -eq 0 ]]; then
  echo "Run this as a normal user (in the docker group), not as root: minikube refuses the docker driver as root." >&2
  exit 1
fi

# ------------------------------------------------------------------------- dependencies
# minikube, kubectl and helm ship in tools/ (pinned versions): install them without internet.
install_bundled_tools() {
  local dir="$KIT_DIR/tools" arch want t
  [[ "$OS" == Linux && -f "$dir/VERSIONS" ]] || return 0
  arch="$(dpkg --print-architecture 2>/dev/null || uname -m)"
  case "$arch" in x86_64) arch=amd64 ;; aarch64) arch=arm64 ;; esac
  want="$(sed -n 's/^ARCH=//p' "$dir/VERSIONS")"
  if [[ "$arch" != "$want" ]]; then
    warn "bundled tools are for $want but this machine is $arch; they will be downloaded instead"
    return 0
  fi
  for t in minikube kubectl helm; do
    if ! command -v "$t" >/dev/null && [[ -f "$dir/$t" ]]; then
      info "installing $t from the kit ($(sed -n "s/^$(echo "$t" | tr '[:lower:]' '[:upper:]')=//p" "$dir/VERSIONS"), offline)"
      sudo install -m 0755 "$dir/$t" "/usr/local/bin/$t"
    fi
  done
}

install_deps() {
  if [[ "$OS" == Darwin ]]; then
    command -v docker >/dev/null || { echo "Install Docker Desktop for Mac (https://docs.docker.com/desktop/setup/install/mac-install/), start it, then run this again." >&2; exit 1; }
    return 0   # minikube, kubectl and helm come with the kit (tools/)
  fi
  step "Installing docker, minikube, kubectl and helm"
  local arch; arch="$(dpkg --print-architecture)"   # amd64 | arm64
  if ! command -v docker >/dev/null; then
    curl -fsSL https://get.docker.com | sudo sh
    sudo usermod -aG docker "$USER"
    warn "you were added to the docker group: log out and back in (or run 'newgrp docker'), then run this script again."
    exit 0
  fi
  install_bundled_tools
  # Fallback when the kit was released without tools/ (release.ps1 -NoTools): download.
  if ! command -v minikube >/dev/null; then
    curl -fLo /tmp/minikube "https://storage.googleapis.com/minikube/releases/latest/minikube-linux-${arch}"
    sudo install /tmp/minikube /usr/local/bin/minikube && rm /tmp/minikube
  fi
  if ! command -v kubectl >/dev/null; then
    local v; v="$(curl -fsSL https://dl.k8s.io/release/stable.txt)"
    curl -fLo /tmp/kubectl "https://dl.k8s.io/release/${v}/bin/linux/${arch}/kubectl"
    sudo install /tmp/kubectl /usr/local/bin/kubectl && rm /tmp/kubectl
  fi
  if ! command -v helm >/dev/null; then
    curl -fsSL "https://get.helm.sh/helm-v4.3.2-linux-${arch}.tar.gz" | tar -xz -C /tmp
    sudo install "/tmp/linux-${arch}/helm" /usr/local/bin/helm && rm -rf "/tmp/linux-${arch}"
  fi
}
$INSTALL_DEPS && install_deps

step "Checking prerequisites (MODE=$MODE)"
install_bundled_tools
for tool in docker minikube kubectl helm curl; do
  command -v "$tool" >/dev/null || { echo "$tool is missing. Run: $0 --install-deps" >&2; exit 1; }
done
if ! docker info >/dev/null 2>&1; then
  if [[ "$OS" == Darwin ]]; then echo "Docker is not running. Start Docker Desktop, wait until it says 'Engine running', then run this again." >&2
  else echo "cannot talk to Docker. Is it running, and are you in the docker group? (log out/in after adding)" >&2; fi
  exit 1
fi
if [[ "$OS" == Darwin ]]; then
  # Files unpacked from a download are quarantined; macOS would refuse to run the kit's tools.
  xattr -dr com.apple.quarantine "$KIT_DIR/tools" 2>/dev/null || true
fi
if [[ "$MODE" == vm ]]; then
  for h in "$SHOP_HOST" "$MAIL_HOST" "$SIGNOZ_HOST"; do
    { getent hosts "$h" || host "$h"; } >/dev/null 2>&1 || warn "$h does not resolve (yet). It works once DNS points it at this VM."
  done
fi

# ------------------------------------------------------------------------------ cluster
# What Docker can use (on macOS: Docker Desktop's VM, not the whole Mac).
total_mb=$(( $(docker info --format '{{.MemTotal}}') / 1024 / 1024 ))
ncpu="$(docker info --format '{{.NCPU}}')"
CPUS="${MINIKUBE_CPUS:-$(( ncpu < 6 ? ncpu : 6 ))}"
if (( total_mb < 10 * 1024 )); then
  warn "Docker has only $(( total_mb / 1024 )) GB of memory; give it 12 GB or more (Docker Desktop: Settings > Resources)"
fi
MEMORY="${MINIKUBE_MEMORY:-$(( total_mb - 2048 < 12288 ? total_mb - 2048 : 12288 ))m}"
DISK="${MINIKUBE_DISK:-40g}"
step "Starting minikube profile '$PROFILE' ($CPUS CPUs, $MEMORY memory), port $HTTP_PORT -> ingress"
if [[ "$(mk status --format '{{.Host}}' 2>/dev/null || true)" != "Running" ]]; then
  if minikube profile list -o json 2>/dev/null | grep -q "\"Name\":\"$PROFILE\""; then
    mk start   # existing cluster: keeps its original settings (incl. the published port)
  else
    mk start --driver=docker --container-runtime=docker --cpus="$CPUS" --memory="$MEMORY" --disk-size="$DISK" \
      --ports="$HTTP_PORT:80"
  fi
else
  info "minikube already running"
fi
mk addons enable ingress >/dev/null
mk addons enable metrics-server >/dev/null
MINIKUBE_IP="$(mk ip | tr -d '[:space:]')"

# ------------------------------------------------------------------------------ secrets
step "Preparing secrets"
SECRETS_FILE="$KIT_DIR/.secrets.env"
rnd() { LC_ALL=C tr -dc 'abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789' </dev/urandom | head -c "$1" || true; }
touch "$SECRETS_FILE"; chmod 600 "$SECRETS_FILE"
for k in POSTGRES_PASSWORD:16 INSTRUCTOR_PASSWORD:16 PROVIDER_DB_PASSWORD:16 PROVIDER_ADMIN_TOKEN:32; do
  name="${k%%:*}"
  grep -q "^$name=" "$SECRETS_FILE" || printf '%s=%s\n' "$name" "$(rnd "${k##*:}")" >> "$SECRETS_FILE"
done
# shellcheck source=/dev/null
source "$SECRETS_FILE"

for ns in shop infra external platform; do
  kube create namespace "$ns" --dry-run=client -o yaml | kube apply -f - >/dev/null
done
kube -n shop create secret generic shop-secrets --dry-run=client -o yaml \
  --from-literal=POSTGRES_PASSWORD="$POSTGRES_PASSWORD" \
  --from-literal=SEED_USER_PASSWORD="$SEED_USER_PASSWORD" \
  --from-literal=INSTRUCTOR_PASSWORD="$INSTRUCTOR_PASSWORD" \
  --from-literal=PROVIDER_API_KEY="$PROVIDER_API_KEY" \
  --from-literal=PROVIDER_WEBHOOK_SECRET="$PROVIDER_WEBHOOK_SECRET" | kube apply -f - >/dev/null
kube -n infra create secret generic postgres-credentials --dry-run=client -o yaml \
  --from-literal=POSTGRES_PASSWORD="$POSTGRES_PASSWORD" | kube apply -f - >/dev/null

# ------------------------------------------------------------------- local payment provider
if [[ "$MODE" == local ]]; then
  # MockPay runs here in Docker, on minikube's network, at a fixed address (.100).
  PROVIDER_IP="${MINIKUBE_IP%.*}.100"
  PROVIDER_URL="http://$PROVIDER_IP:8080"
  # Inside the Docker network the ingress listens on the node's port 80.
  WEBHOOK_CALLBACK_URL="http://$SHOP_HOST/webhooks/payment-provider"
  step "Starting the local payment provider (MockPay) at $PROVIDER_IP"
  MOCKPAY_ENV="$KIT_DIR/.mockpay.env"
  ( umask 077; cat > "$MOCKPAY_ENV" <<EOF
REGISTRY=$REGISTRY
TAG=$TAG
PROVIDER_API_KEY=$PROVIDER_API_KEY
PROVIDER_WEBHOOK_SECRET=$PROVIDER_WEBHOOK_SECRET
PROVIDER_ADMIN_TOKEN=$PROVIDER_ADMIN_TOKEN
PROVIDER_DB_PASSWORD=$PROVIDER_DB_PASSWORD
MINIKUBE_NETWORK=$PROFILE
MINIKUBE_IP=$MINIKUBE_IP
PROVIDER_IP=$PROVIDER_IP
SHOP_HOST=$SHOP_HOST
MOCKPAY_PORT=$MOCKPAY_PORT
CHAOS_SCHEDULE=$([[ "${LAB:-}" == challenges ]] && echo slow-waves)
EOF
  )
  docker compose -f "$KIT_DIR/local/mockpay-compose.yml" --env-file "$MOCKPAY_ENV" up -d --wait
fi

# ------------------------------------------------------------------- operators / charts
# Charts come with the kit (charts/): no chart repositories, nothing from GitHub.

# A run interrupted during `helm upgrade --wait` (Ctrl+C, dropped SSH, timeout) leaves the
# release pending-install/-upgrade/-rollback, and Helm then refuses every later upgrade with
# "another operation is in progress". Recover: roll back to the last good revision, or
# uninstall if the release never finished installing.
helm_unstick() {
  local rel="$1" ns="$2"
  helm list --kube-context "$CTX" -n "$ns" --pending -q --filter "^${rel}\$" 2>/dev/null | grep -qx "$rel" || return 0
  if pgrep -x helm >/dev/null; then
    echo "Another helm command is still running on this machine. Wait for it to finish (or stop it), then run $0 again." >&2
    exit 1
  fi
  if helm history "$rel" --kube-context "$CTX" -n "$ns" -o json 2>/dev/null | grep -Eq '"status":"(deployed|superseded)"'; then
    warn "Helm release '$rel' was left half-finished by an earlier run; rolling it back first"
    helm rollback "$rel" --kube-context "$CTX" -n "$ns" --wait --timeout 10m >/dev/null
  else
    warn "Helm release '$rel' never finished installing in an earlier run; removing it to start over"
    helm uninstall "$rel" --kube-context "$CTX" -n "$ns" --wait --timeout 10m >/dev/null
  fi
}

step "Installing Strimzi $STRIMZI_VERSION (Kafka operator)"
helm_unstick strimzi infra
helm upgrade --install strimzi "$KIT_DIR/$STRIMZI_CHART" \
  --kube-context "$CTX" -n infra --wait --timeout 10m >/dev/null
step "Installing SigNoz (a few minutes the first time)"
helm_unstick signoz platform
helm upgrade --install signoz "$KIT_DIR/$SIGNOZ_CHART" --kube-context "$CTX" -n platform \
  -f "$KIT_DIR/helm/signoz-values.yaml" -f "$KIT_DIR/helm/signoz-values-no-github.yaml" --wait --timeout 20m >/dev/null
helm_unstick k8s-infra platform
helm upgrade --install k8s-infra "$KIT_DIR/$K8S_INFRA_CHART" --kube-context "$CTX" -n platform \
  -f "$KIT_DIR/helm/k8s-infra-values.yaml" --wait --timeout 10m >/dev/null

# ------------------------------------------------------------------------------- the shop
step "Deploying ShopNow $TAG ($REGISTRY) for $SHOP_PUBLIC_URL"
RENDERED="$(mktemp)"; trap 'rm -f "$RENDERED"' EXIT
sed -e "s|__SHOP_HOST__|$SHOP_HOST|g" \
    -e "s|__MAIL_HOST__|$MAIL_HOST|g" \
    -e "s|__SIGNOZ_HOST__|$SIGNOZ_HOST|g" \
    -e "s|__SHOP_PUBLIC_URL__|$SHOP_PUBLIC_URL|g" \
    -e "s|__PROVIDER_URL__|$PROVIDER_URL|g" \
    -e "s|__WEBHOOK_CALLBACK_URL__|$WEBHOOK_CALLBACK_URL|g" \
    "$KIT_DIR/shopnow.yaml" > "$RENDERED"
sha() { if command -v sha256sum >/dev/null; then sha256sum; else shasum -a 256; fi; }
hash="$(sha < "$RENDERED" | cut -c1-16)"
state() { kube -n shop get configmap shopnow-kit-state -o "jsonpath={.data.$1}" 2>/dev/null || true; }
prev_tag="$(state kitTag)"; prev_hash="$(state appliedHash)"; prev_update="$(state updateTag)"
if ! kube -n shop get configmap shopnow-kit-state >/dev/null 2>&1 && kube -n shop get deployment order >/dev/null 2>&1 \
   && [[ "${LAB:-}" == challenges ]]; then
  cat >&2 <<EOF
This cluster was set up with an older kit. Reset only the shop (SigNoz, Kafka and Postgres stay),
keep the old kit's .secrets.env in this folder, then run ./deploy.sh again:
  kubectl --context $CTX delete namespace shop
  kubectl --context $CTX -n infra delete kafkatopic order.placed order.confirmed order.cancelled
EOF
  exit 1
fi
if [[ "$prev_tag" == "$TAG" && "$prev_hash" == "$hash" ]]; then
  info "shopnow.yaml and shopnow.env are unchanged since the last deploy: not re-applied (your changes in the cluster are kept)"
else
  if [[ -n "$prev_tag" ]]; then
    warn "shopnow.yaml or shopnow.env changed: re-applying the shop's manifests (changes made only with kubectl are reset)"
  fi
  if [[ "$prev_tag" == "$TAG" ]]; then
    # Same release: keep whatever image order/catalog run now (a rollout or rollback stays).
    for d in order catalog; do
      live="$(kube -n shop get deployment "$d" -o 'jsonpath={.spec.template.spec.containers[0].image}' 2>/dev/null || true)"
      # (no sed -i: GNU and BSD/macOS sed disagree on its syntax)
      if [[ -n "$live" ]]; then
        sed "s|image: $REGISTRY/shopnow-$d:.*|image: $live|" "$RENDERED" > "$RENDERED.new" && mv "$RENDERED.new" "$RENDERED"
      fi
    done
  fi
  cm_before="$(kube -n shop get configmap shop-common -o 'jsonpath={.data}' 2>/dev/null | sha)"
  kube apply -f "$RENDERED" >/dev/null
  cm_after="$(kube -n shop get configmap shop-common -o 'jsonpath={.data}' 2>/dev/null | sha)"
  # Changed settings only reach running pods on restart.
  if [[ -n "$prev_tag" && "$cm_before" != "$cm_after" ]]; then
    info "settings changed: restarting the shop's services"
    for svc in "${SERVICES[@]}"; do kube -n shop rollout restart "deployment/$svc" >/dev/null; done
  fi
fi

step "Waiting for infrastructure"
kube -n infra rollout status statefulset/postgres --timeout=300s
kube -n infra rollout status deployment/redis --timeout=300s
kube -n infra rollout status deployment/mailpit --timeout=300s
info "waiting for Kafka (first start can take ~3 minutes)"
kube -n infra wait kafka/kafka --for=condition=Ready --timeout=600s
step "Waiting for the shop (first start pulls the images)"
# Wait until a deployment's pods are ready; give up on it (with a warning) when one of its
# pods keeps crashing, instead of waiting the full timeout.
wait_deploy() {
  local d="$1" deadline=$((SECONDS + 600)) want ready restarts
  while (( SECONDS < deadline )); do
    # (|| true: a failed lookup, e.g. while the API server is busy, just means "not yet")
    want="$(kube -n shop get deployment "$d" -o 'jsonpath={.spec.replicas}' 2>/dev/null || true)"
    ready="$(kube -n shop get deployment "$d" -o 'jsonpath={.status.updatedReplicas}/{.status.readyReplicas}/{.status.replicas}' 2>/dev/null || true)"
    if [[ -n "$want" && "$ready" == "$want/$want/$want" ]]; then info "$d ready"; return 0; fi
    restarts="$(kube -n shop get pods -l "app=$d" -o 'jsonpath={range .items[*]}{.status.containerStatuses[0].restartCount}{" "}{end}' 2>/dev/null || true)"
    for r in $restarts; do
      if (( r >= 3 )); then warn "$d keeps restarting (see ./status.sh); continuing"; return 0; fi
    done
    sleep 5
  done
  warn "$d is not ready after 10 minutes (see ./status.sh); continuing"
}
for svc in "${SERVICES[@]}"; do wait_deploy "$svc"; done

# A release rolled out over the first install, like an update shipped later (once).
if [[ -n "${UPDATE_TAG:-}" && "$prev_update" != "$UPDATE_TAG" ]]; then
  step "Rolling out release $UPDATE_TAG"
  # Image first, then the note: the note then lands on the new revision only.
  kube -n shop set image deployment/order "order=$REGISTRY/shopnow-order:$UPDATE_TAG" >/dev/null
  kube -n shop annotate deployment/order --overwrite kubernetes.io/change-cause="release $UPDATE_TAG: bulk pricing for premium items" >/dev/null
  kube -n shop set image deployment/catalog "catalog=$REGISTRY/shopnow-catalog:$UPDATE_TAG" >/dev/null
  kube -n shop annotate deployment/catalog --overwrite kubernetes.io/change-cause="release $UPDATE_TAG: catalog dependency updates" >/dev/null
  wait_deploy order
  wait_deploy catalog
  prev_update="$UPDATE_TAG"
fi
kube -n shop create configmap shopnow-kit-state --dry-run=client -o yaml \
  --from-literal=kitTag="$TAG" --from-literal=appliedHash="$hash" --from-literal=updateTag="${prev_update:-}" | kube apply -f - >/dev/null

# ----------------------------------------------------------------------------- smoke test
step "Smoke tests"
set +e
check() {
  local name="$1" want="$2"; shift 2
  local code; code=$(curl -s -o /dev/null -m 10 -w '%{http_code}' "$@")
  # shellcheck disable=SC2053  # $want is a glob on purpose, e.g. 4* for "any client error"
  if [[ "$code" == $want ]]; then printf '\033[32m    %-46s OK (%s)\033[0m\n' "$name" "$code"
  else printf '\033[31m    %-46s FAILED (%s)\033[0m\n' "$name" "$code"; fi
}
BASE="http://127.0.0.1:$HTTP_PORT"
check "storefront   $SHOP_HOST" "200" -H "Host: $SHOP_HOST" "$BASE/"
check "catalog API  /api/catalog/products" "200" -H "Host: $SHOP_HOST" "$BASE/api/catalog/products?limit=1"
check "seed login   /api/auth/oauth/token" "200" -H "Host: $SHOP_HOST" -H "content-type: application/json" \
  -d "{\"grant_type\":\"password\",\"username\":\"shopper001\",\"password\":\"$SEED_USER_PASSWORD\"}" "$BASE/api/auth/oauth/token"
if [[ "${LAB:-}" != challenges ]]; then
  check "webhook      unsigned POST -> 4xx" "4*" -H "Host: $SHOP_HOST" -X POST -H "content-type: application/json" -d '{}' \
    "$BASE/webhooks/payment-provider"
fi
check "mailpit      $MAIL_HOST" "200" -H "Host: $MAIL_HOST" "$BASE/"
check "signoz       $SIGNOZ_HOST" "200" -H "Host: $SIGNOZ_HOST" "$BASE/"
if [[ "$MODE" == vm ]]; then
  check "public URL   $SHOP_PUBLIC_URL (via DNS)" "200" "$SHOP_PUBLIC_URL/"
else
  check "browser URL  $SHOP_PUBLIC_URL" "200" "$SHOP_PUBLIC_URL/"
  check "mockpay      http://localhost:$MOCKPAY_PORT/health" "200" "http://127.0.0.1:$MOCKPAY_PORT/health"
fi
# From inside the cluster: can the payment service reach the provider?
code=$(kube -n shop run "smoke-$RANDOM" --rm -i --restart=Never --image=curlimages/curl:8.11.1 --quiet -- \
  curl -s -o /dev/null -m 10 -w '%{http_code}' "$PROVIDER_URL/health" 2>/dev/null)
if [[ "$code" == *200* ]]; then printf '\033[32m    %-46s OK\033[0m\n' "pod -> payment provider"
else printf '\033[31m    %-46s FAILED (%s)\033[0m\n' "pod -> payment provider" "$code"; fi

mockpay_line=""
[[ "$MODE" == local ]] && mockpay_line="    MockPay     http://localhost:$MOCKPAY_PORT/admin   (token: PROVIDER_ADMIN_TOKEN in .secrets.env)"
cat <<EOF

  ShopNow is running (MODE=$MODE, minikube profile $PROFILE).

    Shop        $SHOP_PUBLIC_URL
    SigNoz      http://$SIGNOZ_HOST${port_suffix:-}   (create the admin account on first visit;
                                      telemetry starts flowing after that)
    Mailpit     http://$MAIL_HOST${port_suffix:-}
$mockpay_line

    Accounts    shopper001 .. shopper100 / SEED_USER_PASSWORD from $(basename "$ENV_FILE"),
                or create your own on the Register page
    Secrets     $SECRETS_FILE

    Status      ./status.sh        Remove      ./destroy.sh
$([[ "${LAB:-}" == challenges ]] && printf '    Tickets     TICKETS.md         Check       ./check.sh\n')

EOF
