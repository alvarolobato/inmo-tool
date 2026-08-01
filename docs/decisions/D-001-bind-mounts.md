---
id: D-001
title: Bind mount volumes instead of named Docker volumes
date: 2026-08-02
---

# D-001: Bind mount volumes instead of named Docker volumes

*Decided: 2026-08-02*

**Context**: Named Docker volumes are anonymous — data is lost if pruned or the compose project is recreated, and it isn't visible on the host filesystem for inspection/backup.
**Decision**: Every stateful service this project runs (Postgres today; anything added in later phases) persists to `./data/<service>/` bind mounts, never named volumes.
**Rationale**: Data survives `docker compose down` and is directly inspectable/backupable from the host. Carried over from the source project this repo was bootstrapped from (powershop-analytics D-002), where it was adopted for the same reason.
**See**: `docker-compose.yml`, `docs/decisions/archive/D-002-bind-mounts.md` (original rationale, retained for history).
