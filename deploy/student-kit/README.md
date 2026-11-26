# ShopNow lab kit

Deploys the ShopNow microservice shop, Kafka, Postgres, Redis, Mailpit and SigNoz on this
Ubuntu VM with minikube. Images are pulled from the course registry; nothing is built here.

```bash
tar -xzf shopnow-kit-*.tar.gz && cd shopnow-kit
nano shopnow.env                  # fill in this VM's hosts and the provider URLs
./deploy.sh --install-deps        # first time (installs docker, minikube, kubectl, helm)
./deploy.sh                       # later runs / after changing shopnow.env
```

If `--install-deps` adds you to the `docker` group, log out and back in, then run it again.

| Setting in `shopnow.env` | Used for |
|---|---|
| `SHOP_HOST`, `SHOP_PUBLIC_URL` | the shop (and `/webhooks` for the payment provider) |
| `MAIL_HOST` | Mailpit: every email the shop sends |
| `SIGNOZ_HOST` | SigNoz: create the admin account first, then data appears |
| `PROVIDER_URL` | the payment provider the shop charges |
| `WEBHOOK_CALLBACK_URL` | sent with each charge; the provider posts the result there |

`./status.sh` shows the pods; `./destroy.sh` deletes the cluster.
