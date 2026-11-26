#!/usr/bin/env bash
# Deletes ShopNow from this machine: the local MockPay (MODE=local) and the minikube cluster,
# with all their data. The generated passwords in .secrets.env are kept for the next deploy.
set -euo pipefail
KIT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROFILE="${MINIKUBE_PROFILE:-shopnow}"
read -r -p "Delete the '$PROFILE' minikube cluster and ALL ShopNow data on this machine? [y/N] " ok
[[ "$ok" == [yY]* ]] || { echo "cancelled"; exit 0; }
if [[ -f "$KIT_DIR/.mockpay.env" ]]; then
  docker compose -f "$KIT_DIR/local/mockpay-compose.yml" --env-file "$KIT_DIR/.mockpay.env" down -v || true
fi
minikube -p "$PROFILE" delete
