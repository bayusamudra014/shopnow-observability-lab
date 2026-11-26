# One image recipe for every Node workspace (services, payment provider, traffic generator).
#
#   docker build --build-arg WORKSPACE=services/catalog -t shop/catalog:dev .
#
# All workspaces are compiled in the shared "build" stage, so building ten images reuses
# the same cached layers and only the tiny final stage differs.

FROM node:24-alpine AS build
WORKDIR /repo
COPY . .
RUN npm ci --no-audit --no-fund \
 && npm run build \
 && npm prune --omit=dev --no-audit --no-fund

FROM node:24-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /repo /app
ARG WORKSPACE
# INSTRUMENT=false starts the app WITHOUT OpenTelemetry (used for the external provider).
ARG INSTRUMENT=true
# APP_VERSION becomes the OpenTelemetry service.version (the release tag).
ARG APP_VERSION=dev
# Optional features compiled into this release, comma-separated (read from .release-features).
ARG RELEASE_FEATURES=""
ENV WORKSPACE=${WORKSPACE} INSTRUMENT=${INSTRUMENT} APP_VERSION=${APP_VERSION}
RUN test -f "/app/${WORKSPACE}/dist/main.js" && mkdir -p /data && chown node:node /data  && printf '%s' "${RELEASE_FEATURES}" > "/app/${WORKSPACE}/.release-features"
WORKDIR /app/${WORKSPACE}
USER node
EXPOSE 8080
# --require loads the OpenTelemetry SDK before any application module.
CMD ["sh", "-c", "if [ \"$INSTRUMENT\" = false ]; then exec node dist/main.js; else exec node --require @shop/telemetry/register dist/main.js; fi"]
