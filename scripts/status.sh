#!/usr/bin/env bash
# Shows the state of the lab: minikube, pods per namespace, ingresses and the Compose projects.
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
unset DOCKER_TLS_VERIFY DOCKER_HOST DOCKER_CERT_PATH MINIKUBE_ACTIVE_DOCKERD
h() { printf '\n\033[36m==> %s\033[0m\n' "$*"; }

h minikube
minikube status
for ns in shop infra platform; do
  h "pods in $ns"
  kubectl --context minikube -n "$ns" get pods -o wide
done
h ingresses
kubectl --context minikube get ingress -A
h "external systems (Docker Compose)"
docker compose -f "$ROOT/external/payment-provider/docker-compose.yml" ps
docker compose -f "$ROOT/tools/traffic-generator/docker-compose.yml" ps
