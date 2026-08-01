---
id: D-003
title: Single SELECT instead of LIMIT/OFFSET for 4D
date: 2026-03-31
---

# D-003: Single SELECT instead of LIMIT/OFFSET for 4D

*Decided: 2026-03-31*

**Context**: LIMIT/OFFSET on 4D is catastrophically slow for large tables because 4D re-scans all preceding rows at each offset.
**Decision**: For tables <2M rows (Ventas 911K, LineasVentas 1.7M), use single SELECT. p4d buffers the full result set in memory.
**Rationale**: 911K rows fetched in 15 min (single query) vs estimated 51 hours (LIMIT/OFFSET at 5K batches). Memory cost (~500MB) is acceptable.
