---
id: D-157
title: A listing's status changes only on evidence of absence — elapsed time may only nominate
date: 2026-08-22
group: Data / connectors
rule: "Time only nominates; only source evidence (HTTP 404/410 or identified retired page) may change a listing status. Soft block or unparseable 200 changes nothing. Mark, don't delete."
---

# D-157: A listing's status changes only on evidence of absence — elapsed time may only nominate

*Decided: 2026-08-22*

**Context**: Withdrawal detection only works for connectors that sweep their
whole inventory (`_reconcile_missed_discoveries`, gated on
`discovers_full_inventory`). Measured against production on 2026-08-22, of
13.102 active listings that mechanism had ever withdrawn anything for exactly
five sources — vivantial 57, diglo 8, cimenta2 6, buildingcenter 3, unicaja 2
— and for the two biggest ones it is structurally unreachable:

| source | active | ever withdrawn | why absence proves nothing |
|--------|-------:|---------------:|----------------------------|
| fotocasa | 4.346 | **0** | page-1-only coverage; a listing can leave page 1 and still be live |
| idealista | 3.289 | **0** | capture-only, no `discover()` sweep exists at all |

Meanwhile **2.194 active listings had gone unseen for more than 7 days**
(idealista 862, fotocasa 687, pisos 139, solvia 116, fotocasa_rental 97,
aliseda 95, milanuncios 86, servihabitat 63). The obvious fix — expire what is
old — is the one the owner explicitly ruled out when issue #643 was rewritten:

> "El problema de idealista es que no se ha ejecutado completo en una semana o
> así, y esto se debe tener en cuenta para no eliminar anuncios
> incorrectamente."

He is right, and the capture data shows exactly why: capture activity is
bursty (2.175 capturas on 08-18, 919 on 08-07, near zero on most other days),
so "unseen for 7 days" overwhelmingly measures **our own scheduling**, not the
portal's inventory. A time-triggered expiry would report the operator's
calendar as market activity. The same argument applies in weaker form to
page-1-only crawlers: a listing that left page 1 is *unobserved*, not absent.

**Decision**: Binding for the whole withdrawal family (this issue, #641, #645
and anything after them).

1. **Elapsed time may only nominate.** A staleness threshold is allowed to
   choose which listings get looked at next, and nothing else. No mechanism
   anywhere in `etl/` may derive a `listing.status` from a clock. The
   mechanism must always be able to answer "what evidence do I have that this
   listing is absent, as opposed to unobserved?" — and when the answer is
   "none", it must change nothing.
2. **Only these count as evidence of absence**: an HTTP status in
   `LISTING_GONE_HTTP_STATUSES` (404/410 — D-049), or a per-connector
   `retired_page_signature` matching a marker the *site itself* publishes on
   its retired-listing page. Nothing else.
3. **Absence of evidence is never evidence of absence.** A soft block
   (D-047), a timeout, a 5xx, an empty or unparseable HTTP 200, a redirect to
   somewhere unrecognised — all leave the listing exactly as it was. There is
   no "N answerless attempts add up to gone" accumulator: repeating an
   observation that proves nothing does not amount to proof.
4. **Mark, never delete.** A verified-absent listing becomes `withdrawn` with
   a `listing_status_event` citing its evidence in the new `evidence` column.
   Deleting the row would take `listing_price_history` (D-098), the feedback
   history and the dedup identity with it, and a re-listed property would come
   back looking like a brand-new find.
5. **Staleness with no evidence stays a display band** (D-039
   fresh/aging/stale) and never a status change.
6. **Verification traffic is the lowest-priority consumer** of a connector's
   budget: it runs last, through the connector's own rate limiter and circuit
   breaker, on whatever the real discovery/fetch work left behind — the same
   posture `_record_discovery_price_observations` has (D-070). A tripped
   breaker means the pass does not run. The global budget
   (`etl.stale_verification_budget_per_run`) is a ceiling a connector may
   lower for itself via a `stale_verification_budget_per_run` class
   attribute, never raise — milanuncios sets 2 and its rental subclass 1,
   because D-017/#179 measured that portal serving ~5 detail fetches before a
   60+ minute soft block, and a lockout that long outlives the run and
   poisons the next hour's `discover()`.
7. **A per-connector opt-in gates it** (`supports_stale_verification`, default
   `False`), because this is the only mechanism allowed to withdraw a listing
   on a *single* observation. Capture-only portals
   (idealista/aliseda/altamira/hipoges) are excluded outright — background
   fetching them is what D-081/D-026/D-027 exist to prevent — and so is any
   connector whose `fetch_detail()` depends on a `discover()` stash, which
   during verification would report every listing as gone (see
   `FotocasaRentalConnector`, which opts out explicitly against its parent).
