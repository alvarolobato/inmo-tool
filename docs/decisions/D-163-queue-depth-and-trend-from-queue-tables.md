---
id: D-163
title: Queue depth and trend come from the queue table's own timestamps; an unmeasured leg renders as "sin medir", never 0
date: 2026-08-22
group: Plumbing / process
rule: "Queue depth AND trend come from the queue table's own entry/exit timestamps, never a snapshot table. An unmeasured leg renders its reason, never 0. Estado links out, never copies."
---

# D-163: Queue depth and trend come from the queue table's own timestamps; an unmeasured leg renders as "sin medir", never 0

*Decided: 2026-08-22*

**Context**: The owner asked for queues in his own words on the #636 brief
(*"Quiero saber también colas, etc."*) and then, repeatedly over the following
three days: *what is queued right now and is it growing? how much came in over
the last N hours? is anything stalled?* No surface showed queue depth anywhere,
let alone direction. Measured on production 2026-08-22: `capture_worklist`
1.476 pending, `suggested_merge` 287 pending with 46 in / 43 out per day,
~1.157 profile-matched properties awaiting an AI verdict against ~1.076
assessed per day, and — invisible on every surface — #614's dedup stall (12
orphan-guard kills in 7 days).

Two failure modes had to be designed against, both of which this repo hit in
the same week:

1. **A depth without a direction is not an answer.** A queue at 1.476 that is
   draining is healthy; one at 200 that is growing is not. The naive fix is a
   snapshot/metrics table sampling depth on a timer — a new ledger, a new
   writer, and a new thing to be stale.
2. **A number that looks measured and isn't.** `processed_at - created_at` was
   ~96% poll wait ([D-162](D-162-per-listing-timing-three-legs.md)), and a
   "for months" claim was made about a 20-day-old table. Rendering an
   unmeasured quantity as `0` is the same class of error, dressed as data.

**Decision**:

- **Trend comes from the queue's own table, never a snapshot store.** Every
  queue surfaced here already carries an entry AND an exit timestamp —
  `suggested_merge.created_at`/`resolved_at`,
  `capture_worklist.created_at`+`requeued_at`/`updated_at`,
  `extension_capture.created_at`/`processed_at`,
  `etl_manual_trigger.requested_at`/`picked_up_at`. Inflow and outflow over a
  fixed 24h window are therefore `COUNT(*) FILTER (...)` on that same table,
  and direction is the sign of `inflow − outflow` — which is the identity
  `depth_now = depth_24h_ago + inflow − outflow` read backwards. No new table,
  no new writer, no new instrumentation. A queue that acquires a new exit path
  (a requeue, D-156) updates one `FILTER`, not a pipeline.
- **`null` means not measured, and the surface says so.** `depth`, `inflow24h`
  and `outflow24h` are each `number | null`. `deriveTrend` degrades rather than
  guesses: an unmeasured inflow yields `working` ("draining, direction
  unknown"), never `draining`; an unmeasured depth or outflow yields `unknown`.
  The UI renders the reason ("sweep en curso", "sin ejecuciones") in place of
  the number and hides the trend chip entirely — there is no code path that
  prints `0` for an absence. Two queues need this today: the AI-assessment
  backlog (nothing stamps "this property became profile-matched", so arrivals
  are unmeasurable) and the stale-profile count (not evaluable mid-sweep,
  #285).
- **`stalled` outranks `growing`.** With work waiting and zero outflow over the
  window, "nothing is being processed" is both true and the more actionable of
  the two claims.
- **Estado shows one global depth per queue and links out.** The per-source
  breakdown lives on `/admin/fuentes` (which since PR #676 carries a
  queue-depth chip per source), the merge pairs on `/admin/dedup`, the
  assessment coverage panel on `/admin/llm`. No tile re-renders any of them —
  the owner's standing #636 complaint is *"solo has añadido, no has eliminado
  nada… quiero que unifiques"*, and a third place to read connector health
  would repeat it. The one pointer allowed is naming the dominant portal so
  the tile can link straight into it.
- **Owner-paced queues never read red.** The capture worklist and the dedup
  review backlog are drained by hand, so depth and age alone cap at amber —
  the same rule #638's addendum already applies to capture sources ("a bursty,
  operator-paced source must never read as failure from elapsed time alone").
  Red is reserved for a consumer that is *supposed* to be automatic and isn't:
  a dedup pass with no success in 12h, or a poll-drained queue with a row
  older than 15 minutes.
- **A backlog definition must reuse the producer's own predicate.** The
  assessment tile composes `assessmentEligibleClause`/`pendingClause` from
  `lib/ai-assessment/eligibility.ts` — the scheduler's own fragments — rather
  than re-deriving eligibility, which is exactly the drift #330 fixed. The
  stale-profile count imports the SQL from `lib/db/data-health.ts` for the same
  reason.

**Alternatives rejected**:

- *A `queue_depth_history` snapshot table sampled on a timer.* The one new
  ledger #636 sanctions is `freshness_cycle_history` (#647). Depth history is
  already implicit in timestamps that exist; adding a writer would introduce a
  sampling interval, a retention policy, and a gap whenever the sampler is
  down — for a number derivable exactly.
- *Reporting `depth_24h_ago` directly as a second number.* It is a derived
  restatement of `inflow − outflow` and costs a line on a phone tile for no
  extra information.
- *Rendering an unmeasured inflow as `0` and calling the AI backlog
  "draining".* It would have been true by accident today (throughput exceeds
  arrivals) and a lie the first time a prompt-version bump dumped the corpus
  back into the backlog.
- *Per-portal capture rows on Estado* (the shape #640's own scope line
  suggested, written before #676 landed). That is the Fuentes list, rebuilt in
  a second place.

**Rationale**: The cheapest honest trend is the one the data already supports.
Everything here is a `COUNT(*) FILTER` over a table that was going to be
written anyway, and every quantity the schema cannot support is rendered as an
absence rather than a zero — so the band can be read at face value, which is
the only property that makes a glance surface worth having.

**See**: issue #640 (part of #636); `dashboard/lib/queues.ts` (the pure model
and `deriveTrend`), `dashboard/lib/db/queues.ts` (the SQL),
`dashboard/app/api/etl/queues/route.ts`,
`dashboard/components/estado/QueueBand.tsx`;
[D-162](D-162-per-listing-timing-three-legs.md) (the "NULL means not measured"
sibling, on the timing side), [D-156](D-156-recapture-requeues-worklist-rows.md)
(`requeued_at`, why a requeue counts as an arrival),
[D-036](D-036-dedup-run-reconciliation.md) (the orphan
reconciliation whose `error_msg` prefix the dedup-pass tile matches),
[D-104](D-104-assessment-failure-ledger.md) (parked flows — the case a stalled
assessment backlog surfaces), [D-069](D-069-etl-run-hygiene.md)
(why a never-run dedup pass is neutral, not red).
