# Incident challenges: answer key (instructor only)

Never ship this file. Students get `TICKETS.md` (the symptoms) and `check.sh` / `check.cmd`
(the grader, which runs as a read-only Job inside their cluster).

The challenge kit is the default output of `scripts/release.ps1`: its `shopnow.yaml` is
rendered from `deploy/overlays/lab`, where the faults look like ordinary configuration.
`-Clean` renders `deploy/overlays/vm` instead (no challenges, no checker, no update).

| # | Built in or event | Where it lives |
|---|---|---|
| 1 | built in (base) | `CATALOG_N_PLUS_ONE=true`, no index on `product_reviews(product_id)`, ~96k reviews |
| 2 | event | VM: generator drill `payment-slowdown`. Local: MockPay `CHAOS_SCHEDULE=slow-waves` |
| 3 | built in | `shop-public` ingress: `/webhooks` -> `payment` port **8080** (the Service has 80) |
| 4 | built in | `api-gateway`: CPU limit 150m, 1 replica, no HPA |
| 5 | built in | `notification`: memory limit 40Mi (OOMKilled at start, crash loop) |
| 6 | built in | `NOTIFICATION_DELAY_MS=2000`, `order.placed/confirmed/cancelled` 1 partition |
| 7 | event | generator drill `credential-stuffing` (VM only) |
| 8 | built in | deploy script rolls out `UPDATE_TAG` (order with bulk-pricing bug) after install |

## Running a session

- **VMs:** your traffic generator drives every shop. Steady background traffic makes 1, 3, 5,
  6 and 8 visible; switch to `black-friday` for 4 (and it makes 5 and 6 worse); start the
  drills `payment-slowdown` (2) and `credential-stuffing` (7) from the generator's
  **Drills** tab (`POST /api/drills/<name>`, 1 hour each, stop early with Stop).
  The MockPay chaos of drill 2 hits every shop at once.
- **Student computers (MODE=local):** there is no generator; students click around the shop
  themselves. 1, 3, 5 (partly), 6 and 8 still reproduce by hand (8: buy 3 or 4 units of an
  item over $100). 2 comes from the local MockPay's slow waves (10 minutes slow every 30,
  the first one 20 minutes after MockPay starts). 4 and 7 need load and are VM-only.

## 1. Product pages are slow

- **Find:** trace of `GET /api/catalog/products` -> catalog `GET /products` with ~25 `pg.query`
  spans, each a `SELECT avg(rating) ... WHERE product_id = $1` taking ms; catalog's start-up
  log says "N+1 query mode ON". Cache hits hide it for 30 s at a time (`cache.hit`).
- **Fix:** `CATALOG_N_PLUS_ONE=false` on the catalog Deployment, and
  `CREATE INDEX ON product_reviews (product_id);` in `catalog_db`
  (`kubectl -n infra exec -it postgres-0 -- psql -U shop catalog_db`).
- **Check:** env is `false` and `EXPLAIN` of the rating lookup uses an index.

## 2. Checkout survives a slow provider

