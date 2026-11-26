# ShopNow lab kit

Deploys the ShopNow microservice shop, Kafka, Postgres, Redis, Mailpit and SigNoz with
minikube. Images are pulled from the course registry; nothing is built here.

There are two ways to run it, chosen with `MODE` in `shopnow.env`:

| | `MODE=local` — your own computer | `MODE=vm` — a server |
|---|---|---|
| Runs on | Ubuntu desktop or Windows | an Ubuntu VM |
| Payment provider | a local MockPay container on this computer | the course MockPay |
| Open | `http://shop.localhost` (no DNS or hosts file needed) | the hostnames you configure (DNS) |

## Windows (MODE=local)

1. Install and start **Docker Desktop**; give it 4+ CPUs and 12+ GB of memory.
2. Extract `shopnow-kit-windows-<tag>.zip` and double-click **`deploy.cmd`**.

minikube, kubectl and helm come in `tools\`; no installation, administrator rights,
hosts file or `minikube tunnel` are needed. If port 80 is taken, set `HTTP_PORT=8080` in
`shopnow.env` first (then open `http://shop.localhost:8080`). `status.cmd` shows the pods,
`destroy.cmd` removes everything.

## Ubuntu desktop or VM

```bash
tar -xzf shopnow-kit-<tag>.tar.gz && cd shopnow-kit
nano shopnow.env                  # MODE=local, or MODE=vm plus this VM's hosts and URLs
./deploy.sh --install-deps        # first time (installs docker; minikube/kubectl/helm from tools/)
./deploy.sh                       # later runs / after changing shopnow.env
```

If `--install-deps` adds you to the `docker` group, log out and back in, then run it again.
`./status.sh` shows the pods; `./destroy.sh` removes everything.

| `MODE=vm` setting | Used for |
|---|---|
| `SHOP_HOST`, `SHOP_PUBLIC_URL` | the shop (and `/webhooks` for the payment provider) |
| `MAIL_HOST` | Mailpit: every email the shop sends |
| `SIGNOZ_HOST` | SigNoz |
| `PROVIDER_URL` | the course payment provider |
| `WEBHOOK_CALLBACK_URL` | sent with each charge; the provider posts the result there |

## After deploying

- **SigNoz** (`http://signoz.shop.localhost` locally): create the admin account first; data
  appears after that.
- **Mailpit** (`http://mail.shop.localhost` locally): every email the shop sends.
- **MockPay console** (MODE=local only): `http://localhost:8090/admin` (`MOCKPAY_PORT`), token
  `PROVIDER_ADMIN_TOKEN` in `.secrets.env`.

## Incident tickets

The shop comes with production problems built in. `TICKETS.md` lists the tickets the
support desk sent you; investigate them in SigNoz and fix them in the cluster.
`./check.sh` (Windows: `check.cmd`) tells you which tickets are fixed, without changing
anything; send its output to your instructor.

Re-running `./deploy.sh` keeps your fixes unless `shopnow.yaml` or `shopnow.env` changed;
then it re-applies `shopnow.yaml`, so put lasting fixes in that file too.

## What is downloaded

minikube, kubectl and helm (`tools/`) and the Helm charts (`charts/`) come with the kit.
Nothing is downloaded from GitHub (SigNoz's ClickHouse gets its histogramQuantile function from
the course image `shopnow-clickhouse-udf`). The machine still needs Docker Hub, quay.io, gcr.io,
registry.k8s.io, storage.googleapis.com and the course registry, plus get.docker.com for
`--install-deps` on Linux.
