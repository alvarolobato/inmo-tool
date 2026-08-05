---
id: D-075
title: Hipoges not respectfully crawlable — enumeration channels walled, capture-only
date: 2026-08-06
---

# D-075: Hipoges not respectfully crawlable — enumeration channels walled

*Decided: 2026-08-06*

**Context**: Issue #207 (found during the #131 investigation, folded into the
#132 batch) reported `realestate.hipoges.com` as sitemap-driven with "thousands
of listings" — the Servihabitat/Vivantial shape that "just works". Live
feasibility spike (2026-08-05, honest identifying User-Agent, no spoofing):

- `robots.txt` (HTTP 200) is permissive (`User-agent: * / Allow: /`) and
  advertises `Sitemap: .../sitemap.xml`. The **sitemap index** fetches fine
  and lists per-locale asset sub-sitemaps (`activo_es_sitemap.xml`, etc.).
- But every **asset sub-sitemap** returns **HTTP 403** with an app-level
  Spanish message `"No tiene permisos suficientes para acceder a esta ruta"`
  ("you don't have sufficient permissions for this route") — i.e. the very
  enumeration route the sitemap index and robots.txt point at is walled to a
  non-search-engine client. Confirmed identical from **two independent egress
  IPs** (this datacenter and WebFetch's Anthropic egress), so it is a genuine
  wall, not this environment's IP reputation.
- The site is an **Angular SPA shell** (BuildingCenter shape) served behind
  Imperva. Its same-host Express API GET routes (`/api/assets`,
  `/api/assets/search`, `/api/campaigns`) all return the same **403 "No tiene
  permisos suficientes"**. The only endpoint that responds is
  `POST /api/assets/map`, which requires reverse-engineering an undocumented
  internal filter DTO (an empty body → 400 "Parametros invalidos"; a guessed
  bbox → 500). Detail pages are Angular-rendered (no server HTML).

**Decision**: **No live-crawl connector written for Hipoges.** Every
sanctioned, public enumeration channel (the advertised sitemaps, the GET asset
API) explicitly denies permission to an honest client, and the only responsive
channel is an internal map POST the site walls behind "no permisos" — probing
it to coax data out is the Cimenta2 stop condition (D-033: *a permissive
robots.txt is not consent to take whatever an endpoint returns; stop probing
the moment you can answer the question*). The **browser-extension capture path
(#75)** is the correct route for this portal, capturing exactly the public
field subset a human is shown. Close #207 with this finding.

**Alternatives rejected**:
- *Reverse-engineer the `/api/assets/map` DTO and enumerate via bbox tiles.*
  Rejected: it means fuzzing an internal endpoint the site denies permission
  to, on a source whose sanctioned enumeration is walled — anti-bot evasion in
  spirit (issue #1 §15), and the same permission-bug-shaped access D-033
  refused.
- *Spoof a Googlebot UA to pass the sitemap allow-list.* Rejected: UA spoofing
  is explicitly out of scope (issue #1 §15, `docs/skills/connectors.md`).

**Rationale**: Hipoges is a multi-fund servicer whose stock is expected to
overlap portals already ingested, so the cost of NOT building a live connector
is low; and the access it would require crosses the project's good-neighbour
line. Capture-only keeps it in reach without that cost.

**See**: issue #207, D-033/D-034 (Cimenta2 stop condition), the BuildingCenter
worked example in `docs/skills/connectors.md`, issue #75 (extension capture).
