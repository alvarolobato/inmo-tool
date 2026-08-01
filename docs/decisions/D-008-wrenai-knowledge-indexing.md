---
id: D-008
title: WrenAI instructions + SQL pairs require AI service API calls
date: 2026-03-31
---

# D-008: WrenAI instructions + SQL pairs require AI service API calls

*Decided: 2026-03-31*

**Context**: `deploy(force: true)` only indexes schema (Documents + table_descriptions) into qdrant. Instructions and SQL pairs in SQLite are NOT automatically indexed.
**Decision**: After SQLite writes, POST to `/v1/instructions` and `/v1/sql-pairs` on the AI service (port 5555) to index into qdrant.
**Rationale**: Discovered empirically. WrenAI's deploy mutation only handles schema embedding.
