---
id: D-022
title: Milanuncios photo-URL backfill migration mirrors the connector's own rule
date: 2026-08-04
---

# D-022: Milanuncios photo-URL backfill migration mirrors the connector's own rule

*Decided: 2026-08-04*

**Context**: Issue #210, filed immediately after deploying #209 (D-020).
#209 fixed `MilanunciosConnector.normalize()` to append `?rule=detail_640x480`
to any photo URL missing a query string — but `normalize()` only runs at
ingest. Every URL already sitting in `listing.photo_urls` before that deploy
was untouched. Measured on the live deployment right after deploying #209:

```sql
SELECT count(*) FILTER (WHERE u LIKE '%?rule=%') AS with_rule, count(*) AS total
FROM (SELECT unnest(photo_urls) AS u FROM listing WHERE source='milanuncios') x;

 with_rule | total
-----------+-------
         0 |   795
```

**Zero of 795** — the photo_hash dedup signal stayed fully dead for the
entire pre-existing Milanuncios corpus (a live run logged `photo_hash: 9/9
photo(s) failed to fetch/hash (source=milanuncios)`), and waiting for a
natural re-fetch does not fix it: Milanuncios blocks `fetch_detail()` after
~5 successes per run (D-017) against ~60 stored listings, and skip-if-seen
(issue #143) deliberately never re-fetches an unchanged listing — many of
the 60 would never be re-fetched at all.

**Decision**: A one-off backfill migration in `etl/schema/init.sql` (the
"Backfill: Milanuncios photo URLs..." block) — a pure string transform on
data already held, no network, no re-fetch:

```sql
UPDATE listing
SET photo_urls = ARRAY(
    SELECT CASE
        WHEN position('?' IN u) = 0
            OR substring(u FROM position('?' IN u) + 1) = ''
        THEN u || (CASE WHEN u LIKE '%?' THEN '&' ELSE '?' END) || 'rule=detail_640x480'
        ELSE u
    END
    FROM unnest(photo_urls) AS u
)
WHERE source = 'milanuncios'
  AND EXISTS (
      SELECT 1 FROM unnest(photo_urls) AS u
      WHERE position('?' IN u) = 0
         OR substring(u FROM position('?' IN u) + 1) = ''
  );
```

Two things mattered more than the SQL itself:

1. **Same rule as `normalize()`, not a reimplementation.** `PHOTO_RULE` and
   `add_photo_rule_if_missing(url)` were hoisted out of `normalize()`'s old
   local closure to module level in `etl/connectors/milanuncios.py`, giving
   the rule one importable, testable Python source of truth.
   `init.sql` is applied as raw SQL text (no Python runtime at that point),
   so the SQL above is a hand-written mirror, not a literal function call —
   but `test_migration_sql_matches_add_photo_rule_if_missing`
   (`etl/tests/test_connector_milanuncios.py`, DB-backed) runs this exact
   `UPDATE` against a battery of representative URLs (both real CDN host
   shapes, an already-migrated URL, a non-rule query string, and the
   trailing-bare-`?` edge case) and asserts the SQL's output equals
   `add_photo_rule_if_missing`'s output for every one of them. Mutation-
   tested: changing the SQL's literal rule string, or replacing the inner
   `CASE`'s guard with an unconditional `WHEN TRUE`, both make this test
   fail (the second one specifically because the test includes an
   already-`?rule=`-bearing URL in the same row as still-bare ones — a
   naive "just append" mutation double-stamps it,
   `...?rule=detail_640x480?rule=detail_640x480`). If `PHOTO_RULE` or
   `add_photo_rule_if_missing` ever changes, this test fails until the SQL
   literal is updated to match.
2. **Idempotent, proven so.** The `WHERE`/`CASE` guards only ever touch a
   URL whose query part is empty, so a listing already fully backfilled
   (including one ingested fresh, post-#209, which already carries
   `?rule=...` from `normalize()` itself) is left alone on every re-run —
   required, since `init.sql` is re-applied on every ETL container start.
   `test_migration_is_idempotent_on_a_second_application` applies the
   migration twice against data shaped like `main`'s and asserts the
   second application changes nothing (`UPDATE 0`, byte-identical
   `photo_urls`). Verified against the real corpus too (see below): a
   second `psql -f init.sql` against the same restored database reported
   `UPDATE 0` on all four `listing`-touching migrations in the file, and
   `md5(string_agg(photo_urls::text, ...))` over every Milanuncios listing
   was byte-identical before and after the second run.

**Verified on real data, not just in tests**: a `pg_dump`/`pg_restore` copy
of the live corpus (63 Milanuncios listings, 795 photo URLs, 27
`suggested_merge` rows with `match_basis='photo_hash'` involving a
Milanuncios listing) into a dedicated, uniquely-named database. Applying
this branch's `init.sql` against the copy:

- `UPDATE 62` (62 of 63 Milanuncios listings had ≥1 URL needing the fix;
  the 63rd already had one, or had none).
- After: `795/795` stored Milanuncios photo URLs carry a query string (was
  `0/795`).
- A real `python -m etl.dedup.cli run` (genuine network fetches — spot-
  checked directly: `images.milanuncios.com/.../<uuid>` bare 404s, the
  same URL with `?rule=detail_640x480` returns HTTP 200 with a real JPEG)
  against the migrated copy: the **pending suggestion count stayed at
  27** (`ON CONFLICT (listing_id_a, listing_id_b) DO NOTHING` leaves
  pre-existing suggestions alone, and none of the newly-hashable pairs
  happened to land in the 0.6–0.99 partial-match band), but the run
  produced a **new, real `photo_hash` auto-merge that was structurally
  impossible before this migration**: `property_merge_log` row 29
  (`match_basis='photo_hash'`, `confidence=0.900`, timestamped exactly at
  this run) merged Fotocasa listing 191 into the property anchored by
  Milanuncios listing 76 — a `match_ratio == 1.0` pair (issue #188's
  auto-merge path), corroborated by size/price proximity. Listing 76's
  `photo_urls` carried bare (no-`?rule=`) URLs before this migration ran
  against this copy, confirmed against the same restored corpus — this
  pair could not have been detected by `photo_hash` (which returns `None`
  whenever either side has zero successfully-hashed photos) until the
  backfill ran. This is stronger evidence than a suggestion-count increase
  would have been: a full auto-confirmed merge, not a pending row a human
  still has to review.
- The run's own per-source health tracking (`DedupRunResult
  .photo_hash_zero_success_sources`, issue #206) reported **no source at
  0% this run** — Milanuncios previously logged `photo_hash: 9/9 photo(s)
  failed to fetch/hash`; that line is gone entirely post-migration.
  Confirms issue #210's second acceptance criterion (check whether another
  source has the same problem): Fotocasa, Solvia, Servihabitat, and
  Vivantial were all spot-checked with real direct fetches during this
  same verification and returned real image bytes — none needs a
  `?rule=`-style fix. Fotocasa's own URLs already arrive with
  `?rule=original` baked in server-side (D-020's own finding). No other
  source is at 0% photo-hash success.

**Alternatives rejected**:
- *A standalone Python migration script that imports and calls
  `add_photo_rule_if_missing` directly* — would give a literal, not just
  behavioural, "same helper" guarantee, but breaks this repo's established
  one-time-migration convention (a guarded block in `init.sql`, applied
  automatically on every ETL container start — see AGENTS.md and the other
  backfills already in this file, e.g. `listing.last_fetched_at`'s). Not
  worth introducing a second migration mechanism for one backfill.
- *`... LIKE '%?%'` (the issue's simplest candidate check)* — rejected in
  favour of the `position('?' IN u)`/`substring(...)` pair: a URL ending in
  a bare `?` (no content after it) already contains a literal `?`
  character, so `LIKE '%?%'` would wrongly treat it as "already has a
  rule" and skip it, diverging from `add_photo_rule_if_missing`'s
  `urlsplit(url).query`-based check (which treats a trailing bare `?` as
  "no query" and still appends the parameter). No such URL was found in
  the live corpus, but the equivalence test pins the edge case anyway
  since it's cheap to get right and expensive to get wrong later.
- *An `etl_one_time_migrations` marker-table gate* — unnecessary: the
  `WHERE`/`CASE` guards are already naturally idempotent (same pattern as
  the other non-marker-gated backfills already in this file), and a marker
  row would only add a second, redundant "have I already run" check.

**Rationale**: the same reasoning D-020 already established — a
connector's stored output should be directly usable — plus the specific
lesson this issue adds: a connector-layer fix to `normalize()` never
touches rows written before it shipped. Any future fix in the same shape
(a `normalize()` change to correct already-stored data) needs its own
backfill, checked the same way — reuse the rule, verify on real data, and
never let the SQL replica drift out of sync with the Python source of
truth.

**See**: `etl/connectors/milanuncios.py` (`PHOTO_RULE`,
`add_photo_rule_if_missing`, `normalize()`), `etl/schema/init.sql` (the
"Backfill: Milanuncios photo URLs..." block), `etl/tests/test_connector_milanuncios.py`
(`TestAddPhotoRuleIfMissing`, `TestMilanunciosPhotoUrlBackfillMigration`),
issue #210, [D-020](D-020-milanuncios-photo-cdn-rule-parameter.md),
[D-017](D-017-milanuncios-rate-measurement.md) (why waiting for a natural
re-fetch doesn't substitute for this migration),
`docs/architecture/connectors.md`'s Milanuncios section.
