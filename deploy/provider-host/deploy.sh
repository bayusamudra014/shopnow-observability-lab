#!/usr/bin/env bash
# Instructor host: start (or update) MockPay + the traffic generator with Docker Compose.
#   ./deploy.sh            pull the images in .env and (re)start
# Needs Docker with the compose plugin. Ports: 80 (MockPay), 8091 (traffic generator).
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"
# shellcheck source=/dev/null
source .env
command -v docker >/dev/null || { echo "install Docker first: curl -fsSL https://get.docker.com | sudo sh" >&2; exit 1; }

docker compose pull
docker compose up -d --wait

host=$(hostname -f 2>/dev/null || hostname)
printf '\n'
curl -fsS -o /dev/null http://127.0.0.1:"${PROVIDER_PORT:-80}"/health && echo "  MockPay            OK" || echo "  MockPay            NOT healthy"
curl -fsS -o /dev/null http://127.0.0.1:"${GENERATOR_PORT:-8091}"/health && echo "  Traffic generator  OK" || echo "  Traffic generator  NOT healthy"
cat <<EOF

  MockPay admin      http://<this host>:${PROVIDER_PORT:-80}/admin     token: PROVIDER_ADMIN_TOKEN in .env
  Traffic generator  http://<this host>:${GENERATOR_PORT:-8091}          token: CONTROL_TOKEN in .env
                     (starts paused: press Start once the student VMs are up)
  Logs               docker compose logs -f     (on $host)

EOF
