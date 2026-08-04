---
id: D-020
title: Milanuncios photo URLs must carry an explicit ?rule= transform parameter
date: 2026-08-04
---

# D-020: Milanuncios photo URLs must carry an explicit ?rule= transform parameter

*Decided: 2026-08-04*

**Context**: Issue #206 — every Milanuncios photo URL the dedup `photo_hash`
signal tried to fetch was 404ing with `"Rule parameter not Found"`. This
silently killed the strongest evidence for cross-portal duplicates
involving Milanuncios: `match_ratio` is computed only over
successfully-hashed photos, so a Milanuncios listing contributed none, and
the pair that motivated this investigation (property 62, milanuncios, vs.
property 146, fotocasa — 11/11 photos the same real flat) could not be
detected by this signal. Live investigation, 2026-08-04:

- A real Milanuncios search page's rendered `<img>` tags always carry a
  `?rule=<preset>` query parameter (e.g. `?rule=hw396_70`,
  `?rule=detail_640x480`) — but the JSON `ad.images` array `normalize()`
  reads from never includes it; the site's frontend adds it at render time.
- Fetching `https://images.milanuncios.com/api/v1/ma-ad-media-pro/images/<uuid>`
  bare returns HTTP 404 with body `"404 Rule parameter not Found"` (a real
  Varnish response, byte for byte the production symptom). Fetching the
  same URL with `?rule=detail_640x480` returns HTTP 200 with a real JPEG.
  Neither `Referer`, `Origin`, nor `Accept` headers change the outcome —
  this is a required query parameter, not a header/auth/CORS problem.
  `thumb` and `original` are NOT valid rule names on this host and still
  404; `detail_640x480`, `detail_432x320`, `hw396`, `hw396_70` are.
- The older `images-re.milanuncios.com/images/ads/<uuid>` host (still used
  by other listings) does NOT require the parameter — it serves the
  original asset either way — but accepts the same `?rule=` resize hint
  harmlessly (live-verified both ways), so a single unconditional fix
  covers both hosts without per-host branching.
- Fotocasa's own `multimedia[].src` values already arrive with
  `?rule=original` baked in server-side, on the *same* underlying asset
  UUIDs as Milanuncios (both sites share Adevinta's media backend, per
  `milanuncios.py`'s own module docstring on `origin.provider =
  "fotocasa_pro"` syndication) — independent confirmation that this CDN
  family is rule-based by design, not a one-off Milanuncios quirk.

**Decision**: `etl/connectors/milanuncios.py::normalize()`'s `_to_photo_url`
appends `?rule=detail_640x480` to any photo URL that doesn't already carry a
query string, before the URL is ever stored in `CanonicalListingVersion.photo_urls`.
`detail_640x480` was picked from the confirmed-valid set as a reasonably
large (640px), non-cropped size — a good match for what the `photo_hash`
perceptual-hashing signal (`etl/dedup/signals/photo_hash.py`) actually
needs, since that's the one real consumer this bug broke. This is a
connector-layer fix (the *stored URL* was wrong/incomplete), not a
`photo_hash.py` header/auth fix — headers don't affect this CDN's behavior
at all (see evidence above).

**Alternatives rejected**:
- *Fix in `photo_hash.py` via headers* — investigated first per the issue's
  own instructions; ruled out because Referer/Origin/Accept genuinely don't
  change the CDN's response (verified live, both with and without headers
  against the same URL).
- *Per-host branching (only add `?rule=` for `images.milanuncios.com`,
  leave `images-re.milanuncios.com` untouched)* — unnecessary complexity:
  the older host accepts the same parameter harmlessly, so one unconditional
  rule covers both without needing to hardcode host names that could
  change.
- *Accept the gap and document it* — the issue's own fallback instruction
  ("if the images are genuinely unfetchable, say so and stop") — not taken,
  because the images ARE fetchable; this is a one-query-parameter fix, not
  a genuine dead end.

**Rationale**: The fix lands at the layer that owns data correctness (the
connector), matching this project's own precedent that a connector's
`normalize()` output should be a directly usable value, not a value that
happens to work only when a caller adds a missing piece. It also benefits
every future consumer of `photo_urls` (not just `photo_hash`), and needed
no per-host special-casing since the parameter is harmless where it isn't
strictly required.

**See**: `etl/connectors/milanuncios.py` (`_to_photo_url`, `normalize()`),
`etl/dedup/signals/photo_hash.py` (`fetch_hashes`'s aggregated-warning
change, and the attempt counter that became
`PhotoFetchStats.live_attempted` in [D-025](D-025-photo-hash-store.md)),
`etl/dedup/engine.py`
(`_PhotoHashCache`'s per-source health tracking,
`DedupRunResult.photo_hash_zero_success_sources`), issue #206,
`docs/architecture/connectors.md`'s Milanuncios section,
`etl/tests/test_connector_milanuncios.py::TestPhotoUrlRuleParameter`,
`etl/tests/test_dedup_signals_photo_hash.py::TestRuleParameterCdnPattern`.
