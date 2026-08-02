---
id: D-005
title: Qdrant recreate_index: false
date: 2026-03-31
---

# D-005: Qdrant recreate_index: false

*Decided: 2026-03-31*

**Context**: `recreate_index: true` in wren-config.yaml wiped all qdrant collections on every service restart, losing all indexed schema/instructions.
**Decision**: Set `recreate_index: false`.
**Rationale**: Collections and embeddings must survive restarts.
