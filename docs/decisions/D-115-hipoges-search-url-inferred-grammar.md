---
id: D-115
title: Hipoges gets a search-URL builder — route grounded, token vocabulary INFERRED and flagged, corrected by capture-to-infer
date: 2026-08-19
group: Data / connectors
rule: '`dashboard/lib/search-url/portals/hipoges.ts` builds a Hipoges search URL from the grounded route shape `/:lang/:operation/:typology/:country/:town` (D-111''s Angular route table), but every token inside it (operation/typology/country/town) is an INFERENCE, never observed on a real URL. Every task carries an unconditional `"grammar"` loosened flag saying so. A registered `hipogesParser` wires D-051 capture-to-infer so the owner''s first real navigated search corrects the grammar automatically. Never encode price/size into `[:features]` — its grammar is completely unconfirmed; report price/size as dropped instead. No live probing to verify any of this.'
---

# D-115: Hipoges gets a search-URL builder — route grounded, token vocabulary INFERRED and flagged, corrected by capture-to-infer

*Decided: 2026-08-19*

**Context**: #548 shipped `etl/connectors/hipoges.py` (D-111) as a capture-only
connector — Hipoges (`realestate.hipoges.com`) has every sanctioned
enumeration channel walled (D-075) — but never wrote a search-URL builder.
The owner hit this immediately (issue #561): the ETL correctly never fetches
Hipoges (`scope_key()` always `None`), and `/captura` showed no Hipoges task
at all, so there was no button to press and no way to reach the portal
without guessing a URL by hand.

`etl/connectors/hipoges.py`'s module docstring already grounds the site's
Angular route table (read from the public `main-*.js`/`chunk-*.js` bundle —
a static asset, not an API call, the same source D-111 used for the
detail-URL shape):

```
:lang/detail/:id  and  :lang/:investment/detail/:id        (detail)
:lang/:operation/:typology/:country/:town[/:features]       (listing/search)
```

So the search route's SHAPE is grounded. What is not grounded is the
VOCABULARY inside it:
- `:operation` and `:typology` — #548 already inferred candidate tokens
  (`sale`/`rent`; `flat`/`house`/`garage`/`storage`/`land`/`office`/
  `building`/`apartment`) from the site's own public i18n bundle key names
  (`assets/i18n/es.json`, see `etl/connectors/hipoges_mapping.py`'s comment)
  and reused them in `listing_detect.py`/`detect.js`'s permissive search-page
  matcher, but never observed a real search URL to confirm them.
- `:country` and `:town` — genuinely NOT inferred from anything before this
  decision. No i18n evidence, no captured example.

A wrong token either 404s (visible, safe) or silently returns a different
search (invisible, dangerous) — the second is the one that matters.

**Decision**:

1. **`dashboard/lib/search-url/portals/hipoges.ts` builds one task per
   canonical property type**, using the grounded route shape with:
   - `:lang` = `"es"` (grounded — the sitemap index D-075/D-111 already
     confirmed advertises `_es_sitemap.xml` siblings for pt/gr/it);
   - `:operation` = `"sale"` always (inferred token; the profile scope has
     no operation field, matching idealista/aliseda's own sale-only
     precedent);
   - `:typology` = an inferred per-type token reusing #548's i18n-derived
     vocabulary (`piso→flat`, `chalet→house`, `garaje→garage`,
     `terreno→land`, `edificio→building`; `atico`/`local`/`nave` fold onto
     the nearest inferred token and are flagged `property_types`, same
     discipline as Aliseda's ático/chalet folding);
   - `:country` = `"espana"` (a bare guess — zero grounding, the single
     least-confident segment of the whole URL);
   - `:town` = the nearest known municipio (reusing `municipios.ts`, itself
     grounded for Idealista's OWN slug spelling, not Hipoges') else the
     containing province else `"espana"` — also unconfirmed for Hipoges.
   - `[:features]` is never populated: its internal grammar (price range?
     feature codes? something else?) is completely unconfirmed. A profile
     price/size bound is reported as a DROPPED (loosened) constraint
     instead of guessed into the URL — a second compounding guess would
     make the honesty problem worse, not better.

2. **Every task this builder emits carries an unconditional `"grammar"`
   loosened constraint** (`LoosenableConstraint` gains this new value,
   `dashboard/lib/search-url/types.ts`) — distinct in kind from every other
   flag, which names one specific dropped/broadened VALUE. `"grammar"`
   flags that the URL's basic token VOCABULARY is an unconfirmed inference,
   not a confirmed grammar with an occasional gap. It renders through the
   SAME existing "loosened" UI mechanism every capture task already uses
   (`CaptureTaskRow`'s inline flags) — no new UI surface needed.

3. **A `hipogesParser` is registered in `../parsers.ts`, wiring D-051
   capture-to-infer with no further code change.** The first time the
   owner navigates a real Hipoges search and clicks "Capturar todas", the
   extension's existing `search_url_example` piggyback (unchanged by this
   decision) decodes and auto-trusts it; the resolver then prefers that
   confirmed template over this builder's guess for the same section, and
   drops the guessed-grammar flags — the SAME upgrade path idealista and
   aliseda already have. The parser recognises a wider typology vocabulary
   than the builder emits (`apartment`/`storage` in addition to the emitted
   tokens) — the "recognise more than we generate" discipline Aliseda's
   parser already follows, since a real owner-navigated URL may use a
   category this builder never picks.

4. **No probing of any kind was performed to write this file** — no fuzzing
   `POST /api/assets/map`, no spoofed User-Agent, no "just try" a guessed
   URL against the live site. Every token traces to either the public route
   table (D-111), the public i18n bundle (#548), or is explicitly labeled a
   bare guess (`:country`, the `:town` fallback). If the owner's real
   navigation shows a token is wrong, D-051 corrects it — that mechanism,
   not a more careful guess, is the actual safety net.

**Alternatives rejected**:
- *Omitting `:country`/`:town` from the built URL entirely* (since they are
  the least-grounded segments) — rejected: the grounded route grammar shows
  them as required positional segments (only `[:features]` is bracketed
  optional), so a shorter URL would not match any real Angular route at
  all — strictly worse than a guessed-but-shaped URL, which at least has a
  chance of working and a defined failure mode (404).
- *Treating Hipoges as `verbatimOnly`* (no builder, no parser — the
  Altamira precedent for a portal whose grammar can't be verified) —
  rejected: unlike Altamira (WAF-blocked, D-027), Hipoges' ROUTE shape
  genuinely is grounded from public code, so a builder can do meaningfully
  better than "no chips, no warnings, verbatim pin only" — and a
  `verbatimOnly` portal has no `parse()`, which would forfeit D-051's
  self-correcting loop that this decision leans on to fix the guessed
  tokens.
- *A separate "unconfirmed" boolean field on `SearchTask` instead of a new
  `LoosenableConstraint` value* — rejected: the `loosened[]` mechanism
  already exists, already renders in the UI, and already carries a
  human-readable reason string — reusing it costs one union member and zero
  new UI code, versus a parallel field every consumer (UI row, e2e,
  `resolveTask`) would need to learn about separately.

**Rationale**: This is the minimal honest realisation of "give the owner an
entry point" — the same shape D-111 already established for the connector's
own DOM selectors (ship a working mechanism with every unverified guess
explicitly labeled, gated behind a correction path rather than silently
trusted). The route grounding is a genuine advantage over Aliseda/Altamira's
original launch state (this project's very first fully-guessed grammar
built entirely from public static assets, no captured specimen at all), and
the `"grammar"` flag keeps that honesty visible in the UI, not just in a
code comment, so the owner can tell "my token guess was wrong" apart from
"this search genuinely has no results" the moment a task 404s.

**See**: [issue #561](https://github.com/alvarolobato/inmo-tool/issues/561);
[D-111](D-111-hipoges-capture-only.md) (the capture-only connector and the
grounded detail-route table this reuses); [D-075](D-075-hipoges-walled-enumeration-capture-only.md)
(why Hipoges is capture-only — not re-litigated here); [D-051](D-051-capture-to-infer-search-urls.md)
(capture-to-infer — the correction mechanism this decision leans on);
[D-101](D-101-profile-connector-filter-override.md) (`captureUrl` vs `url`
distinction, consumed unchanged here); `etl/connectors/hipoges.py` (the
route-table docstring this reads), `etl/connectors/hipoges_mapping.py` (the
i18n-derived vocabulary reused here), `dashboard/lib/search-url/portals/hipoges.ts`,
`dashboard/lib/search-url/__tests__/hipoges.test.ts`, `docs/skills/search-url-builder.md`,
`docs/skills/captura-execution.md`.
