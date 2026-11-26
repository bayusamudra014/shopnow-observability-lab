#!/usr/bin/env bash
# Deletes ShopNow from this machine: the local MockPay (MODE=local) and the minikube cluster,
# with all their data. The generated passwords in .secrets.env are kept for the next deploy.
set -euo pipefail
KIT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# macOS: use the kit's own minikube, kubectl and helm (tools/darwin-<arch>), nothing installed.
if [[ "$(uname -s)" == Darwin ]]; then
  case "$(uname -m)" in arm64) _arch=arm64 ;; *) _arch=amd64 ;; esac
  [[ -d "$KIT_DIR/tools/darwin-$_arch" ]] && PATH="$KIT_DIR/tools/darwin-$_arch:$PATH"
fi
PROFILE="${MINIKUBE_PROFILE:-shopnow}"
read -r -p "Delete the '$PROFILE' minikube cluster and ALL ShopNow data on this machine? [y/N] " ok
[[ "$ok" == [yY]* ]] || { echo "cancelled"; exit 0; }
if [[ -f "$KIT_DIR/.mockpay.env" ]]; then
  docker compose -f "$KIT_DIR/local/mockpay-compose.yml" --env-file "$KIT_DIR/.mockpay.env" down -v || true
fi
minikube -p "$PROFILE" delete
