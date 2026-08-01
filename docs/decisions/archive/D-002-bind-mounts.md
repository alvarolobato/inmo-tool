---
id: D-002
title: Bind mount volumes instead of named Docker volumes
date: 2026-03-31
---

# D-002: Bind mount volumes instead of named Docker volumes

*Decided: 2026-03-31*

**Context**: Named Docker volumes are anonymous — data lost if pruned or compose recreated.
**Decision**: All data in `./data/postgres/`, `./data/qdrant/`, `./data/wren/` bind mounts.
**Rationale**: Data survives `docker compose down` and is visible on the host filesystem. Migration script provided for existing named volumes.
