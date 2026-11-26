#!/usr/bin/env bash
# Deploys the whole observability lab: minikube + SigNoz + Kafka + the shop, and the two
# "outside" Docker Compose projects (payment provider, traffic generator).
# Bash port of deploy.ps1 for Linux / macOS (and Git Bash / WSL). Safe to re-run.
#
#   ./scripts/deploy.sh                       # everything
#   ./scripts/deploy.sh --skip-external       # only the cluster
#   ./scripts/deploy.sh --only catalog,order  # rebuild + restart just these services
#   ./scripts/deploy.sh --skip-build          # re-apply manifests without building images
#
# Options: --cpus N (6)  --memory 12g  --disk-size 40g  --strimzi-version 0.48.0
# Needs: docker, minikube, kubectl, helm.
set -euo pipefail

SKIP_BUILD=false
SKIP_EXTERNAL=false
ONLY=""
CPUS=6
MEMORY=12g
DISK_SIZE=40g
STRIMZI_VERSION=0.48.0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --skip-build) SKIP_BUILD=true ;;
    --skip-external) SKIP_EXTERNAL=true ;;
    --only) ONLY="$2"; shift ;;
    --cpus) CPUS="$2"; shift ;;
    --memory) MEMORY="$2"; shift ;;
    --disk-size) DISK_SIZE="$2"; shift ;;
    --strimzi-version) STRIMZI_VERSION="$2"; shift ;;
    -h|--help) sed -n '2,13p' "$0"; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
  shift
done

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CTX=minikube
SERVICES=(api-gateway auth catalog cart order inventory payment notification)

step() { printf '\n\033[36m==> %s\033[0m\n' "$*"; }
info() { printf '\033[90m    %s\033[0m\n' "$*"; }
warn() { printf '\033[33mWARNING: %s\033[0m\n' "$*" >&2; }
kube() { kubectl --context "$CTX" "$@"; }
clear_minikube_docker_env() { unset DOCKER_TLS_VERIFY DOCKER_HOST DOCKER_CERT_PATH MINIKUBE_ACTIVE_DOCKERD; }

# ---------------------------------------------------------------------------- preflight
step "Checking prerequisites"
for tool in docker minikube kubectl helm; do
  command -v "$tool" >/dev/null || { echo "$tool is not installed or not on PATH." >&2; exit 1; }
