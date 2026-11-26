#!/usr/bin/env bash
# Shows the state of ShopNow on this machine: minikube, pods, public hosts, local MockPay.
KIT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROFILE="${MINIKUBE_PROFILE:-shopnow}"
h() { printf '\n\033[36m==> %s\033[0m\n' "$*"; }
h "minikube ($PROFILE)"
minikube -p "$PROFILE" status
for ns in shop infra platform; do
  h "pods in $ns"
  kubectl --context "$PROFILE" -n "$ns" get pods
done
h ingresses
kubectl --context "$PROFILE" get ingress -A
if [[ -f "$KIT_DIR/.mockpay.env" ]]; then
  h "local payment provider (MockPay)"
  docker compose -f "$KIT_DIR/local/mockpay-compose.yml" --env-file "$KIT_DIR/.mockpay.env" ps
fi
