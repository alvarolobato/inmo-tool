# prod/

Production architecture overview: [ARCHITECTURE.md § Production](../ARCHITECTURE.md#production).

Install + operations: [docs/deployment/production.md](../docs/deployment/production.md) and [docs/deployment/prod-cli.md](../docs/deployment/prod-cli.md).

This directory contains only the prod-specific compose override (`docker-compose.override.prod.yml`). The canonical prod stack definition (`docker-compose.prod.yml`) is a GitHub release asset — it is downloaded to the prod Mac by `deploy/install-prod.sh` and is not checked into this directory.
