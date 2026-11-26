#!/usr/bin/env bash
# ShopNow incident challenges: check which tickets (TICKETS.md) are fixed.
#
#   ./check.sh
#
# The check runs inside the cluster (a short-lived Job, read-only) and changes nothing.
# Send its output to your instructor.
set -euo pipefail
KIT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# macOS: use the kit's own minikube, kubectl and helm (tools/darwin-<arch>), nothing installed.
if [[ "$(uname -s)" == Darwin ]]; then
  case "$(uname -m)" in arm64) _arch=arm64 ;; *) _arch=amd64 ;; esac
  [[ -d "$KIT_DIR/tools/darwin-$_arch" ]] && PATH="$KIT_DIR/tools/darwin-$_arch:$PATH"
fi
PROFILE="${MINIKUBE_PROFILE:-shopnow}"
kube() { kubectl --context "$PROFILE" "$@"; }

kube -n shop get cronjob lab-check >/dev/null 2>&1 || { echo "the checker is not installed: run ./deploy.sh first" >&2; exit 1; }
job="lab-check-$(date +%s)"
kube -n shop create job "$job" --from=cronjob/lab-check >/dev/null
trap 'kube -n shop delete job "$job" --ignore-not-found --wait=false >/dev/null 2>&1 || true' EXIT
kube -n shop wait --for=condition=Ready pod -l "job-name=$job" --timeout=180s >/dev/null 2>&1 || true
kube -n shop logs -f "job/$job" --pod-running-timeout=180s
