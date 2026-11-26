#!/usr/bin/env bash
# ShopNow observability lab: deploy the whole shop on this Ubuntu VM (minikube).
# Nothing is built here; every image is pulled from the course registry.
#
#   1. Fill in shopnow.env (hosts and URLs of THIS VM and of the payment provider).
#   2. ./deploy.sh --install-deps    first time: also installs docker, minikube, kubectl, helm
#      ./deploy.sh                   later runs / updates
#
# Needs: Ubuntu 22.04+/24.04, 4+ CPUs, 12+ GB RAM, 40 GB disk, a normal user in the "docker"
# group (not root), and DNS for SHOP_HOST, MAIL_HOST and SIGNOZ_HOST pointing at this VM.
# Optional environment: MINIKUBE_CPUS, MINIKUBE_MEMORY (e.g. 12g), MINIKUBE_DISK (e.g. 40g),
# ENV_FILE (default: shopnow.env next to this script).
set -euo pipefail

KIT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INSTALL_DEPS=false
for a in "$@"; do
  case "$a" in
    --install-deps) INSTALL_DEPS=true ;;
    -h|--help) sed -n '2,13p' "$0"; exit 0 ;;
    *) echo "unknown option: $a" >&2; exit 2 ;;
  esac
done

# shellcheck source=/dev/null
source "$KIT_DIR/kit.env"   # REGISTRY, TAG, STRIMZI_VERSION (set by the release)
ENV_FILE="${ENV_FILE:-$KIT_DIR/shopnow.env}"
[[ -f "$ENV_FILE" ]] || { echo "missing $ENV_FILE" >&2; exit 1; }
# shellcheck source=/dev/null
source "$ENV_FILE"
REQUIRED=(SHOP_HOST MAIL_HOST SIGNOZ_HOST SHOP_PUBLIC_URL PROVIDER_URL WEBHOOK_CALLBACK_URL
          PROVIDER_API_KEY PROVIDER_WEBHOOK_SECRET SEED_USER_PASSWORD)
