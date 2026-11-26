# ShopNow — an observability lab

A microservice e-commerce app for teaching **observability** (traces, metrics, logs) in a
Cloud Computing Architecture class. Everything is TypeScript, instrumented with
OpenTelemetry, and observed in **SigNoz**.

```
Browser ─▶ ingress (shop.local) ─▶ api-gateway ─▶ auth · catalog · cart · order · inventory · payment
                                                        │            │                 │
                                     Postgres · Redis (cache) · Kafka (Strimzi) · Mailpit (SMTP)
                                                        │
                    payment ──HTTPS──▶ MockPay (external, Docker Compose) ──webhook──▶ hooks.local
All shop services ──OTLP──▶ SigNoz collector ──▶ SigNoz (signoz.local)
Traffic generator (instructor only, Docker Compose, localhost:8091) ──▶ one or many shops
```

| Part | Where | Notes |
|---|---|---|
| `services/*` | minikube, ns `shop` | Fastify services, one Postgres DB each, OTel via `@shop/telemetry` |
| `apps/frontend` | minikube, ns `shop` | React + Chakra UI v3 |
| `deploy/k8s/infra` | minikube, ns `infra` | Postgres, Redis, Kafka (KRaft), Mailpit |
| SigNoz + k8s-infra | minikube, ns `platform` | Helm charts |
| `external/payment-provider` | Docker Compose | Mock external provider, chaos admin at <http://localhost:8090/admin> |
| `tools/traffic-generator` | Docker Compose | Multi-target load + dashboard at <http://localhost:8091> (no OTel) |

## Run it

Prerequisites: Docker Desktop (give it ≥ 16 GB in `%UserProfile%\.wslconfig`), minikube, kubectl, helm.

```powershell
.\scripts\deploy.ps1
```

Then add `127.0.0.1 shop.local signoz.local mail.local` to `C:\Windows\System32\drivers\etc\hosts`,
keep `minikube tunnel` running in an Administrator terminal, and open:

- Shop: <http://shop.local> (users `shopper001`–`shopper100`, `instructor`; passwords in `.secrets/secrets.env`,
  or create your own account on the **Register** page). <http://shop.localhost> serves the same shop and
  needs no hosts entry, because browsers resolve `*.localhost` to 127.0.0.1 (still needs `minikube tunnel`).
- SigNoz: <http://signoz.local>
- Mailpit inbox: <http://mail.local>
- Payment provider admin: <http://localhost:8090/admin> (token `PROVIDER_ADMIN_TOKEN`)
- Traffic generator: <http://localhost:8091> (token `TRAFFIC_CONTROL_TOKEN`)

### MockPay admin tokens
`scripts/deploy.ps1` puts a generated `PROVIDER_ADMIN_TOKEN` in `external/payment-provider/.env`.
If that variable is empty, MockPay generates a **bootstrap token** on first start and prints it
once (`docker compose -f external/payment-provider/docker-compose.yml logs payment-provider`).
More named tokens can be generated and revoked in the console's **Admin tokens** section;
each is shown once and stored only as a hash.

### Traffic profiles
`steady`, `diurnal`, `ramp`, `flash-sale`, `black-friday`, `cyber-monday`, `midnight-sale`,
`lunch-rush`, `payday`, `weekend`, `bot-attack`. Switch them in the generator's **Settings** tab
(each card previews its curve). Several profiles bring their own persona mix and hot products;
drills (e.g. `black-friday`, `midnight-meltdown`) combine a profile with provider chaos.

Other scripts: `scripts/status.ps1`, `scripts/destroy.ps1`, `scripts/deploy.ps1 -Only catalog` (rebuild one service).

On Linux/macOS (or Git Bash/WSL) use the bash ports: `./scripts/deploy.sh` (`--skip-build`,
`--skip-external`, `--only catalog,order`), `./scripts/status.sh`, `./scripts/destroy.sh`
(`--keep-cluster`, `--volumes`). They share `.secrets/secrets.env` with the PowerShell scripts.
On Linux no tunnel is needed: point the hosts entry at `minikube ip` instead of 127.0.0.1.

## Releasing to student VMs

Students never build anything: `scripts/release.ps1` builds all images, pushes them to the
registry and renders two kits in `dist/`.

```powershell
docker login <registry host>
.\scripts\release.ps1 -Registry <registry host>/<project> -Tag 1.0.0
```

| Kit | Runs on | You fill in |
|---|---|---|
| `shopnow-kit-<tag>.tar.gz` | each student VM (Ubuntu + minikube) | `shopnow.env`: `SHOP_HOST`, `MAIL_HOST`, `SIGNOZ_HOST`, `SHOP_PUBLIC_URL`, `PROVIDER_URL`, `WEBHOOK_CALLBACK_URL` |
| `shopnow-instructor-<tag>.tar.gz` | the instructor host (MockPay + traffic generator) | `.env`: `WEBHOOK_ALLOWED_HOSTS`, `TARGET_BASE_URLS` (optional `WEBHOOK_URL`, ports) |

No hosts or URLs are baked in. The registry, tag and shared secrets (`.secrets/shopnow.env`:
MockPay API key, webhook secret, admin token, seed-user password, generator token) are prefilled.
Then `./deploy.sh --install-deps` on each VM and `./deploy.sh` on the instructor host.

One MockPay serves every shop: each charge carries the shop's `webhookUrl`, and MockPay only
accepts hosts matching `WEBHOOK_ALLOWED_HOSTS`.

## Checkout flow

1. `order` reads the cart, creates the order and an `order.placed` outbox event (one transaction).
2. `order` → `inventory` reserves stock (row locks).
3. `order` → `payment` → MockPay creates a charge (retry, timeout, circuit breaker); answer: `pending`.
4. MockPay calls the signed webhook on `hooks.local` → `payment` publishes `payment.succeeded|failed`.
5. `order` confirms/cancels → `order.confirmed|cancelled` → `inventory` commits/releases, `notification` emails via Mailpit.

The webhook starts a **new trace**; `payment` adds a span link back to the checkout trace.
Generated traffic is deliberately **not labelled**: no journey or synthetic headers and ordinary
browser user-agents, so in SigNoz it looks like real customers. Only the generator's own
dashboard knows which persona sent what.
