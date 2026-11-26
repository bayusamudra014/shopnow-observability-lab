#!/usr/bin/env bash
# Removes the lab. Stops the Compose projects first (they are attached to minikube's
# Docker network), then deletes the minikube cluster.
#
#   ./scripts/destroy.sh                 # stop everything, delete the cluster
#   ./scripts/destroy.sh --keep-cluster  # only stop the Compose projects
#   ./scripts/destroy.sh --volumes       # also delete the provider's database volume
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
KEEP_CLUSTER=false
DOWN=(down --remove-orphans)
for a in "$@"; do
  case "$a" in
    --keep-cluster) KEEP_CLUSTER=true ;;
    --volumes) DOWN+=(--volumes) ;;
    *) echo "unknown option: $a" >&2; exit 2 ;;
  esac
done
unset DOCKER_TLS_VERIFY DOCKER_HOST DOCKER_CERT_PATH MINIKUBE_ACTIVE_DOCKERD
h() { printf '\033[36m==> %s\033[0m\n' "$*"; }

h "Stopping traffic generator"
docker compose -f "$ROOT/tools/traffic-generator/docker-compose.yml" "${DOWN[@]}"
h "Stopping payment provider"
docker compose -f "$ROOT/external/payment-provider/docker-compose.yml" "${DOWN[@]}"
if ! $KEEP_CLUSTER; then
  h "Deleting minikube cluster"
  minikube delete
fi
