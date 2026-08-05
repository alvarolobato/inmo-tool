---
id: D-074
title: Kutxabank Inmobiliaria not buildable — served by Servihabitat
date: 2026-08-06
---

# D-074: Kutxabank Inmobiliaria not buildable — served by Servihabitat

*Decided: 2026-08-06*

**Context**: Issue #137 (part of the #132 bank/REO batch) asked for a
connector against Kutxabank's (incl. Cajasur) REO portal, and explicitly told
the spike to **check overlap with the existing Servihabitat connector before
building**, and to confirm whether a standalone searchable portal exists at
all or only a section of the main bank site. Live spike (2026-08-05):

- `www.kutxabank.es/robots.txt` returns a 404 maintenance-style HTML page —
  the main bank site is not a property portal.
- The Kutxabank property portal domain `kutxabankinmobiliaria.com`
  **301-redirects** to `kutxabankinmobiliaria.es`, which resolves to
  `https://www.servihabitat.com/es/kutxabankinmobiliaria` (HTTP 200) — i.e.
  Kutxabank's "own" portal is a **Servihabitat-hosted microsite**.
- `servihabitat.py`'s own module docstring already records that Servihabitat
  services "Sareb, CaixaBank and some Kutxabank stock" — corroborated by
  public reporting that Servihabitat acquired ~10,000 Kutxabank assets in
  2021. Kutxabank's REO inventory is administered and listed on the
  Servihabitat platform.

**Decision**: **No connector written for Kutxabank.** Its inventory is a
subset of Servihabitat's stock, and Servihabitat is already ingested
(`etl/connectors/servihabitat.py`). Building a second connector would
re-ingest the same assets under a different source name — exactly the
duplicate-ingestion the #132 consolidation caveat warns against. Close #137.

**Alternatives rejected**:
- *A thin Kutxabank connector pointed at the Servihabitat microsite path.*
  Rejected: it would produce duplicate `listing` rows (same asset, different
  `source`) for property already arriving through the Servihabitat connector,
  giving the dedup engine (#16) busywork for zero new inventory. If
  per-origin attribution is ever wanted, it belongs as a field the
  Servihabitat connector captures, not a separate connector.

**Rationale**: Same outcome and reasoning as Ibercaja→Solvia (D-065) and
Haya→Solvia (D-021): a bank brand consolidated onto a servicer platform we
already crawl adds nothing but duplicates.

**See**: `etl/connectors/servihabitat.py`, issue #137, D-065 (Ibercaja),
D-021 (Haya).