done
clear_minikube_docker_env
docker info --format '{{.ServerVersion}}' >/dev/null || { echo "docker info failed (is Docker running?)" >&2; exit 1; }
docker_mem_gb=$(( $(docker info --format '{{.MemTotal}}') / 1024 / 1024 / 1024 ))
info "Docker has ${docker_mem_gb} GB of memory"
want_gb=${MEMORY//[^0-9]/}
if (( docker_mem_gb < want_gb + 1 )); then
  warn "Docker has less than $((want_gb + 1)) GB. Give Docker more memory or pass --memory."
fi

# ------------------------------------------------------------------------------ cluster
step "Starting minikube (driver=docker, $CPUS CPUs, $MEMORY memory)"
if [[ "$(minikube status --format '{{.Host}}' 2>/dev/null || true)" != "Running" ]]; then
  minikube start --driver=docker --container-runtime=docker --cpus="$CPUS" --memory="$MEMORY" --disk-size="$DISK_SIZE"
else
  info "minikube already running"
fi
minikube addons enable ingress >/dev/null
minikube addons enable metrics-server >/dev/null
MINIKUBE_IP="$(minikube ip | tr -d '[:space:]')"
PROVIDER_IP="${MINIKUBE_IP%.*}.100"
info "minikube node IP $MINIKUBE_IP, payment provider $PROVIDER_IP"

# ------------------------------------------------------------------------------ secrets
step "Preparing secrets (.secrets/secrets.env)"
SECRETS_DIR="$ROOT/.secrets"
SECRETS_FILE="$SECRETS_DIR/secrets.env"
mkdir -p "$SECRETS_DIR"
KEYS=(POSTGRES_PASSWORD SEED_USER_PASSWORD INSTRUCTOR_PASSWORD PROVIDER_DB_PASSWORD
      PROVIDER_API_KEY PROVIDER_WEBHOOK_SECRET PROVIDER_ADMIN_TOKEN TRAFFIC_CONTROL_TOKEN)
if [[ -f "$SECRETS_FILE" ]]; then
  # The file may have been written by deploy.ps1 (CRLF line endings).
  while IFS='=' read -r k v; do
    [[ "$k" =~ ^[A-Z_]+$ ]] && printf -v "$k" '%s' "${v%$'\r'}"
  done < "$SECRETS_FILE"
fi
random_string() { LC_ALL=C tr -dc 'abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789' </dev/urandom | head -c "$1" || true; }
changed=false
for k in "${KEYS[@]}"; do
  if [[ -z "${!k:-}" ]]; then
    if [[ "$k" == *PASSWORD ]]; then printf -v "$k" '%s' "$(random_string 16)"; else printf -v "$k" '%s' "$(random_string 32)"; fi
    changed=true
  fi
done
if $changed; then
  ( umask 077; for k in "${KEYS[@]}"; do echo "$k=${!k}"; done > "$SECRETS_FILE" )
  info "generated new values in $SECRETS_FILE"
else
  info "reusing $SECRETS_FILE"
fi

kube apply -f "$ROOT/deploy/k8s/namespaces.yaml"
kube -n shop create secret generic shop-secrets --dry-run=client -o yaml \
  --from-literal=POSTGRES_PASSWORD="${POSTGRES_PASSWORD}" \
  --from-literal=SEED_USER_PASSWORD="${SEED_USER_PASSWORD}" \
  --from-literal=INSTRUCTOR_PASSWORD="${INSTRUCTOR_PASSWORD}" \
  --from-literal=PROVIDER_API_KEY="${PROVIDER_API_KEY}" \
  --from-literal=PROVIDER_WEBHOOK_SECRET="${PROVIDER_WEBHOOK_SECRET}" | kube apply -f - >/dev/null
kube -n infra create secret generic postgres-credentials --dry-run=client -o yaml \
  --from-literal=POSTGRES_PASSWORD="${POSTGRES_PASSWORD}" | kube apply -f - >/dev/null

# ------------------------------------------------------------------- operators / charts
if [[ -z "$ONLY" ]]; then
  step "Installing Strimzi operator $STRIMZI_VERSION (Kafka)"
  helm upgrade --install strimzi oci://quay.io/strimzi-helm/strimzi-kafka-operator --version "$STRIMZI_VERSION" \
    --kube-context "$CTX" -n infra --wait --timeout 10m

  step "Installing SigNoz (this takes a few minutes the first time)"
  helm repo add signoz https://charts.signoz.io --force-update >/dev/null
  helm repo update signoz >/dev/null
  helm upgrade --install signoz signoz/signoz --kube-context "$CTX" -n platform \
    -f "$ROOT/deploy/helm/signoz-values.yaml" --wait --timeout 20m
  helm upgrade --install k8s-infra signoz/k8s-infra --kube-context "$CTX" -n platform \
    -f "$ROOT/deploy/helm/k8s-infra-values.yaml" --wait --timeout 10m
fi

# ------------------------------------------------------------------------------- images
if [[ -n "$ONLY" ]]; then IFS=',' read -r -a TO_BUILD <<< "$ONLY"; else TO_BUILD=("${SERVICES[@]}" frontend); fi
if ! $SKIP_BUILD; then
  # With the docker runtime we build straight into minikube's Docker daemon. Clusters
  # created with containerd (minikube's newer default) get host-built images loaded instead.
  runtime="$(kube get nodes -o 'jsonpath={.items[0].status.nodeInfo.containerRuntimeVersion}')"
  direct=false; [[ "$runtime" == docker://* ]] && direct=true
  if $direct; then
    step "Building images inside minikube's Docker: ${TO_BUILD[*]}"
    eval "$(minikube -p minikube docker-env --shell bash 2>/dev/null)"
    trap clear_minikube_docker_env EXIT
  else
    step "Building images on the host, then minikube image load: ${TO_BUILD[*]}"
  fi
  for svc in "${TO_BUILD[@]}"; do
    info "shop/${svc}:dev"
    if [[ "$svc" == frontend ]]; then
      docker build -q -t "shop/frontend:dev" "$ROOT/apps/frontend" >/dev/null
    else
      docker build -q -t "shop/${svc}:dev" --build-arg "WORKSPACE=services/$svc" "$ROOT" >/dev/null
    fi
    $direct || minikube image load --overwrite=true "shop/${svc}:dev"
  done
  clear_minikube_docker_env
fi

# ---------------------------------------------------------------------------- manifests
step "Applying Kubernetes manifests (deploy/k8s)"
kube apply -k "$ROOT/deploy/k8s"
# Point the "external" Services at the Compose containers' IPs on the minikube network.
kube -n external patch endpointslice payment-provider-1 --type=json \
  -p "[{\"op\":\"replace\",\"path\":\"/endpoints/0/addresses/0\",\"value\":\"$PROVIDER_IP\"}]"

if ! $SKIP_BUILD; then
  # Same ":dev" tag, new image: restart so pods pick it up.
  for svc in "${TO_BUILD[@]}"; do kube -n shop rollout restart "deployment/$svc" >/dev/null; done
fi

step "Waiting for infrastructure"
kube -n infra rollout status statefulset/postgres --timeout=300s
kube -n infra rollout status deployment/redis --timeout=300s
kube -n infra rollout status deployment/mailpit --timeout=300s
info "waiting for Kafka (first start can take ~3 minutes)"
kube -n infra wait kafka/kafka --for=condition=Ready --timeout=600s

step "Waiting for shop services"
for svc in "${SERVICES[@]}" frontend; do kube -n shop rollout status "deployment/$svc" --timeout=600s; done

# ----------------------------------------------------------------------------- external
if ! $SKIP_EXTERNAL; then
  step "Starting the external systems (Docker Compose, outside minikube)"
  clear_minikube_docker_env
  cat > "$ROOT/external/payment-provider/.env" <<EOF
PROVIDER_DB_PASSWORD=${PROVIDER_DB_PASSWORD}
PROVIDER_API_KEY=${PROVIDER_API_KEY}
PROVIDER_WEBHOOK_SECRET=${PROVIDER_WEBHOOK_SECRET}
PROVIDER_ADMIN_TOKEN=${PROVIDER_ADMIN_TOKEN}
MINIKUBE_IP=$MINIKUBE_IP
PROVIDER_IP=$PROVIDER_IP
EOF
  cat > "$ROOT/tools/traffic-generator/.env" <<EOF
SEED_USER_PASSWORD=${SEED_USER_PASSWORD}
CONTROL_TOKEN=${TRAFFIC_CONTROL_TOKEN}
PROVIDER_ADMIN_TOKEN=${PROVIDER_ADMIN_TOKEN}
MINIKUBE_IP=$MINIKUBE_IP
PROVIDER_IP=$PROVIDER_IP
EOF
  docker compose -f "$ROOT/external/payment-provider/docker-compose.yml" up -d --build --wait
  docker compose -f "$ROOT/tools/traffic-generator/docker-compose.yml" up -d --build --wait
fi

# ---------------------------------------------------------------------------- smoke test
step "Smoke tests"
set +e  # probes report failures themselves
CURL=curlimages/curl:8.11.1
docker pull -q "$CURL" >/dev/null
probe() {
  local name="$1"; shift
  local out
  out=$(docker run --rm --network minikube --add-host "shop.local:$MINIKUBE_IP" --add-host "otlp.local:$MINIKUBE_IP" \
    "$CURL" -s -o /dev/null -w '%{http_code}' "$@")
  if [[ "$out" == 2* ]]; then printf '\033[32m    %-48s OK (%s)\033[0m\n' "$name" "$out"
  else printf '\033[31m    %-48s FAILED (%s)\033[0m\n' "$name" "$out"; fi
}
probe "storefront  http://shop.local/" "http://shop.local/"
probe "catalog     GET /api/catalog/products" "http://shop.local/api/catalog/products?limit=1"
token_body="{\"grant_type\":\"password\",\"username\":\"shopper001\",\"password\":\"${SEED_USER_PASSWORD}\",\"client_id\":\"deploy-smoke-test\"}"
probe "auth        POST /api/auth/oauth/token" -X POST -H "content-type: application/json" -d "$token_body" "http://shop.local/api/auth/oauth/token"
probe "telemetry   POST otlp.local/v1/traces" -X POST -H "content-type: application/json" -d '{"resourceSpans":[]}' "http://otlp.local/v1/traces"
if ! $SKIP_EXTERNAL; then
  code=$(kube -n shop run "smoke-$RANDOM" --rm -i --restart=Never --image="$CURL" --quiet -- \
    curl -s -o /dev/null -w '%{http_code}' http://payment-provider.external.svc.cluster.local:8080/health 2>/dev/null)
  if [[ "$code" == *200* ]]; then printf '\033[32m    %-48s OK\033[0m\n' "pod -> external payment provider"
  else printf '\033[31m    %-48s FAILED (%s)\033[0m\n' "pod -> external payment provider" "$code"; fi
fi

# ------------------------------------------------------------------------------- summary
# On Linux the minikube node IP is reachable directly; with Docker Desktop (macOS/Windows)
# it is not, so `minikube tunnel` publishes the ingress on 127.0.0.1.
if [[ "$(uname -s)" == Linux ]] && ! grep -qi microsoft /proc/version 2>/dev/null; then
  HOSTS_IP="$MINIKUBE_IP"; TUNNEL_NOTE="(not needed on Linux: the node IP is reachable directly)"
else
  HOSTS_IP=127.0.0.1; TUNNEL_NOTE="(keep it running in a separate terminal; it asks for sudo)"
fi
step "Done"
cat <<EOF

  1. Add this line to /etc/hosts (with sudo):
       $HOSTS_IP shop.local signoz.local mail.local

  2. minikube tunnel   $TUNNEL_NOTE

  3. Open
       Shop               http://shop.local
       SigNoz             http://signoz.local        (create the admin account on first visit)
       Mailpit inbox      http://mail.local
       Provider chaos     http://localhost:8090/admin   token: PROVIDER_ADMIN_TOKEN
       Traffic generator  http://localhost:8091           token: TRAFFIC_CONTROL_TOKEN
                          (instructor only: runs on this PC, not inside the shop)

  Accounts (passwords are in $SECRETS_FILE)
       shopper001 .. shopper100   SEED_USER_PASSWORD
       instructor                 INSTRUCTOR_PASSWORD

EOF
