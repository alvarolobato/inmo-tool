---
id: D-065
title: Ibercaja Inmuebles not buildable — served by Solvia
date: 2026-08-05
group: Data / connectors
rule: 'Ibercaja Inmuebles (#127) not buildable: no standalone portal (all `ibercajainmuebles.*` domains have no DNS) — its REO stock is listed on Solvia (`solvia.es?esOrigenProducto=IBERCAJA`, already ingested D-018). No connector written (same pattern as Haya D-021).'
order: 17
---

# D-065: Ibercaja Inmuebles not buildable — served by Solvia

*Decided: 2026-08-05*

**Context**: Issue #127 (part of the #132 bank/REO connector batch) asked for
a connector against Ibercaja's REO portal, "serviced in collaboration with
Solvia", and explicitly told the spike to **check overlap with the existing
Solvia connector before building**. Live feasibility spike (2026-08-05):

- The domain the issue names (`www.ibercajainmuebles.es`) and every obvious
  variant (`ibercajainmuebles.com`, `portalinmobiliario.ibercaja.es`) have
  **no DNS record** — there is no standalone Ibercaja property portal.
- Ibercaja's own portal page (`www.ibercaja.es/particulares/portalinmobiliario/`)
  links out to **Solvia** as its only property-search destination:
  `https://www.solvia.es/?esOrigenProducto=IBERCAJA&utm_source=ibercaja...`.
  Ibercaja's REO stock is administered and listed **on the Solvia platform**,
  tagged with the `esOrigenProducto=IBERCAJA` origin parameter.

**Decision**: **No connector written for Ibercaja.** Its inventory is a
filtered subset of Solvia's, and Solvia is already ingested (D-018 /
`etl/connectors/solvia.py`). Building a second connector would re-ingest the
same assets under a different source name — exactly the duplicate-ingestion
the #132 batch's consolidation caveat warns against. Close #127.

**Alternatives rejected**:
- *A thin Ibercaja connector that queries Solvia with
  `esOrigenProducto=IBERCAJA`.* Rejected: it would produce duplicate
  `listing` rows (same asset, different `source`) for property already
  arriving through the Solvia connector, giving the dedup engine (#16) busywork
  and inflating counts, for zero new inventory. If per-origin attribution is
  ever wanted, it belongs as a field the Solvia connector captures, not a
  separate connector.

**Rationale**: Same outcome and reasoning as Haya
([D-021](D-021-haya-merged-into-solvia.md)) — a bank brand whose REO stock is
serviced *by* Intrum/Solvia and surfaced through the Solvia platform, not a
separate crawlable portal. The batch's job here is to establish that and stop,
not to build redundant ingestion.

**See**: issue #127, tracking issue #132,
[D-021](D-021-haya-merged-into-solvia.md) (Haya → Solvia, the identical
pattern), [D-018](D-018-solvia-sitemap-partitioning.md) (the Solvia connector
that already covers this inventory).
