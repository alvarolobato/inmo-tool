---
id: D-037
title: Aliseda is ingested via guided browser-extension capture, not an automated connector
date: 2026-08-04
group: Data / connectors
rule: Aliseda ingests via a capture-only connector + guided `capture_worklist` (`/etl/captura`), correlated by canonical `match_key`. Selectors are a draft, validate vs a real capture.
order: 44
---

# D-037: Aliseda is ingested via guided browser-extension capture, not an automated connector

*Decided: 2026-08-04*

**Context**: D-019 established that Aliseda is not buildable as an automated
connector — the public `www.alisedainmobiliaria.com` detail page is a bare
Angular shell with zero server-rendered content over plain HTTP, and the one
host that serves real listing data (`laravel.alisedainmobiliaria.com`) is
robots.txt `User-agent: * / Disallow: /`. D-019 **explicitly left as an owner
call** whether to route Aliseda to the #75 browser-extension capture path (a
human legitimately viewing `/inmueble/<id>` in their own browser, which the
extension then parses client-side-rendered). Issue #237 is that call being
made, together with the guidance layer the owner actually asked for ("a page
with all the places to visit one by one") that did not exist anywhere in the
repo.

**Decision**:
1. **Aliseda ingests via the extension-capture path, not a `discover()`/
   `fetch_detail()` connector.** `etl/connectors/aliseda.py` is capture-only,
   mirroring `idealista.py` exactly: `scope_key()` returns None (the
   orchestrator never sweeps it), `discover()`/`fetch_detail()` raise
   defensively, and the real entry point is `normalize()`, called by
   `etl/capture.py` on a captured, hydrated DOM. No automated request ever
   reaches any Aliseda host. Registered in `_CAPTURE_CONNECTORS`
   (`alisedainmobiliaria.com`) and `register_all()`.
2. **A guided worklist sits upstream of the capture pipeline, never gating
   it.** New `capture_worklist` table (`etl/schema/init.sql`) + dashboard page
   `/etl/captura` + `/api/etl/worklist` routes. It is a *producer of URLs for
   the human to open*: a capture whose URL is on no worklist still processes
   normally. Correlation is by `match_key` — a cosmetic-difference-tolerant
   canonical URL form (host w/o `www` + path, no trailing slash/scheme/query),
   computed identically in TS (`lib/worklist.ts` `worklistMatchKey`, seed time)
   and Python (`etl/capture.py` `worklist_match_key`, correlation time), pinned
   by a shared truth table in both test suites. Seeding is manual paste today
   (Aliseda has no usable sitemap); `added_via` reserves `sitemap`/`derived`
   for portals that gain those paths later.
3. **The extension's supported-host list is backend-driven.** `GET
   /api/extension/config` returns the capture hosts (from
   `lib/worklist.ts CAPTURE_HOST_SUFFIXES`, the dashboard mirror of
   `_CAPTURE_CONNECTORS`); `background.js` caches it, so a new capture portal
   lights up the badge with no extension redeploy. Capture already works on any
   http(s) tab, so this only drives the cosmetic badge and degrades to a
   hardcoded default on any fetch failure.

**Honesty constraint on the Aliseda mapping**: the field selectors in
`aliseda.py`/`aliseda_mapping.py` are a **best-effort draft built against a
fabricated fixture**, because a real rendered Aliseda DOM cannot be obtained
without a live human capture (a plain fetch returns the empty shell, and this
project does not defeat that). Only the analytics-beacon key names D-019
observed (`ciudad`/`provincia`/`metros_cuadrados`/`habitaciones`/`precio`) are
grounded; everything else — the `dataLayer` wrapper shape, the DOM fallback
selectors — is a guess. **The selectors MUST be validated/refined against the
owner's first real capture** (checklist in `aliseda.py`'s docstring); the code
is structured so refining is a constants edit, not a rewrite.

**Alternatives rejected**:
- *Building an automated Aliseda connector anyway*: rejected by D-019
  (unqualified robots.txt disallow on the data host; app-shell HTML has nothing
  to parse). Unchanged.
- *A parallel worklist ingest path*: rejected — the worklist sits entirely
  upstream of #75's pipeline; captured Aliseda listings flow through the exact
  same `_upsert_canonical_listing()` + dedup path as any other source.
- *Correlating captures to the worklist by exact URL string*: rejected — the
  captured `window.location.href` cosmetically differs (trailing slash, query,
  case) from the seeded URL; a canonical `match_key` correlates robustly.
- *Hardcoding the extension's supported hosts*: rejected per Fable's #237 §3
  note — backend-driven config means new portals need no extension version bump.

**Rationale**: This is the minimal, honest realisation of the owner's stated
vision — a guided list of places to visit, captured one by one by a human in
their own browser — reusing #75's shipped, security-reviewed pipeline end to
end and adding nothing parallel to it. The one thing that cannot be honestly
finished without the owner is the Aliseda selector set, which is why it ships
as an explicitly-marked draft with a validation checklist rather than
fabricated precision.

**See**: [issue #237](https://github.com/alvarolobato/inmo-tool/issues/237),
[issue #75](https://github.com/alvarolobato/inmo-tool/issues/75) (capture
pipeline), [D-019](D-019-aliseda-not-viable-disallowed-api.md) (the routing
question this resolves),
[D-041 archived](archive/D-041-e2e-required-for-features.md) (the e2e bar the
worklist page is held to), `etl/connectors/aliseda.py`,
`etl/connectors/aliseda_mapping.py`, `etl/capture.py`,
`dashboard/lib/worklist.ts`, `dashboard/app/etl/captura/page.tsx`.
