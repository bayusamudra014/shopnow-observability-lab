# The histogramQuantile UDF for SigNoz's ClickHouse, baked into an image so clusters that
# cannot reach GitHub do not have to download it at start-up (see
# deploy/helm/signoz-values-no-github.yaml). Built by scripts/release.ps1, which downloads
# the binary into this build context first.
FROM alpine:3.18.2
COPY histogram-quantile /histogram-quantile
RUN chmod 0755 /histogram-quantile