missing=()
for v in "${REQUIRED[@]}"; do [[ -n "${!v:-}" ]] || missing+=("$v"); done
if (( ${#missing[@]} )); then
  echo "Fill in these values in $ENV_FILE first: ${missing[*]}" >&2
  exit 1
fi

CTX=minikube
SERVICES=(api-gateway auth catalog cart order inventory payment notification frontend)
step() { printf '\n\033[36m==> %s\033[0m\n' "$*"; }
info() { printf '\033[90m    %s\033[0m\n' "$*"; }
warn() { printf '\033[33mWARNING: %s\033[0m\n' "$*" >&2; }
kube() { kubectl --context "$CTX" "$@"; }

if [[ $EUID -eq 0 ]]; then
  echo "Run this as a normal user (in the docker group), not as root: minikube refuses the docker driver as root." >&2
  exit 1
fi

# ------------------------------------------------------------------------- dependencies
install_deps() {
  step "Installing docker, minikube, kubectl and helm"
  local arch; arch="$(dpkg --print-architecture)"   # amd64 | arm64
  if ! command -v docker >/dev/null; then
    curl -fsSL https://get.docker.com | sudo sh
    sudo usermod -aG docker "$USER"
    warn "you were added to the docker group: log out and back in (or run 'newgrp docker'), then run this script again."
    exit 0
  fi
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

step "Checking prerequisites"
for tool in docker minikube kubectl helm curl; do
  command -v "$tool" >/dev/null || { echo "$tool is missing. Run: $0 --install-deps" >&2; exit 1; }
done
docker info >/dev/null 2>&1 || { echo "cannot talk to Docker. Is it running, and are you in the docker group? (log out/in after adding)" >&2; exit 1; }
for h in "$SHOP_HOST" "$MAIL_HOST" "$SIGNOZ_HOST"; do
  getent hosts "$h" >/dev/null || warn "$h does not resolve (yet). It works once DNS points it at this VM."
done

# ------------------------------------------------------------------------------ cluster
total_mb=$(awk '/MemTotal/ {print int($2/1024)}' /proc/meminfo)
CPUS="${MINIKUBE_CPUS:-$(( $(nproc) < 6 ? $(nproc) : 6 ))}"
MEMORY="${MINIKUBE_MEMORY:-$(( total_mb - 2048 < 12288 ? total_mb - 2048 : 12288 ))m}"
DISK="${MINIKUBE_DISK:-40g}"
step "Starting minikube ($CPUS CPUs, $MEMORY memory) with ports 80/443 published on this VM"
if [[ "$(minikube status --format '{{.Host}}' 2>/dev/null || true)" != "Running" ]]; then
  if minikube profile list -o json 2>/dev/null | grep -q '"Name":"minikube"'; then
    minikube start   # existing cluster: keeps its original settings (incl. published ports)
  else
    minikube start --driver=docker --container-runtime=docker --cpus="$CPUS" --memory="$MEMORY" --disk-size="$DISK" \
      --ports=80:80 --ports=443:443
  fi
else
  info "minikube already running"
fi
minikube addons enable ingress >/dev/null
minikube addons enable metrics-server >/dev/null

# ------------------------------------------------------------------------------ secrets
step "Preparing secrets"
SECRETS_FILE="$KIT_DIR/.secrets.env"
if [[ ! -f "$SECRETS_FILE" ]]; then
  rnd() { LC_ALL=C tr -dc 'abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789' </dev/urandom | head -c "$1" || true; }
  ( umask 077; printf 'POSTGRES_PASSWORD=%s\nINSTRUCTOR_PASSWORD=%s\n' "$(rnd 16)" "$(rnd 16)" > "$SECRETS_FILE" )
  info "generated $SECRETS_FILE"
fi
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

# ------------------------------------------------------------------- operators / charts
step "Installing Strimzi $STRIMZI_VERSION (Kafka operator)"
helm upgrade --install strimzi oci://quay.io/strimzi-helm/strimzi-kafka-operator --version "$STRIMZI_VERSION" \
  --kube-context "$CTX" -n infra --wait --timeout 10m >/dev/null
step "Installing SigNoz (a few minutes the first time)"
helm repo add signoz https://charts.signoz.io --force-update >/dev/null
helm repo update signoz >/dev/null
helm upgrade --install signoz signoz/signoz --kube-context "$CTX" -n platform \
  -f "$KIT_DIR/helm/signoz-values.yaml" --wait --timeout 20m >/dev/null
helm upgrade --install k8s-infra signoz/k8s-infra --kube-context "$CTX" -n platform \
  -f "$KIT_DIR/helm/k8s-infra-values.yaml" --wait --timeout 10m >/dev/null

# ------------------------------------------------------------------------------- the shop
step "Deploying ShopNow $TAG ($REGISTRY) for $SHOP_PUBLIC_URL"
sed -e "s|__SHOP_HOST__|$SHOP_HOST|g" \
    -e "s|__MAIL_HOST__|$MAIL_HOST|g" \
    -e "s|__SIGNOZ_HOST__|$SIGNOZ_HOST|g" \
    -e "s|__SHOP_PUBLIC_URL__|$SHOP_PUBLIC_URL|g" \
    -e "s|__PROVIDER_URL__|$PROVIDER_URL|g" \
    -e "s|__WEBHOOK_CALLBACK_URL__|$WEBHOOK_CALLBACK_URL|g" \
    "$KIT_DIR/shopnow.yaml" | kube apply -f - >/dev/null
# Changed settings only reach running pods on restart; a new image tag rolls them anyway.
for svc in "${SERVICES[@]}"; do kube -n shop rollout restart "deployment/$svc" >/dev/null; done

step "Waiting for infrastructure"
kube -n infra rollout status statefulset/postgres --timeout=300s
kube -n infra rollout status deployment/redis --timeout=300s
kube -n infra rollout status deployment/mailpit --timeout=300s
info "waiting for Kafka (first start can take ~3 minutes)"
kube -n infra wait kafka/kafka --for=condition=Ready --timeout=600s
step "Waiting for the shop (first start pulls the images)"
for svc in "${SERVICES[@]}"; do kube -n shop rollout status "deployment/$svc" --timeout=600s; done

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
# Through this VM's port 80 (what browsers and the payment provider use).
check "storefront   $SHOP_HOST" "200" -H "Host: $SHOP_HOST" http://127.0.0.1/
check "catalog API  /api/catalog/products" "200" -H "Host: $SHOP_HOST" "http://127.0.0.1/api/catalog/products?limit=1"
check "seed login   /api/auth/oauth/token" "200" -H "Host: $SHOP_HOST" -H "content-type: application/json" \
  -d "{\"grant_type\":\"password\",\"username\":\"shopper001\",\"password\":\"$SEED_USER_PASSWORD\"}" http://127.0.0.1/api/auth/oauth/token
check "webhook      unsigned POST -> 4xx" "4*" -X POST -H "content-type: application/json" -d '{}' "$WEBHOOK_CALLBACK_URL"
check "mailpit      $MAIL_HOST" "200" -H "Host: $MAIL_HOST" http://127.0.0.1/
check "signoz       $SIGNOZ_HOST" "200" -H "Host: $SIGNOZ_HOST" http://127.0.0.1/
check "public URL   $SHOP_PUBLIC_URL (via DNS)" "200" "$SHOP_PUBLIC_URL/"
# From inside the cluster: can the payment service reach the provider?
code=$(kube -n shop run "smoke-$RANDOM" --rm -i --restart=Never --image=curlimages/curl:8.11.1 --quiet -- \
  curl -s -o /dev/null -m 10 -w '%{http_code}' "$PROVIDER_URL/health" 2>/dev/null)
if [[ "$code" == *200* ]]; then printf '\033[32m    %-46s OK\033[0m\n' "pod -> payment provider"
else printf '\033[31m    %-46s FAILED (%s)\033[0m\n' "pod -> payment provider" "$code"; fi

cat <<EOF

  ShopNow is running on this VM.

    Shop        $SHOP_PUBLIC_URL
    SigNoz      http://$SIGNOZ_HOST   (create the admin account on first visit;
                                      telemetry starts flowing after that)
    Mailpit     http://$MAIL_HOST

    Accounts    shopper001 .. shopper100 / SEED_USER_PASSWORD from $(basename "$ENV_FILE"),
                or create your own on the Register page
    Secrets     $SECRETS_FILE

    Status      ./status.sh        Remove      ./destroy.sh

EOF
