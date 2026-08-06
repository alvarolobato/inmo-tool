---
id: D-082
title: Deutsche Bank DB Real Estate not buildable — portal domain is dead
date: 2026-08-06
---

# D-082: Deutsche Bank DB Real Estate not buildable — portal domain is dead

*Decided: 2026-08-06*

**Context**: Issue #129 (part of the #132 bank/fund REO batch, flagged there as the
"smallest/most uncertain" portal) asked whether Deutsche Bank runs a real standalone
crawlable REO portal or only has a syndicated pro-page presence. The feasibility spike
(2026-08-06, honest descriptive User-Agent) found:

- `www.deutsche-bank.es` serves a clean permissive `robots.txt` (HTTP 200) — but its
  `sitemap.xml` and site content are the **retail bank** only (mortgages, accounts,
  investments). There is no property portal, no `inmuebles`/`viviendas` search, nothing to
  `discover()` on the bank's own site.
- DB's REO stock was historically published on a separate servicer portal, **"DB
  Inmuebles"**, cited by reference sources at `https://www.inmuebles.db.com/dbinmuebles/#/home`
  (a hash-routed SPA). That host is **NXDOMAIN**: `inmuebles.db.com` and
  `www.inmuebles.db.com` fail to resolve on both the local resolver and public `8.8.8.8`
  (the apex `db.com` resolves fine — only the Spanish property subdomain is dead).
  Candidate alternates (`dbinmuebles.es`, `dbinmuebles.com`, `inmueblesdb.es`) are all
  NXDOMAIN too.
- DB's ~100-property REO catalogue survives only as a syndicated **pro-page presence on
  consumer portals** (a live `yaencontre.com/inmobiliarias/deutsche-bank-…` agency page
  exists; likewise fotocasa). Those are separate connectors, not a DB-owned portal.

So the standalone portal the issue asks about is decommissioned — the same shape as
Ibercaja (D-065, `ibercajainmuebles.*` no DNS).

**Decision**: No Deutsche Bank connector is written — the standalone DB Inmuebles portal
domain no longer resolves, and `deutsche-bank.es` has no property portal. Issue #129 is
closed as not-feasible. DB's REO inventory reaches the platform, if at all, through the
consumer-portal connectors that already syndicate it, not a DB-specific connector. Revisit
only if DB stands a portal back up on a resolving domain.

**Alternatives rejected**: (1) Building against the retail `deutsche-bank.es` — rejected,
it has no listings. (2) Building a "DB connector" against the yaencontre/fotocasa pro pages
— rejected for the same reason as Lawbitat (D-080): that is those consumer portals, not a
DB portal, and would duplicate inventory another connector's scope owns. (3) Guessing at
another portal domain — rejected: every plausible candidate is NXDOMAIN, and shipping a
connector against a guessed host would raise on every run.

**Rationale**: Same batch rule as Ibercaja (D-065) and Divarian (D-076): a servicer whose
own portal host does not resolve has no crawlable site, so no connector is written; its
book, where public, flows through an already-ingested consumer portal.

**See**: issue #129, tracking issue #132; D-065 (Ibercaja, no DNS), D-076 (Divarian
unreachable), D-021 (Haya→Solvia). Sibling verdicts this batch: D-080 (Lawbitat parked),
D-081 (Bankinter Cloudflare WAF).
