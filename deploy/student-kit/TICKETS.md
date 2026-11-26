# ShopNow: open incident tickets

You are the new platform team. ShopNow is in production (your cluster) and the support desk
has passed you eight tickets. For each one:

1. **Find the cause** with SigNoz: traces, metrics and logs. Write down what you looked at
   and what showed you the cause (a query, a trace, a chart).
2. **Fix it in the infrastructure**: Kubernetes objects, configuration, the database, the
   ingress. You do not have the application's source code, and you do not need it.
3. **Show it is fixed**: the same SigNoz view, after. Then run `./check.sh` (Windows:
   `check.cmd`) and send its output with your write-up.

Rules of the game:

- Some problems only show up under load or during an event your instructor starts (a sale,
  an attack, a slow payment provider). Your instructor will tell you when.
- Don't "fix" a problem by switching off the thing that shows it. A slow external service
  stays slow; a busy sale stays busy. Make the shop cope.
- `./deploy.sh` re-applies `shopnow.yaml` only when it or `shopnow.env` changed. A fix made
  only with `kubectl` is lost when that happens, so also put your fix in `shopnow.yaml`.
- One change can uncover the next problem. That is normal in production.

---

### Ticket 1: "The product pages are slow"
> Customers say the shop's front page and product pages take a long time to load,
> and it gets worse when the shop is busy.

### Ticket 2: "Checkout hangs, then my order is cancelled"
> During some periods checkout spins for 10 seconds or more, then says payment is
> unavailable. Our payment provider says they're "a bit slow today" and that we should
> handle it. *(MODE=local: your payment provider has bad spells by itself, about every half
> hour.)*

### Ticket 3: "I paid, but my order still says waiting for payment"
> The payment provider confirms our customers' payments, but orders stay on "awaiting
> payment" for a long time before they're confirmed.

### Ticket 4: "Black Friday: everything is slow, sometimes errors"
> When traffic goes up, every page gets slow and some requests fail. Adding more servers
> "didn't really help" last year.

### Ticket 5: "Order emails stopped arriving"
> Customers get no email at all for their orders: no confirmation, no cancellation.

### Ticket 6: "Emails arrive very late"
> Order emails arrive many minutes after the order. The mail relay we use is slow (about
> 2 seconds per email) and we can't change that; the shop has to keep up anyway.

### Ticket 7: "Nobody can log in"
> During an attack, logging in became very slow or failed for everyone. Our traffic reaches
> the shop through the company's load balancer, which tells us the real client address in
> the `X-Forwarded-For` header. Stop the attackers without locking out customers.

### Ticket 8: "Since last night's release, some checkouts fail"
> After the release that went out right after the shop was set up, a share of checkouts
> fail with an error. Not all of them.

---

Useful places to start: SigNoz **Services** (latency, error rate, per operation), **Traces**
(filter by service, status, duration), **Logs** (filter by service and severity, open the
trace of a log line), **Infrastructure / Kubernetes** (CPU, memory, restarts per pod), and
`kubectl` (`get`, `describe`, `logs`, `top`, `rollout history`, `get events`).
