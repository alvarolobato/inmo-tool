---
id: D-162
title: Per-listing timing is recorded as three separate legs; never one total
date: 2026-08-22
group: Plumbing / process
rule: "Per-listing timing is stored as separate legs (render wait / queue idle / processing; crawl fetch_ms_total excludes rate-limit sleep) — never one total. NULL means not measured, never 0."
---

# D-162: Per-listing timing is recorded as three separate legs; never one total

*Decided: 2026-08-22*

**Context**: The owner asked why Hipoges was taking so long per listing
(*"hipoges creo que estaba tardando mucho por anuncio"*), and, in the same
breath, for metrics across the pipeline if the question couldn't be answered.
It couldn't.

The only per-listing number the pipeline stored was
`extension_capture.processed_at - created_at`. Measured live on 3906 production
Idealista captures, its distribution across 1-second buckets from 0 to 10s is
**flat** — 327/387/382/416/377/398/376/399/380/370, with only 101 samples past
10s. That is the signature of waiting for a poll, not of doing work:
`run_capture_poll_loop` ticks every 10s, so a capture arriving at a random
moment waits ~U(0,10)s before anything happens to it. Its mean (5.8s) is the
poll interval's midpoint.

Hipoges' mean over the same metric was 5.3s. Idealista's was 5.8s. **The two
numbers were the same number — half of ten seconds — measured twice**, and
neither said anything whatsoever about how long a listing takes. Worse, the
column was written at four sites and read by *zero* production queries, so
nothing had ever forced the interpretation to be checked.

The crawl side had the mirror-image trap waiting: `throttle` is
`limiter.acquire` and connectors call it as `fetch_detail`'s first action, so
any naive stopwatch there would have billed Fotocasa's ~20s/listing pacing
interval as work. A mutation test confirms the magnitude — removing the
subtraction inflates a 900ms measurement to 60,299ms, 67×.

**Decision**: Per-listing timing is stored and displayed as **separate legs,
each attributed to what actually consumes it**. Never a single "time per
listing" total, and never a duration that silently contains idling.

Capture path (`extension_capture`):
- `render_wait_ms` — browser-side wait for the page to render. Portal-caused.
- queue wait — *derived*, `(processed_at - created_at) - processing_ms`. **Idle**, ~5s
  on every portal by construction. Displayed explicitly labelled as idle.
- `processing_ms` — ETL work (`normalize` + upsert). Server-caused.

Crawl path (`connector_run_results`):
- `fetch_ms_total` — `fetch_detail` + `normalize` + upsert, summed, with
  `RateLimiter.slept_seconds` **subtracted**. Paired with `fetched_count` as
  its denominator.

Binding rules:
1. Any new duration that can contain a sleep, a poll wait, or a queue wait MUST
   either exclude it at the write site or be labelled as idle at the read site.
2. NULL means "not measured" and MUST NOT be coerced to 0. A 0 asserts
   "instant", a strictly stronger and wronger claim.
3. A 0 denominator renders "—", never a division.
4. Timing is recorded on **failed** terminal paths too. A portal that is slow
   because it keeps failing must not look fast by being excluded.

**Alternatives rejected**:
- *Fix the poll interval instead of measuring it.* Dropping
  `run_capture_poll_loop` to 1s would shrink the idle leg without revealing
  that it was idle — the misreading, not the 5s, was the actual defect. Worth
  doing separately; not a substitute for attribution.
- *One end-to-end "time per listing".* Precisely the shape that was already
  wrong. A single number cannot distinguish a portal that renders slowly from a
  poll interval that is generous, and the two have opposite remedies.
- *Reuse OTel instead of DB columns.* The collector runs and the Python
  container auto-instruments, but it emits only generic psycopg2/`requests`
  spans; the dashboard sets `OTEL_*` env vars while shipping **no SDK at all**,
  so it emits nothing. Building the answer on a half-connected pipeline whose
  local sink was 3 weeks stale would have been another thing that looks
  measured. Recorded as a known gap instead.
- *Report abandoned render waits (the 20s timeout that never POSTs).* Genuinely
  the most important missing signal for Hipoges, and deliberately NOT built
  here: it needs an event channel the capture POST cannot carry, and that is
  the unified activity timeline's job (#644), not a third connector-health
  surface.

**Rationale**: The failure being corrected is not "we lacked a number" — a
number existed and was even roughly the right magnitude. The failure is that it
mixed idle with work, so it was unfalsifiable: it looked plausible for every
portal and therefore distinguished none of them. Attribution, not precision, is
what makes it answerable.

**See**: `etl/capture.py` (`_elapsed_ms`, `_process_one`),
`etl/connectors/rate_limit.py` (`slept_seconds`), `etl/orchestrator.py`
(`fetch_ms_total`), `etl/schema/init.sql`, `dashboard/lib/db/data-health.ts`,
`dashboard/app/admin/fuentes/[[...name]]/page.tsx`,
`etl/tests/test_rate_limit.py`, `etl/tests/test_orchestrator.py`
(`TestPerListingFetchTiming`), `etl/tests/test_capture.py`
(`TestCaptureTiming`), `dashboard/__tests__/extension-render-wait.test.ts`,
`dashboard/app/api/extension/__tests__/capture-route.test.ts`.
Tracked by #700. Related: D-150 (capture HTML retention), D-157
(stale verification), #644 (activity timeline), #640 (Estado tile),
#696 (dashboard OTel emits nothing).
