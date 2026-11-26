#!/usr/bin/env bash
# Shows the state of ShopNow on this VM: minikube, pods per namespace and the public hosts.
h() { printf '\n\033[36m==> %s\033[0m\n' "$*"; }
h minikube
minikube status
for ns in shop infra platform; do
  h "pods in $ns"
  kubectl --context minikube -n "$ns" get pods
done
h ingresses
kubectl --context minikube get ingress -A
