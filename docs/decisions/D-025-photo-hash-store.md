---
id: D-025
title: Photo hashes persist per URL, in their own connection, and never count as live fetch health
date: 2026-08-04
group: Data / connectors
rule: 'Photo hashes persist keyed on URL alone, failures retried after 7 days, on the store''s OWN autocommit connection. The #206 health rollup counts live fetches only — never store hits.'
order: 35
---

# D-025: Photo hashes persist per URL, in their own connection, and never count as live fetch health

*Decided: 2026-08-04*

**Context**: Issue #221. A full dedup run was going past 30 minutes, and the
cost was image I/O, not the O(n²) pair scan (~13.3 µs/pair). `_PhotoHashCache`
(`etl/dedup/engine.py`) memoised photo hashes for the duration of one run and
threw them away, so every pass re-downloaded and re-hashed every photo of
every listing — 1,166 listings / **24,229 photo URLs** on the live corpus,
against third-party CDNs, from a residential connection, outside any
connector's rate limiter. Measured on 300 real URLs: 34.58 s cold (115 ms/URL)
versus 0.01 s warm, i.e. ~46.5 min → ~0.5 s extrapolated to the whole corpus.
It scales with *total* listings, so it gets worse exactly as coverage
improves.

Three of the four rules below were only settled in review of PR #226, which
found that the first cut of the store re-opened the blind spot it was written
to close and could plausibly never have warmed up at all.

**Decision**:

1. **Keyed on `photo_url` alone, never `(listing_id, photo_url)`.** A
   perceptual hash of a given image never changes, so the cached value is
   immutable and there is no cache-coherence question to get wrong. A listing
   whose `photo_urls` array changes re-hashes only the genuinely new URLs with
   no invalidation logic; syndicated listings that share CDN objects across
   sources (Milanuncios carries `origin.provider = "fotocasa_pro"` entries)
   hash them once for the whole corpus.

2. **Failures are stored and retried after a 7-day backoff — not never, not
   every run.** Retrying a dead URL every run forever is how the Milanuncios
   "Rule parameter not Found" breakage (#209/#213, [D-020](D-020-milanuncios-photo-cdn-rule-parameter.md))
   stayed invisible: the cost was spread evenly across every run instead of
   showing as a spike. But #209 was a whole source failing for a *fixable*
   reason, so a store that never retried would have made the breakage
   permanent the moment it was fixed. 7 days is long enough that a dead URL
   costs one request a week rather than one a run, short enough that a CDN
   outage or an expiring signed URL heals with nobody intervening.

3. **The store gets its OWN connection, committed per save.** It must never
   ride the dedup run's transaction. `engine.run()` has no commit of its own —
   the only commits are incidental ones inside `perform_merge`/
   `file_suggestion` — so a run where no pair fires persisted nothing, and an
   interrupted cold pass (SIGINT, redeploy, OOM, the hourly scheduler
   colliding with it) discarded all ~46 minutes of fetching and started cold
   again next time. Sharing the connection also held every written row locked
   for the rest of the run, so a second concurrent run blocked for the first
   run's full duration the moment they touched a shared (syndicated) URL.
   `photo_hash_store.open_connection()` returns a separate `autocommit=True`
   connection, owned and closed by `engine.run()`.

4. **The #206 per-source health rollup counts live network fetches only.**
   `zero_success_sources()` reports `{source: live_attempted}` for a source
   that requested at least one photo over the network this run and got zero
   usable images back. Store hits count towards neither side. A fully warm
   source is reported as *nothing* — never as healthy.

5. **A store failure degrades to "fetch it live", never to an exception.**
   `photo_hash_store.load()`/`save()` swallow everything and return `{}`/
   `False`. Pre-#221 a malformed URL cost one photo; it must not now cost the
   run.

**Alternatives rejected**:

- *`conn.commit()` inside `save()`.* Sounds like the cheap version of rule 3,
  but with a shared connection it commits the dedup run's in-flight work too.
  The separate connection is what makes a per-save commit safe.
- *Batching store commits every N saves.* Reintroduces a loss window and a
  longer lock, to save commits that don't cost anything: every save follows an
  image fetch measured at ~115 ms, against which a single-row commit does not
  register.
- *Counting cached hashes as successes in the health rollup* (what the first
  cut did). Measured on the literal #209 shape — warm the store while the CDN
  is healthy, then make every live fetch 404, including a brand-new listing
  whose four URLs have never worked — pre-store reported
  `{'milanuncios': 8}` and the warm store reported `{}`. Eight hashes recorded
  before the outage outvoted four live 404s, and the detector built for that
  exact incident stayed silent through it.
- *Reporting a fully-warm source as healthy.* "We did not check" is the honest
  answer when zero requests were made, and it is never wrong the way "healthy"
  was. Any source still ingesting new listings has live attempts every run to
  be judged on, which is exactly the population where a dead CDN needs
  catching.
- *A partial index on `(last_attempt_at) WHERE NOT ok`.* Shipped in the first
  cut; `EXPLAIN ANALYZE` over 50k rows never chose it (bitmap scan on the
  primary key, second predicate as a heap filter). Dropped — it only cost
  write throughput on the hot path.

**Rationale**: The optimisation is worth having only if it actually survives a
run (rule 3) and only if it doesn't buy speed by blinding the monitoring
(rule 4). Both failure modes are the same shape as the incident that motivated
the work in the first place: a cost or a breakage that is invisible because
nothing reports on it.

**See**: `etl/dedup/photo_hash_store.py`, `etl/dedup/signals/photo_hash.py`
(`fetch_hashes_with_stats`, `PhotoFetchStats`), `etl/dedup/engine.py`
(`_PhotoHashCache.zero_success_sources`, `run`), `etl/schema/init.sql`
(`photo_hashes`), `etl/tests/test_dedup_photo_hash_store.py`,
`etl/tests/test_dedup_engine.py::TestDedupRunResultPhotoHealth`, issues #221 /
#206 / #209 / #213, PR #226,
[D-020](D-020-milanuncios-photo-cdn-rule-parameter.md).
