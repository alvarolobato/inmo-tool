---
id: D-101
title: Owner-pinned profile_connector_filter URL is the recall source per (profile × connector)
date: 2026-08-08
group: Data / connectors
rule: 'The URL pinned in `profile_connector_filter` IS the recall source for that (profile × connector): tier 0 over D-051 (owner-confirmed beats every derived URL), used VERBATIM and never re-substituted. For an HTTP connector declaring `supports_search_override=True` (pisos, habitaclia, milanuncios — sale only) it becomes `ConnectorScope.override_url`, which `discover()` hits as its entry page instead of the slug it would build, and which `scope_key()` incorporates (`override:<url>`) so the override scope is never deduped against the twin non-override scope. `_scopes_for_connector` ADDS one override scope per active profile''s pin (never replacing the derived/`geography_override` scopes); precedence per-profile override > `connector_config.geography_override` > profile-derived. A connector without `supports_search_override` ignores any pin (no error). Data-layer filters (`scope-query.ts`, feed filters) still apply over the captured data unchanged — a too-broad pin only costs capture time.'
---

# D-101: Owner-pinned URL as the recall source per (profile × connector)

*Decided: 2026-08-08*

**Context** (issue #478, Phase 5 of 5; builds on P1–P4 and on D-051/D-090):
Search-URL recall for the HTTP connectors was 100% code-derived — each
connector built its entry URL inside `discover()` from the profile's
`center`/`radius_km` (`_search_url(geography)`). Phases 1–4 gave the owner a way
to **see**, **open (without capture)**, **tune**, and **pin** a per-(profile ×
connector) search URL into the `profile_connector_filter` table, and to preview
what every registered connector would run (`search_previews()` /
`connector_search_preview`). What was still missing was closing the loop for the
ETL: a pinned URL was stored and shown, but `discover()` never actually used it.
This phase makes a saved pin the real entry page for the connectors whose
grammar is a single entry page.

D-051 already established a 3-tier precedence for the extension portals'
TypeScript resolver (learned example → same-area reuse → hand-written builder),
and Phase 1 added the owner's pin as **tier 0** there. This decision records the
equivalent, and the strongest, rule for the Python HTTP connectors: an
owner-pinned URL is the maximal "owner-confirmed" signal (D-090 keeps URL
*building* code-driven, but an owner who tuned and pinned a URL by hand has
confirmed it), so it wins over everything derived.

**Decision**:

1. **`ConnectorScope.override_url: str | None`** carries the pinned URL through
   the same `discover()`/`scope_key()` path as `rooms` (same precedent). It is
   used **verbatim** — never re-substituted the way a tier-1 learned template is
   (the owner tuned it; re-writing it would contradict the intent and would
   break un-parseable URLs like `shape=`).

2. **`scope_key()` incorporates `override_url`.** The base default appends
   `|override:<url>` when present; the supporting connectors key purely off
   `override:<url>` (geography is irrelevant to a pinned URL, and this keeps the
   override scope always resolvable even when the profile's geography would not
   resolve). Either way the override scope's key differs from the twin
   (non-override) scope's, so the orchestrator's per-run `seen_scope_keys` dedup
   can never collapse them — **both run**.

3. **`_scopes_for_connector` ADDS override scopes, it does not replace.** For a
   connector declaring `supports_search_override`, every active profile that
   pinned a URL for it yields one dedicated `ConnectorScope` carrying that
   profile's geography plus `override_url`. These are added on top of whatever
   base scopes the `connector_config`/profile logic resolved. Precedence for a
   given profile: **per-profile pinned override > `connector_config.geography_override`
   (global) > profile-derived scopes**. A connector without
   `supports_search_override` never gains an override scope (the pin is ignored,
   no error) — the same identity-contract posture `rooms` already has.

4. **`discover()` consumes it as the entry page.** With an override present and
   support declared, `discover()` requests the pinned URL directly and skips the
   derived-slug construction (geography resolution is bypassed). Without an
   override the code path is byte-identical to before — the retrofit is guarded
   by a per-connector "byte-identical without override" pytest.

5. **First supporting connectors: pisos, habitaclia, milanuncios (sale only).**
   These are single-entry-page grammars, so the retrofit is minimal.
   `MilanunciosRentalConnector` declares `supports_search_override = False`
   explicitly (its own `discover()` was not wired) — it, plus fotocasa, diglo,
   unicaja, solvia, servihabitat, are documented next candidates, each needing
   its own mini-issue for pagination/partitioning. The sitemap/API connectors
   (cimenta2, vivantial, buildingcenter, escogecasa) are national/complete
   recall and stay non-tunable (nothing to pin).

**Alternatives rejected**:

- *Replacing the derived scope instead of adding.* Base scopes are deduped
  across profiles and carry no profile id, so removing "the derived twin" for a
  pinning profile could silently drop recall for another profile that shares the
  same geography. Adding a distinctly-keyed override scope is safe and matches
  the "search URL's only job is recall; data-layer filters do the rest" model —
  a redundant/over-broad crawl only costs capture time.

- *Re-substituting the profile's numbers into the pinned URL (tier-1 style).*
  Rejected: the owner tuned it; re-writing contradicts "this will be the
  source", and it breaks un-parseable URLs. Any scope mismatch is surfaced in
  the UI (chips), not silently corrected.

**Rationale**: One number/one order for the extension side (tier 0 in the TS
resolver) and one entry page for the ETL side (`override_url` in `discover()`),
both driven by the same `profile_connector_filter` pin, closes the owner's loop
without touching the data-layer filters. Keeping the override an *additive*,
distinctly-keyed scope preserves #71/#99's dedup and fairness machinery
unchanged.

**See**: issue #478 (esp. Phase 5 + Design §1/§2/§6); D-051
(`docs/decisions/D-051-capture-to-infer-search-urls.md`), D-090
(`docs/decisions/D-090-discovery-drift-detection-only.md`); #471 (shape=
grammar spike — the "Abrir (validación) → tune → pin" flow produces both the
specimen and the pin); `etl/connectors/base.py`
(`ConnectorScope.override_url`, `scope_key`), `etl/orchestrator.py`
(`_override_scopes_for_connector`, `_scopes_for_connector`),
`etl/connectors/{pisos,habitaclia,milanuncios}.py`,
`docs/architecture/connectors.md`, `docs/skills/search-url-builder.md`.
