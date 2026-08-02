---
id: D-001
title: PostgreSQL mirror + WrenAI for analytics
date: 2026-03-30
---

# D-001: PostgreSQL mirror + WrenAI for analytics

*Decided: 2026-03-30*

**Context**: PowerShop ERP runs on 4D database (vendor-managed, production). Need analytics without impacting the ERP.
**Decision**: ETL extracts to PostgreSQL mirror. WrenAI (text-to-SQL) queries the mirror.
**Rationale**: 4D has no Linux ODBC driver, REST API disabled, SOAP is limited. P4D SQL driver works but is slow and production-critical. PostgreSQL is fast, well-supported, and WrenAI has native connector.

---
