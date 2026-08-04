# Dedup engine optimization — design proposal

*Design proposal, 2026-08-04. Analysis only — no implementation. See [AGENTS.md § Issue and PR format](../../AGENTS.md) for how this turns into issues once the owner reviews it.*

## Why this doc

The owner reported a full `ps dedup run` taking **~84 minutes** against the live corpus (~1,400 listings, 5 sources) and asked for it to be made more optimal. `etl/dedup/engine.py`'s own module docstring already names the textbook fix — blocking/bucketing before the O(n²) pairwise scan — and says explicitly it's "not yet built, deliberately... revisit once real connector volume makes a full pairwise scan slow." This doc takes that call seriously rather than assuming blocking is the answer: it reconstructs where the 84 minutes actually went, factors in **#226 (D-025)** — per-URL photo-hash persistence, merged today but **not yet deployed** to the owner's instance — and only then proposes what to build, in what order, and what to explicitly defer.

This is a companion to `docs/roadmap/connector-etl-ops.md` (PR #235, open, not yet merged) §7 "Better duplicate evaluation," which already covers per-signal precision tracking and flags the O(n²) cliff as a watch-line. This doc goes one level deeper on the engine-internals side that §7 explicitly left as "not urgent today, just a documented trigger" — the trigger condition, the blocking design itself, incremental dedup, and the profile-scoping question, none of which §7 designs in detail. Where the two overlap, this doc cites §7 rather than repeating it, and corrects one thing §7 got wrong by inference (queue ordering — see §5 below).

**Scale reminder** (per `docs/roadmap/connector-etl-ops.md`'s own framing, which applies here too): single-operator, laptop/small-Mac deployment. No distributed candidate-generation index, no sharding, no async job queue. Every proposal below is sized for "one Postgres instance, one Python process, a few thousand to tens of thousands of rows" — not "millions of rows, multiple workers."

---

## 1. Where the 84 minutes actually goes

### What's directly measured, and what's inferred

Three numbers exist in the codebase, from three different points in time and three different measurement methods — worth being explicit about which is which before combining them:

| Number | Source | What it measured |
|---|---|---|
| **~13.3 µs/pair** | `engine.py` module docstring, issue #185 | Pure in-memory `evaluate_pair` cost (cadastral → address_coords → phone → reference_code → photo_hash comparison → fuzzy), **with `photo_urls=()` so no network I/O ever happens** — a deliberate lower bound on CPU cost alone, measured n=419 through n=5,000. |
| **~46 minutes over ~24k URLs** | `photo_hash_store.py` module docstring + the #221/#226 commit message ("46 min of image fetching becomes 0.5s"), issue #221 | Real network fetch+hash cost for **every photo URL in the corpus, every run** — the actual cost #226 eliminates by persisting hashes per-URL. ~115ms/successful fetch × ~24,000 URLs ≈ 46 min. At ~1,400 listings that's ~17 photo URLs/listing, consistent with the 5-source corpus described in this task. |
| **~84 minutes** | Owner's report (this task), current live corpus | The actual wall-clock cost of one full `ps dedup run`, **pre-#226 deploy** — i.e. every photo URL is still being fetched fresh every run. |

Reconciling these: the ~979,300 total pairs at n=1,400 (`C(1400,2)`), even *without* removing same-source pairs, cost `979,300 × 13.3µs ≈ 13 seconds` of pure CPU per the docstring's own bound — nowhere close to 84 minutes on its own. The gap is real network I/O, not CPU: **photo I/O is the dominant cost today, not the O(n²) shape of the loop.** The ~46-minute figure alone accounts for the majority of the 84; the remaining ~38 minutes is very plausibly *also* photo I/O, just under worse real-world conditions than the ~115ms/URL average implies — `_REQUEST_TIMEOUT_SECONDS = 10` in `signals/photo_hash.py` means every dead CDN link, expired signed URL, or slow third-party host (Milanuncios' now-fixed #209/#213 CDN breakage is the exact precedent) costs up to 10 seconds, not 115ms, per failed URL. A few hundred slow/dead URLs in a ~24k-URL corpus is enough to add tens of minutes on its own — and `signals/photo_hash.py`'s own comment block documents finding exactly this class of URL (YouTube/Vimeo/Floorfy/Matterport tour links, "cannot identify image file") in a real production run, which the `_looks_like_photo_url` prefilter now (partially) avoids.

**This is stated as the best-supported inference from the code, not a directly measured split** — see the recommendation immediately below for how to stop inferring and start measuring.

### The bottleneck after #226 deploys

Once #226 is deployed to the owner's instance (it is merged to `main`, not yet running in production per this task's context):

- **Photo I/O collapses from ~46-80 min to near-zero on a warm store.** `_PhotoHashCache` already memoizes per-listing within a run (this was true before #226 too — `fetch_hashes` is O(n) listings, not O(n²) pairs, even pre-#226, per the engine docstring). What #226 adds is **cross-run** persistence: a URL hashed once is never fetched again, ever (barring the 7-day failure-retry window in `photo_hash_store.FAILED_RETRY_INTERVAL_SECONDS`). The commit message's own number — 46 min → 0.5s — is for a fully warm store hitting the same URL set again.
- **The residual bottleneck becomes the pure O(n²) CPU pass**: ~13 seconds at n=1,400 per the docstring's own bound (979,300 pairs × 13.3µs), plus real overhead the microbenchmark doesn't capture — Python-level loop bookkeeping (tuple-sort + set/dict lookups per pair for `skip_pairs`/`pending_by_pair`), `Decimal` arithmetic (slower than float, used throughout for confidence/price comparisons), and `rapidfuzz` calls in `address_coords.addresses_close`/`fuzzy.evaluate`. A realistic estimate is **low tens of seconds to a couple of minutes**, not hours — nowhere near today's 84 minutes.
- **A new, smaller O(n) cost appears**: `photo_hash_store.load()` issues one indexed `SELECT ... WHERE photo_url = ANY(...)` per listing that reaches the photo_hash stage (still memoized once per listing per run, same as before). At ~1,400 listings and a local Postgres instance (single-operator, laptop-class per the scale reminder), this is on the order of single-digit seconds total, not a new bottleneck.
- **First run after deploy is the exception, not the steady state.** The very first `ps dedup run` after #226 ships still has to fetch every currently-uncached URL — realistically most of the corpus, since nothing has been persisted yet. That first pass should look like the old ~46-84 minutes; it is every run *after* that which collapses.

**Conclusion: once #226 is deployed, the 84-minute problem is very likely already solved**, and the O(n²) shape the docstring flags as "the real piece of engineering... not yet built" is not yet the active bottleneck at this corpus size. Building blocking/bucketing right now would be optimizing a cost that's about to become small for an unrelated reason (#226), against a corpus (~1,400 listings) the engine's own docstring says doesn't need it yet (its trigger is ~15-20k).

### Recommendation 0 — measure before building anything else (build now, trivial cost)

`dedup_runs` (schema, `etl/schema/init.sql` ~L929) already has `duration_ms`, `pairs_compared`, `merged`, `suggested`, `conflicts` — but nothing splits *where inside a run* the time went. Add three cheap, additive timing fields to `DedupRunResult`/`dedup_runs` (no new table — same migration shape as #206's `photo_hash_zero_success_sources`, which is also a `DedupRunResult` field, not a schema column, because it doesn't need to be queried across runs; these three *do* need that, since the whole point is trend-watching after #226 deploys):

- `photo_fetch_ms` — wall-clock time inside `_PhotoHashCache.get()` calls this run (live + store-read time combined; the live/cached split issue #206 already tracks in `photo_hash_zero_success_sources`/`PhotoFetchStats` answers a different question — *health*, not *time*).
- `pair_eval_ms` — wall-clock time inside the `evaluate_pair` calls themselves (i.e. total run time minus photo fetch time minus DB commit time).
- `db_commit_ms` — wall-clock time inside `file_suggestion`/`perform_merge`'s `conn.commit()` calls (each suggestion and each merge commits individually today — see §3's incremental-dedup section for why this per-row commit pattern is deliberate and shouldn't change).

This directly answers "what is the bottleneck after #226 deploys" with a real number instead of the estimate above, at near-zero implementation cost (wrap three existing code paths in `time.monotonic()` deltas), and it's exactly the kind of "measured, not assumed" evidence this codebase's own decision history (D-024, D-025, the #185 microbenchmark) already insists on before optimizing further. **This should land before, or alongside, deploying #226** — otherwise the very question this whole doc is trying to answer empirically ("did #226 actually fix it, and if not, what's left") goes right back to guesswork on the very next run.

---

## 2. Blocking / bucketing candidate generation

### Design (for when it's needed)

`fetch_listing_records` (`engine.py` ~L112) pulls every sale listing with its property row in one query, and `_run` (~L724) compares every pair via a plain nested loop. The intended scale-up, per the module docstring, is to generate only *plausible* candidate pairs instead of all `C(n,2)`. Concretely:

1. **Bucket key**: a coarse geography cell (round `property.lat`/`property.lon` to ~2-3 decimal places — roughly 100-1000m grid cells, well inside `address_coords._MAX_DISTANCE_METERS = 15.0`'s precision needs since two same-property listings will round to the same or an adjacent cell) **combined with** a price band (e.g. ±10-15% bucket, wide enough to survive the cross-portal staleness noise already measured and tolerated elsewhere in this codebase — `photo_hash.py`'s own measured tolerance is 0.59%-4.14% on real duplicate pairs, so a 10-15% band has comfortable margin). `property.lat`/`lon` already has an index (`idx_property_lat_lon`) though blocking would compute the cell in Python/SQL, not use that index directly for equality lookups on a rounded value — a functional index on the rounded expression would be needed if this graduates to a real SQL-side implementation.
2. **The problem this must not create**: coordinates are frequently NULL (`address_coords.py`'s own docstring: "a live sweep... found zero real listings from either site with non-null coordinates among the ones sampled" for two of the five sources). A bucket keyed purely on geography would silently exclude every listing without coordinates from ever being compared to anything — a straightforward false-negative regression the cadastral/phone/reference_code signals exist precisely to catch when coordinates aren't available. **Any blocking scheme must fall back to "no bucket = compare against everything"** for listings missing lat/lon, address, or price — i.e. blocking narrows the *common* case, it must never be the only path to a comparison.
3. **Overlap, not hard partitions**: a listing should be assigned to its own bucket *and* the neighboring buckets within one grid cell / one price-band step, to avoid the classic blocking failure mode where a real duplicate straddles a boundary (a price recorded as €299,000 on one portal and €301,000 on another, or a geocode that rounds to the cell one over). This is the standard blocking-key mitigation, kept here explicitly because this codebase's whole signal-design philosophy (D-024's discussion of `address_coords`/`phone_extract`/`reference_code`'s tolerances, the floor-veto's careful permissive-on-absence design) leans hard toward "never silently lose a real duplicate for a performance reason" — a hard-partition bucket boundary would be a first for this codebase's risk posture.
4. **Where it plugs in**: replace `_run`'s `for i in range(len(listings)): for j in range(i+1, len(listings))` with a candidate-pair generator that yields `(a, b)` pairs only within the same or adjacent bucket(s), still going through the exact same `evaluate_pair` — this is purely a candidate-generation change, not a signal-logic change, so none of the six signal modules need to change.

### Expected reduction

At n=1,400 with, say, ~30-50 geography/price buckets covering the owner's Costa del Sol + Sevilla markets, candidate pairs would drop from ~979,300 to roughly `n × avg_bucket_size` — plausibly a 10-50x reduction depending on how concentrated the corpus is geographically. But per §1, the *entire* O(n²) CPU pass is already only ~13-30 seconds post-#226 at this corpus size — a 10-50x reduction of a 20-second cost is not a perceptible win to the owner, and it's not free: it adds real code (bucket assignment, overlap handling, a fallback path for missing-coordinate listings, its own test suite for boundary correctness) and a genuine, if small, recall risk that has to be tuned and re-verified every time a signal's own tolerance changes.

### Build now, or later?

**Later — do not build now.** This confirms, rather than overturns, `engine.py`'s own docstring call and `connector-etl-ops.md` §7's "not urgent today, just a documented trigger" framing. Concretely:

- **Trigger threshold: ~15,000-20,000 listings** — the same number the docstring already computed (`~11 minutes of pure CPU at n=10,000`, extrapolating quadratically means ~25-45 min by 15-20k) and `connector-etl-ops.md` §7 already names. This doc doesn't move that number; it confirms it's still the right one given #226 removes the *other* variable that made 84 minutes look urgent.
- **What should trigger revisiting it before the threshold**: not a fixed date, but any of (a) a real total-listing-count gauge crossing ~10k (the "pipeline health" strip `connector-etl-ops.md` §4.4 already proposes is the natural home for this — same section, same gauge, reuse it rather than building a second one), (b) the connector-batch expansion in flight (#132, ~15 more REO-portal connectors, cited in `connector-etl-ops.md` §7) actually landing and materially growing the corpus, or (c) Recommendation 0's own timing split showing `pair_eval_ms` (not `photo_fetch_ms`) dominating a real run — the direct empirical signal that the CPU pass, not photo I/O, has become the bottleneck.
- **Why waiting is the right call, not just the cheap one**: building blocking now means carrying a recall-risk surface (bucket boundaries, missing-coordinate fallback correctness) for a performance problem that doesn't yet exist, on a codebase whose demonstrated engineering culture (D-024, D-025, #186's floor veto, #197's same-source exclusion) consistently favors "never silently drop a real duplicate" over marginal speed. That trade only starts paying for itself once the O(n²) pass is actually slow enough to notice.

---

## 3. Incremental dedup — compare only new/changed listings?

### What's on the table

`fetch_listing_records` re-fetches and re-compares the *entire* sale-listing table on every run — there's no notion of "only look at what changed since the last pass." An incremental design would split the corpus into:

- **Δ (new/changed since the last successful dedup run)** — candidates: `listing.first_seen_at > watermark` (newly ingested) OR `listing.last_fetched_at > watermark` (re-fetched with new data — issue #143's column, bumped only on an actual re-fetch, not just a `discover()` sighting via `last_seen_at`, which is exactly the "did this listing's data actually change" signal this needs).
- **S (everything else)** — listings untouched since the watermark.

Compare Δ×Δ and Δ×S pairs (every pair touching at least one changed listing) but **skip S×S pairs entirely** (both sides unchanged since they were last compared).

### The correctness gap this opens — and why it matters here specifically

This is not free, and this codebase has been burned by exactly this failure shape before. Today, **every pair is re-evaluated on every run**, including pairs that found *no* evidence last time (`evaluation is None`, never even filed as a `suggested_merge` row) — that's what makes a signal-logic change (a new signal, a loosened threshold, issue #186's floor veto) automatically resurface previously-missed matches on the very next run, with zero operator action. D-024 already solved this problem for the subset that *does* get persisted (`pending` suggestions) — re-evaluating every pending row every run, explicitly rejecting a "version the rules, only re-check on mismatch" scheme as not worth the complexity at 193 rows. **There is no equivalent record for S×S pairs that were compared and found nothing** — skipping them on an incremental pass means a rules change (the kind that happens routinely in this codebase — #186, #188, #197, #214 all changed what `evaluate_pair` decides) would silently stop auto-propagating to old×old pairs, the exact "day-one report stayed pending through three PRs that should have fixed it" failure class D-024 exists to prevent, just relocated from "pending rows" to "never-suggested pairs."

### Proposed shape, if/when this is built

Given that gap, incremental dedup should **not** simply replace the full scan — it should supplement it:

1. **Hourly/scheduled runs (the ones triggered automatically after every connector sweep, `orchestrator.run_dedup`) go incremental**: Δ×Δ + Δ×S only, using `dedup_runs.finished_at` (already exists, already indexed — `idx_dedup_runs_started_at`) of the last successful run as the watermark.
2. **A separate, explicit full-rescan path stays available and runs on a slower, deliberate cadence** — e.g. once daily, or as a manual `ps dedup rescore-all` an operator runs right after a signal-logic deploy (mirroring the existing `ps dedup purge-same-source` one-off-command pattern from issue #197). This is where S×S pairs actually get re-checked, at a cadence cheap enough to not matter (once a day, not once an hour) but frequent enough that a rules change doesn't sit undetected for weeks.
3. This is strictly simpler and lower-risk than blocking/bucketing: it doesn't change matching *semantics* for anything touching new data (Δ×anything is still a full, exact comparison, not a bucketed approximation) — the only thing that changes is *how often* old×old pairs get re-checked, and that's a cadence decision, not a recall-risk one.

### Build now, or later?

**Later, same trigger as blocking — but watch a second, independent trigger too.** The corpus-size argument is identical to §2's: at n=1,400, a full O(n²) CPU pass is already fast (§1's ~13-30 second estimate post-#226), so there's no wall-clock problem to solve by skipping S×S pairs yet. But there's a second, independent condition worth naming explicitly: if `connector-etl-ops.md` §5 ("quick refresh on profile change") or §3 ("ad-hoc execution") ship and start triggering dedup runs *more often than hourly* — e.g. immediately after every ad-hoc single-connector run — then even a fast full scan run frequently enough starts adding up, and incremental dedup becomes worth it for *run frequency* reasons independent of corpus size. **Concrete trigger: either total listings crosses ~15-20k (matches §2), OR dedup starts being invoked more than roughly once every 10-15 minutes on average** (at which point a fast-but-full O(n²) pass run that often is itself wasted repeated work, even if each individual pass is cheap).

---

## 4. Signal-order short-circuiting — already correct, no change needed

`evaluate_pair` (`engine.py` ~L245) already runs signals in the right order: `cadastral.evaluate` → `address_coords.evaluate` → `phone_extract.evaluate` → `reference_code.evaluate` — all four pure-CPU, no network — **before** touching `hash_cache.get()` (the one signal with real network cost), with `fuzzy.evaluate` last as the pure-CPU fallback after photo_hash. The function's own docstring is explicit about why: "Photo-hash fetching only happens once every cheaper, non-network signal has already come back empty... deliberately last even though issue #16 lists it before fuzzy (signal 4 vs 5)." This is exactly the short-circuit ordering the task asked to verify, and it's already right — most pairs that resolve via a cheap deterministic signal (or resolve to "no match" on the first four checks alone) never trigger a photo fetch at all. **No proposal here; this section exists to confirm the check, not to recommend a change.**

One second-order note, not a reordering: `hash_cache.get(a)`/`hash_cache.get(b)` inside `evaluate_pair` are each called (and each may trigger a fetch) *before* `photo_hash.match_ratio` even runs — so a pair that reaches the photo_hash stage pays for **both** sides' photo fetch even if, say, `a`'s photos alone would already be enough to know the ratio can't clear `MIN_MATCH_RATIO` (e.g. `a` has zero fetchable photos). This is a real but small optimization (skip fetching `b`'s photos if `a`'s hash list comes back empty, since `match_ratio` already returns `None` for an empty side) — not proposed as a priority here because post-#226 almost every fetch is a cache hit anyway, so the marginal fetch this would avoid is already near-free.

---

## 5. Should dedup / the review queue be scoped to active search profiles?

### The owner's question, confirmed

Verified directly in code, per the task's own framing: `fetch_listing_records` (`engine.py` ~L112) has no profile filter — it selects every `operation = 'sale'` listing regardless of whether it matches any `search_profile`. `listDedupSuggestions` (`dashboard/lib/dedup.ts` ~L115) is equally global — `FROM suggested_merge sm ... WHERE sm.status = 'pending'`, no join to `profile_listing_state` or `search_profile` anywhere. **Confirmed: both the matching engine and the review queue operate over the entire corpus, with zero profile awareness.**

### Should the *matching* stay global? Yes — this is a correctness question, and correctness wins

Dedup's job is "these two listing rows represent the same real property," which is a fact about the world, independent of which `search_profile` rows happen to exist right now. Concrete reasons to keep matching itself unscoped:

- `profile_listing_state` is *derived from* `property_id` — a merge writes into `listing.property_id`, and `reconcile.reconcile_merge` (called from `perform_merge`) is what keeps every profile's per-property state consistent across a merge, for **every** profile, not just the ones a listing happened to match at merge time. If matching were scoped to "only compare listings that currently match an active profile," a listing that later starts matching a *newly created* profile (the owner adds a new market) would carry un-deduplicated history — two `property` rows for the same real flat, one used going forward, the other silently stale — exactly the kind of state D-024's own "orphaned property rows" discussion already treats as something to avoid multiplying.
- Profiles are user-editable and archivable (`search_profile.archived_at`) — scoping the actual merge decision to "currently active profiles" would mean a merge could un-happen (or rather, retroactively look like it should never have been attempted) the moment a profile is archived, which the schema has no mechanism to reverse cleanly (merges are already hard to revert — see `engine.revert`'s own documented limitations).
- The corpus is small (~1,400 listings) and, per §1, cheap to fully scan post-#226. There is no performance argument for scoping matching itself — the entire premise of "is this worth the complexity" fails on cost alone, before even reaching the correctness argument above.

### Should the *review queue* be scoped or prioritized? Yes — this is a UX/attention question, and attention is genuinely the scarce resource here

This is a different question from the one above, and the task frames it correctly: the owner's time reviewing 200+ pending suggestions in markets they don't operate in is real, wasted cost, even though every one of those suggestions is a legitimate, correctly-computed duplicate. The fix belongs entirely on the read side (`dashboard/lib/dedup.ts` + `SuggestionQueue.tsx`), never on the write side (`engine.py`).

**One correction to `connector-etl-ops.md` §7, point 3, while proposing this**: that doc flags "worth confirming whether... suggestions are surfaced ahead of low-confidence fuzzy suggestions" as an open question. Checked directly: `listDedupSuggestions`'s query already does `ORDER BY sm.confidence DESC, sm.created_at DESC` — confidence-first ordering is **already implemented**, not a gap. The real remaining gap is the profile dimension, not the confidence dimension.

**Concrete proposal**:

1. Add a profile-relevance signal to the suggestion query: `EXISTS (SELECT 1 FROM profile_listing_state pls JOIN search_profile sp ON sp.id = pls.profile_id WHERE sp.archived_at IS NULL AND pls.matched = true AND pls.property_id IN (la.property_id, lb.property_id))` — cheap (both tables already indexed on `property_id`: `idx_profile_listing_state_property`), no schema change.
2. **Sort by it, don't hard-filter by it as the default.** `ORDER BY profile_relevant DESC, sm.confidence DESC, sm.created_at DESC` — profile-relevant pairs surface first, everything else still reachable by scrolling/paging, so a real duplicate is never *hidden*, only deprioritized. This matters because of an edge case a hard filter would get wrong: a brand-new listing that hasn't been through `materializeProfile` yet has no `profile_listing_state` row at all, `matched` or otherwise — a hard "only show profile-matched pairs" filter would silently exclude it from the queue entirely until the next materialize pass, which is a worse failure mode (a real duplicate the owner never sees at all) than the one this proposal is trying to fix (a real duplicate seen later than ideal).
3. **Add an explicit toggle** ("Ver todos" / "Solo mis perfiles") on `SuggestionQueue.tsx`, defaulting to the sorted-but-unfiltered view above, that switches to a hard `WHERE profile_relevant` filter for an owner who genuinely wants to see nothing else right now. This gives the owner the choice explicitly rather than the system making a permanent, silent judgment call about what counts as relevant.
4. `getDedupSuggestionCounts()` (`dashboard/lib/dedup.ts` ~L166) should gain a `profile_relevant_total` alongside its existing `total`/`by_basis`, so the UI can show "12 relevantes a tus perfiles, 200 en total" rather than just a single undifferentiated count.

This is small — one additional `EXISTS` clause, one `ORDER BY` change, one UI toggle, one additional count — and ships independently of everything else in this doc.

---

## Phased plan (summary)

| # | Proposal | Cites | Build now or later | Why |
|---|---|---|---|---|
| 0 | Instrument `dedup_runs` with `photo_fetch_ms`/`pair_eval_ms`/`db_commit_ms` | `engine.py` `DedupRunResult`/`_run`, `etl/schema/init.sql` `dedup_runs` | **Now** | Near-zero cost, resolves §1's estimate into a real measurement; should land at the same time as deploying #226 so the very next run confirms or corrects this doc's hypothesis. |
| 1 | Deploy #226 to the owner's instance | `photo_hash_store.py` (already merged, not yet deployed per this task's context) | **Now** (ops action, not code) | Per §1, this alone plausibly collapses the 84-minute number to low minutes/seconds on the second and later runs. Nothing else in this doc should be prioritized ahead of confirming this. |
| 2 | Profile-relevance sort + toggle on the review queue | `dashboard/lib/dedup.ts`, `dashboard/components/dedup/SuggestionQueue.tsx`, `profile_listing_state` | **Now** | Small, independent, directly answers the owner's own question (§5), no correctness trade-off (sort not filter by default). |
| 3 | Blocking/bucketing by geography + price band | `engine.py fetch_listing_records`/`_run` | **Later** — trigger ~15-20k listings, or `pair_eval_ms` from #0 empirically dominating a run | Recall-risk surface not worth carrying against a corpus this small once #226 lands; confirms rather than overturns the engine's own docstring and `connector-etl-ops.md` §7's existing call. |
| 4 | Incremental dedup (Δ×S hourly, full S×S rescan on a slower cadence) | `engine.py fetch_listing_records`, `listing.last_fetched_at`, D-024 | **Later** — same corpus-size trigger as #3, OR dedup invocation frequency exceeding ~once/10-15min (relevant if `connector-etl-ops.md` §3/§5 ship) | Opens a real, D-024-shaped correctness gap (S×S pairs stop auto-resurfacing on rule changes) that must be mitigated with a slower full-rescan path, not skipped outright — genuinely more design risk than #3, not less. |
| — | Signal short-circuit ordering | `engine.py evaluate_pair` | **No change** | Already correctly ordered — cheapest/deterministic signals before the one network-cost signal, confirmed by direct reading, not just the docstring's own claim. |

---

## Cross-references

- `etl/dedup/engine.py` — the pipeline, `DedupRunResult`, `evaluate_pair`, `_run`, `fetch_listing_records`.
- `etl/dedup/photo_hash_store.py`, `etl/dedup/signals/photo_hash.py` — #226/D-025, per-URL persistence.
- `etl/dedup/signals/{cadastral,address_coords,phone_extract,reference_code,fuzzy,floor}.py` — the six signals and their ordering.
- `etl/dedup/reconcile.py` — merge-time per-profile state reconciliation (why matching must stay global, §5).
- `docs/decisions/D-024-dedup-pending-reevaluation.md` — pending-suggestion re-evaluation; the direct precedent for §3's correctness gap.
- `docs/decisions/D-025-photo-hash-store.md` — the photo-hash persistence decision this whole doc's §1 depends on.
- `docs/roadmap/connector-etl-ops.md` (PR #235, open) §7 "Better duplicate evaluation" and §4.4 "pipeline health" strip — the sibling roadmap doc this one cross-links rather than duplicates.
- `dashboard/lib/dedup.ts`, `dashboard/components/dedup/SuggestionQueue.tsx` — the review queue, §5's proposed change.
- `etl/schema/init.sql` — `dedup_runs`, `suggested_merge`, `profile_listing_state`, `search_profile`.
