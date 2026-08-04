---
id: D-028
title: "Milanuncios keeps detail-fetching; skip-if-seen is what unblocks its coverage"
date: 2026-08-04
---

# D-028: Milanuncios keeps detail-fetching; skip-if-seen is what unblocks its coverage

*Decided: 2026-08-04*


**Context**: Issue #179 (Milanuncios rate_limit_per_minute soft-blocks and
trips the circuit breaker every run) has been open since 2026-08-03. D-017
measured the soft block empirically and shipped `rate_limit_per_minute = 2`,
but left open "whether any rate makes Milanuncios viable for detail fetching
at all" — the owner's own comment on #179 already flagged discovery-only as
the likely landing spot if the block turned out to be a hard per-session cap.
This investigation re-measured live (read-only, minimally) and mined the
`inmo-tool-main-demo` Postgres instance's real `connector_run_results`
history (2026-08-02 16:47 through 2026-08-04, ~38h, hourly-ish cadence) to
answer three open questions with production evidence rather than a single
spot-check.

### (1) Is "blocks after ~5 detail fetches" true?

**Yes, and far more solidly than a single measurement — it reproduced on 16
of 18 real `circuit_open` production runs** over ~38h
(`discovered=41 fetched=5 errors=5`, byte-identical every time). The other 2
of those 18 showed a harder block that run (`fetched=0 errors=10` — zero
detail successes). `rate_limit_per_minute=2` (30s spacing, per D-017) made no
difference to the ceiling, consistent with D-017's own 3s-vs-10s finding:
this is a request-count wall, not a pace wall.

**New finding beyond D-017**: twice in the same window (2026-08-03 19:24 and
again 2026-08-04 06:13, the latter still open as of this writeup),
`discover()` itself started returning the same soft-block signature — not
just `fetch_detail()`. D-017 explicitly measured `discover()` staying "fully
open the entire time `fetch_detail()` was blocked"; that is no longer
reliably true. A single live, read-only `discover()` probe from this session
(2026-08-04 08:39:57 UTC, same residential IP D-017 used — `81.38.223.92`,
Telefónica) reproduced this: immediate `MilanunciosSoftBlockError`, no
listings returned. Per the task's explicit instruction, no further live
requests were made once this was confirmed.

### (2) Does the block reset over time? Per-IP, per-session, per-cookie?

**Per-IP (or something correlated with it), and it does reset — but on two
different timescales depending on which block state was hit:**

- The **normal 5-per-run cap** resets by the next scheduled run in the
  overwhelming majority of cases (16/18 `circuit_open` runs hit exactly
  `fetched=5` again, not a declining number) — i.e. it is *not* a
  multi-hour lingering ban for the common case. D-017's "did not clear
  after 60+ minutes" finding was real but was measured under continuous
  polling within one investigative session, which D-017 itself flagged as
  plausibly self-resetting a decay timer — the production data (runs that
  simply wait for the next scheduled slot rather than polling) doesn't show
  that persistence for the common 5-cap state.
- The **deeper block** (engulfing `discover()` too) is rarer but real, and
  recovers more slowly: the 2026-08-03 19:24 episode cleared by 23:45 the
  same day (~4h21m). The current episode (started 06:13 today) had not
  cleared as of the 08:39:57 check (~2h26m elapsed) — consistent with, not
  contradicting, the prior ~4h21m recovery window, but not independently
  confirmed clear. No further polling was done to avoid repeating D-017's
  own methodological caution.
- No `Set-Cookie` header on the block page (reconfirmed by D-017, not
  re-tested this session) — there is no session/cookie escape hatch; this
  reads as IP-correlated, server-side.

### (3) Does skip-if-seen (the Fotocasa #175 trick) rescue it?

**Partially, and for a different mechanism than it fixed for Fotocasa** —
worth doing regardless of what else is decided.

Fotocasa's problem was throughput: 3 req/min sustained over ~1,500 known ids
took 8h, so skip-if-seen freed budget by not re-confirming unchanged
listings. Milanuncios' problem is different: `min_refetch_interval_seconds`
is **currently 0 (off)** for Milanuncios — a deliberate choice documented in
`milanuncios.py`, made because `discovered_prices()` was investigated and
could not be verified (a live re-check hit a bot-block page), and shipping
a guessed price-agreement signal was judged worse than no signal (D-008).
That decision was about the price-disagreement safety net specifically, not
about skip-if-seen as a whole — the two are separable.

With skip-if-seen off, `run_connector`'s fetch loop
(`etl/orchestrator.py`) iterates `discover()`'s **sorted** external_id list
in the same order every run, with no freshness lookup, so every run's
~5-success budget is spent on whichever ids sort first — largely the *same*
ids every time. Production evidence: across the 18 `circuit_open` runs (up
to 5 successes × 18 ≈ 90 attempts possible), only **24 distinct
external_ids** ever accumulated `last_fetched_at` — most of that budget was
spent re-confirming already-known listings, not advancing through the ~41
ids `discover()` returns each run.