- **Find:** payment's client spans to the provider: 3 s timeouts, `provider create_charge
  failed (attempt n), retrying` logs, `shop_payment_circuit_state` going open, checkouts ending
  `payment_unavailable` (503). The provider answers in 2.5-4 s, so a 3 s timeout fails most
  calls and the retries (which re-send the same idempotency key) pile up to ~9.6 s.
- **Fix:** payment env `PROVIDER_TIMEOUT_MS` above the provider's latency (5000-5500) and
  `PROVIDER_MAX_ATTEMPTS=2`, so the worst case stays below the 12 s order gives payment.
  Discussion: more retries make it worse; the breaker protects the shop; late successes
  are still settled by webhook or the reconciler.
- **Check:** timeout >= 4500 ms and timeout x attempts + backoff <= 11.5 s.

## 3. Webhooks never arrive

- **Find:** orders stay `awaiting_payment` ~60-90 s, then confirm via payment's reconciler
  ("resolved by reconciler" log). The webhook request never appears in payment's traces at
  all; ingress-nginx logs show 503 for `/webhooks` (in VM mode the instructor's MockPay
  console shows deliveries failing with HTTP 503). `kubectl describe ingress shop-public`
  names port 8080; `kubectl get svc payment` has only 80.
- **Fix:** the `/webhooks` path's backend port -> 80 (or the port name `http`).
- **Check:** an unsigned POST to `/webhooks/payment-provider` through the ingress gets 400/401
  from payment (not 503 from nginx).

## 4. Black Friday capacity

- **Find:** under `black-friday`, latency of every route through api-gateway rises; the
  gateway's own spans are slow while the services behind it are fast; k8s-infra shows
  api-gateway CPU flat at 150m (throttled). Adding replicas helps a bit, but each new pod is
  throttled the same way.
- **Fix:** raise or remove the CPU limit (>= 500m), keep a CPU request, add an HPA
  (`kubectl autoscale deploy/api-gateway --cpu-percent=70 --min=2 --max=5`); metrics-server is
  enabled. Discussion: requests vs limits, CFS throttling.
- **Check:** CPU limit none or >= 500m, an HPA with maxReplicas >= 2, a CPU request.

## 5. Notification runs out of memory

- **Find:** no `smtp.send` spans and no notification logs at all (it never gets far enough);
  Mailpit empty; k8s-infra / `kubectl get pods`: notification in CrashLoopBackOff, last state
  `OOMKilled` (`kubectl describe pod`), memory limit 40Mi. The deploy script warns that it
  keeps restarting. Kafka keeps the events, so emails go out once it runs.
- **Fix:** memory limit >= 256Mi (and a sensible request).
- **Check:** limit >= 256Mi and no OOMKilled in the last 10 minutes.
- Fixing it reveals ticket 6: the backlog of emails now drains at one every 2 s.

## 6. Emails arrive late

- **Find:** `smtp.send` spans take ~2 s each; the time between `order.confirmed` being
  published (order's outbox span) and the email span grows; consumer lag (Kafka). Scaling
  notification to 3 replicas helps only a little: each `order.*` topic has 1 partition, so
  at most one consumer per topic does work (`kubectl -n infra get kafkatopic`).
- **Fix:** increase partitions on `order.placed` and `order.confirmed` (and `order.cancelled`)
  in the `KafkaTopic` CRs (e.g. 6; only increases are possible), then scale notification
  (replicas >= 2, or an HPA). The 2 s relay delay stays.
- **Check:** delay still 2000, >= 2 consumers, those topics have at least as many partitions
  as consumers.

## 7. Credential stuffing

- **Find:** the `credential-stuffing` drill: many `POST /api/auth/oauth/token` -> 401, auth's
  `bcrypt.compare` spans and CPU saturated, everyone's login slow. Gateway logs' `clientIp`
  is the same address for every request: ingress-nginx by default replaces X-Forwarded-For
  with the address that connected to it (the instructor host), so the shop cannot tell
  clients apart. A naive `limit-rps` on the ingress then blocks everyone.
- **Fix:** make ingress-nginx trust the load balancer's header (ConfigMap
  `ingress-nginx-controller` in `ingress-nginx`: `use-forwarded-headers: "true"`), then
  rate-limit per client at the ingress (annotations on `shop-public`, e.g.
  `nginx.ingress.kubernetes.io/limit-rps: "5"`, `limit-burst-multiplier: "2"`) or lower the
  gateway's limit. Gateway logs then show the botnet's few addresses.
  Discussion: why trusting X-Forwarded-For is only safe behind a proxy you control.
- **Check:** 60 fast bad logins from one address get some 429/503; logins from 3 other
  addresses still work.

## 8. Last night's release

- **Find:** order error rate up since the release; group errors by `service.version`: only
  order `UPDATE_TAG` fails; exception on the span: `TypeError: Cannot read properties of
  undefined (reading 'percentOff')`; failing traces all have a cart line with 3-4 units of
  an item >= $100 (bulk pricing starts at 5 units, the new code assumes a tier exists).
  `kubectl rollout history deploy/order` shows the release and its change-cause. The
  catalog was updated in the same release and is fine (red herring).
- **Fix:** `kubectl -n shop rollout undo deploy/order`. It sticks: `shopnow.yaml` already
  names the kit's tag, and a re-deploy keeps the image order runs. Discussion: the readiness probe passed because
  `/ready` does not exercise checkout; alert on error rate by version; canary.
- **Check:** order is not on `UPDATE_TAG` and a checkout of 3 x Wireless Headphones works.
