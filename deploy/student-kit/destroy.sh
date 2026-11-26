#!/usr/bin/env bash
# Deletes the minikube cluster and everything in it (shop data, SigNoz data).
# The generated database passwords in .secrets.env are kept for the next deploy.
set -euo pipefail
read -r -p "Delete the minikube cluster and ALL ShopNow data on this VM? [y/N] " ok
[[ "$ok" == [yY]* ]] || { echo "cancelled"; exit 0; }
minikube delete