8. **A mass-withdrawal guard applies anyway.** Withdrawals are buffered and
   applied only once every verdict is in, and only if all three of these
   clear (`_mass_withdrawal_alarm` in `etl/orchestrator.py`):

   a. **fewer than three withdrawals** in the run — below that nothing else
      is consulted, because one or two withdrawals are not a mass withdrawal
      at any sample size and a ratio over two verdicts is noise. The floor is
      on the *withdrawals*, never on the verdict count: putting it on the
      denominator switches the guard off for small samples, which is exactly
      when the detail path has broken and the breaker has cut the pass short
      (PR #685 review, M1);
   b. **strictly fewer than `_VERIFICATION_GONE_ALARM_RATIO` (80%)** of the
      run's verdicts came back gone. At *exactly* 80% the guard fires — "all
      ten 404" is the signature of our own URL construction breaking, and so
      is eight of ten;
   c. **no more than `_VERIFICATION_GONE_BASELINE_MARGIN` (50 percentage
      points) above the source's own historical gone rate**, taken from
      `connector_run_results.verified_gone_count`/`verified_count` over its
      last 50 runs, and only once it has accumulated 20 verdicts. A stateless
      single-run ratio cannot distinguish a 60% systemic break from 60%
      genuine churn — that is undecidable inside one run — but *a source that
      has withdrawn 0 in its entire history suddenly withdrawing 8* is
      decidable, and is precisely the signal a ratio cannot see.

   When the guard fires, nothing is withdrawn, the listings stay `active` to
   be re-nominated later, and the run records which check tripped in
   `connector_run_results.verification_alarm` (NULL whenever it stayed quiet).
   That column is not redundant with the counters: every other signal on that
   row reports an action taken, and a guarded run stores `verified_count=10,
   verified_gone_count=0` — byte-identical to a run where all ten listings
   genuinely came back alive. A suppressed action must be visible.

   Note the ratchet in (c): a blocked run records
   `verified_gone_count = 0` and so lowers the baseline, meaning a source
   whose every run trips it stays blocked until an operator looks. That is
   intended — the cost is asymmetric: a missed withdrawal is invisible, a
   false one silently removes a live candidate from every profile feed — and
   it self-heals for ordinary churn, where sub-threshold runs do apply and
   raise the baseline as they go.

**Alternatives rejected**:

- *A time-window `expired` status* (the original #643 design, a 45-day
  window). Retired before implementation — it is still a time-triggered status
  change, and on an operator-paced ingest it measures the wrong thing. The
  unused `expired` status is left unwritten rather than given a heuristic
  meaning.
- *Trusting a single 404 inside the ordinary fetch loop.* Deliberately still
  not done (see the `ListingUnavailableError` handler in `run_connector`): a
  404 met in passing during a sweep is churn between discovery and fetch, and
  a broken detail path would mass-withdraw. What makes it evidence in the
  verification pass is that we asked about *that* listing specifically, after
  it had already gone unobserved for a week, with the guard above on top.
- *Treating "the page didn't parse" as removal.* This is precisely the
  soft-block signature. Live proof, 2026-08-22: of two of production's
  oldest-`last_seen_at` milanuncios ads, one served the real page and the
  other served the "Pardon Our Interruption" GeeTest wall with HTTP 200.
- *Deleting withdrawn rows* — see point 4.

**Rationale**: The distinction the owner drew is the whole design. Our ingest
is partial and operator-paced by construction, so any signal derived from
*our* observation cadence describes us, not the market. Re-reading a listing's
own detail page is cheap (one request, inside the existing rate limit) and is
the only signal that comes from the portal. It also self-heals: most verified
listings come back alive and have their presence clocks — and, where the
connector re-ran its own detail path, their data — refreshed, which shrinks
the stale backlog without withdrawing anything at all.

**See**: issues #643 / #636 (sequence position 6), #641 (full-inventory cycle
close), #645 (captured portals), #639 (capture counts as "visto"); D-049
(HTTP-gone semantics), D-047 (soft block is never gone), D-070 (leftover-budget
posture), D-099 (accepted properties exempt), D-098 (price history), D-039
(staleness as a display band), D-030 (queue rotation as anti-starvation);
`etl/orchestrator.py` (`verify_stale_listings`, `_nominate_stale_listings`),
`etl/connectors/base.py` (`VerificationOutcome`, `retired_page_signature`,
`verify_listing`, `stale_verification_budget_per_run`),
`etl/tests/test_stale_verification.py`.