Turning `min_refetch_interval_seconds` on (e.g. 24h, matching Fotocasa's own
reasoning: "bounds the worst case for a listing whose price hasn't moved,
not the actual price-change detection latency for the common case") would
very plausibly redirect the same 5-per-run budget toward not-yet-fetched
ids instead of repeats — the front-advancing effect the task hypothesized,
just triggered by "stop wasting budget on repeats" rather than "the block
itself decays with patience." This does **not** fix the ~10-20% of runs
where the wall goes deeper than the normal 5-cap (see (1)); those still fail
regardless of skip-if-seen.

### (4) Volume and overlap (from `inmo-tool-main-demo` Postgres, 2026-08-04)

| source | listings | has `last_fetched_at` |
|---|---|---|
| fotocasa | 748 | 748 (100%) |
| milanuncios | 63 | 24 (38%) |
| servihabitat | 114 | 114 (100%) |
| solvia | 81 | 78 (96%) |
| vivantial | 43 | 43 (100%) |

Milanuncios is the only source with a large gap between "we have a listing
row" and "we ever successfully detail-fetched it" — consistent with (1)/(3)
above. (Caveat: some of the 63 rows may predate this instance's own
connector-run history, e.g. price/description present without
`last_fetched_at` set on 39 rows — flagged as a data-provenance gap, not
fully resolved here.)

**Overlap**: 63 Milanuncios listings map to 60 distinct properties after
dedup. Of those 60: **10 (17%) are also seen by another working
connector** (9 with fotocasa, 1 with solvia); **50 (83%) exist, in this
dataset, on no other source at all.** Small-sample and geography-limited
(Milanuncios' `_CITY_SLUGS` covers only madrid/sevilla/barcelona/valencia/
malaga; the live run history this window is scoped mostly to Sevilla), but
directionally: what little this connector does surface is disproportionately
*not* duplicated by the rest of the fleet, not redundant with it.

## Decision (proposed)

**(c) — not (a), not (b).** Keep `MilanunciosConnector` as a real
detail-fetching connector, not a discovery-only one, and not dropped:

1. **Enable skip-if-seen** (`min_refetch_interval_seconds`, e.g. 24h) for
   `MilanunciosConnector`, accepting the known gap (no `discovered_prices()`
   safety net — price changes within the window lag, same worst-case
   Fotocasa already accepts). This converts measured repeat-waste into real
   incremental coverage without touching the rate limit D-017 already
   proved doesn't matter.
2. **Do not raise `rate_limit_per_minute`.** D-017's finding is
   re-confirmed, not weakened, by this session's data.
3. **Set expectations at "modest, not zero":** roughly up to 5 genuinely new
   detail-fetches per run in the common case (~80% of attempted runs, per
   this window), zero on the ~10-20% of runs where the wall goes deeper —
   already handled by the existing `ConnectorError`/circuit-breaker path,
   which fails loudly rather than silently, and needs no change for this.
4. **Don't build a discovery-only mode.** `discover()` currently extracts
   only `id` from the search-result payload; enhancing it to also capture
   `category`/`sellerType`/`origin` (confirmed present in the JSON, cheap
   since the request is already made) would be a reasonable **secondary**,
   low-cost improvement — `origin.provider="fotocasa_pro"` in particular is
   a free cross-source dedup signal — but none of that payload includes
   price, description, photos, or room/m2 stats, so it would not be "enough
   to be useful for candidate cards," only a weak dedup/existence signal.
   Also: `discover()` itself is not 100% reliable either (2 of ~20 attempted
   runs this window), so "discovery-only" isn't the risk-free fallback the
   original hypothesis assumed.
5. **Re-open the discover()-level block as its own tracked finding** — it's
   new evidence beyond D-017/#179's original scope and matters for #211
   (rental data source) too, since `MilanunciosRentalConnector` shares the
   same IP/domain budget.

**The cost, stated explicitly**: `_should_skip_fetch`'s rule 5 — a
discovery-time price that disagrees with the stored one forces an immediate
re-fetch, regardless of staleness — is the safety net that makes skip-if-seen
safe on Fotocasa. It **cannot fire here**, because it needs a non-empty
`discovered_prices()` and Milanuncios' `ad` entries carry no price field
(every live re-check of the real shape has been bot-blocked). So a price
change on an already-fetched Milanuncios listing can go unnoticed for up to
24h, where the same change on Fotocasa is caught on the next sweep. This is
accepted, not overlooked: today most discovered listings are never fetched at
all, so their price is not stale but absent, and "≤24h stale for the few we
reach" beats "never fetched for most". `test_has_no_discovery_price_escape_
hatch` asserts the gap so it cannot be quietly forgotten — if it ever starts
failing because a real discovery price landed, this trade-off is void and the
asymmetry with Fotocasa disappears.

**Alternatives rejected**:
- **(a) Discovery-only.** Rejected as the primary shape: the fields
  `discover()` can cheaply provide don't clear the bar for candidate cards,
  and detail-fetching demonstrably *does* work (5 successes, 80% of runs) —
  discarding that entirely throws away real, working capability to dodge a
  problem (repeat-waste) that has a smaller, targeted fix.
- **(b) Drop entirely.** Rejected: 83% of Milanuncios' dedup-linked
  properties are not found by any other connector in this dataset. Small
  absolute numbers (50 properties), but a real, non-redundant contribution
  for a connector that costs one collapsed circuit-breaker run per hour and
  nothing else.

**Rationale**: The task's working hypothesis (discovery reliable, detail
never works, so go discovery-only) does not survive contact with 38h of
real production run history — detail fetching **does** work, reliably, up to
a hard per-run ceiling; the actual defect is that the current code wastes
most of that ceiling on repeats. That is a smaller, more precise, more
reversible fix than restructuring the connector's shape.

**See**: issue #179, issue #211 (rental — shares this connector's
`fetch_detail()` wall), [D-008](D-008-skip-if-seen-opt-in.md) (skip-if-seen
policy), [D-017](D-017-milanuncios-rate-measurement.md) (the rate
measurement this builds on), `etl/connectors/milanuncios.py`,
`etl/orchestrator.py` (`run_connector`, `_should_skip_fetch`), the
`inmo-tool-main-demo` Postgres instance's `connector_run_results` table
(live evidence source for this file).
