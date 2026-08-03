---
id: D-015
title: Rental connector targets Milanuncios (alquiler-de-pisos), as a subclass — not Servihabitat/Vivantial, not an edit to the sale connector
date: 2026-08-03
---

# D-015: Rental connector targets Milanuncios (`alquiler-de-pisos`), as a subclass — not Servihabitat/Vivantial, not an edit to the sale connector

*Decided: 2026-08-03*

**Context**: Issue #31's Context says to "reuse task 1.4/2.1's site choices rather than adding a third site." Of the sites already integrated for sale, the implementing brief specifically flagged Servihabitat and Vivantial as the two with the cleanest track record (`docs/architecture/connectors.md`: zero errors, no discovered/fetched gap) and asked to prefer that access pattern where one exists. Both were live-checked first, before Milanuncios, and both were ruled out on real evidence:

- **Servihabitat's own `robots.txt`** (quoted verbatim in `servihabitat.py`'s module docstring) carries `Disallow: /alquiler` — the site's rental section is explicitly off-limits to any respectful crawler, full stop.
- **Vivantial has no rental section at all** — already confirmed and documented in `vivantial.py`'s own `normalize()` comment: "The sitemap and every sampled page are sale listings; the site has no rental section."

Fotocasa, Milanuncios, and Solvia's connector files (`fotocasa.py`, `milanuncios.py`, `solvia.py`) were off-limits to edit for this task (owned by other in-flight PRs rebasing/fixing them). Idealista is capture-only (issue #75) — no live discover/fetch path exists to extend.

Milanuncios was the next-best option, not a fallback of convenience: `milanuncios_mapping.py` already has an `infer_operation()` helper recognizing `alquiler-*` category slugs (added for issue #78's miscategorization handling, unused for discovery until now), and — critically — `MilanunciosConnector.fetch_detail()`/`normalize()` needed **zero changes** to work for rentals: neither hardcodes `"sale"` anywhere; `normalize()` already derives `operation` from the ad's own `category.slug`. Only `discover()` is scoped to the sale-category URL.

Live verification (2026-08-03, this session): `GET https://www.milanuncios.com/alquiler-de-pisos-en-madrid-madrid/` returned HTTP 200 with 41 real rental ads in the same `__INITIAL_PROPS__` JSON shape as the sale category page, every ad carrying `category.slug == "alquiler-de-pisos"` and a price under the same `price.cashPrice.value` field sale ads use. `robots.txt` was re-checked live for this exact path and carries no matching `Disallow` rule.

**Decision**: `etl/connectors/milanuncios_rental.py` defines `MilanunciosRentalConnector(MilanunciosConnector)` — a subclass, not a copy, and not an edit to `milanuncios.py`. It overrides only `discover()` (targets `alquiler-de-pisos-en-{geo}-{geo}/` instead of `venta-de-pisos-en-{geo}-{geo}/`) and `name`/`rate_limit_per_minute`; `fetch_detail()` and `normalize()` are inherited unchanged. `milanuncios_mapping.py`'s `CATEGORY_SLUG_MAP` gained one additive entry (`"alquiler-de-pisos": "piso"`) — without it every rental listing would normalize with `property_type = NULL`, silently breaking the comparable query's `WHERE property_type = ...` match for every ingested row (found and fixed during implementation, not a hypothetical). `rate_limit_per_minute = 10` — half of `MilanunciosConnector`'s 20 — because both connectors hit the same domain/IP; running both at their own independently-"safe" 20/min would double the total request volume Milanuncios sees from this IP versus what the original sale-only feasibility spike validated, and (unlike Fotocasa's directly-measured ~136-fetch cumulative soft-block threshold) Milanuncios' cumulative tolerance has never been measured.

**Alternatives rejected**: Editing `milanuncios.py` directly to add a rental scope — rejected on two grounds: it's owned by other in-flight work (out of bounds regardless of technical merit), and even without that constraint, a subclass is the smaller, more reviewable diff for a connector whose only real difference is one URL.

**Rationale**: The subclass design means the two behaviourally-load-bearing methods (`fetch_detail`, `normalize`) are proven code, not new code — every bug class they could have (parsing regressions, field-mapping mistakes) was already caught by `test_connector_milanuncios.py`'s existing suite. `test_connector_milanuncios_rental.py` only needs to prove the one real difference (the URL) and that the inherited `normalize()` genuinely derives `operation="rent"` end to end from a real rental page, not assume it.

**Caveat, documented rather than silently assumed**: `fetch_detail()`'s endpoint returned a bot-interruption/CAPTCHA page when tested from this session's sandboxed (non-residential) dev environment IP — for both a rental ad AND a freshly-discovered sale ad fetched in the same session, ruling out "this is rental-specific" or "this is a regression this connector introduced." Real connector traffic runs from the owner's home residential IP (AGENTS.md); this should be re-verified there before relying on live detail fetches in production. Until then, every fetch failure fails loudly via the existing `ConnectorError`/circuit-breaker path, same as any other connector — never silently.

**See**: `etl/connectors/milanuncios_rental.py` (full module docstring has every detail above), `etl/connectors/milanuncios_mapping.py`, `etl/tests/test_connector_milanuncios_rental.py`, `docs/architecture/connectors.md`, [D-016](D-016-rental-data-reuses-listing-table.md), issue #31.
