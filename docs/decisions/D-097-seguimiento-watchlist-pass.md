---
id: D-097
title: Price-drop alerts on tracked properties ride the existing hourly digest tick as an independent pass with its own watermark
date: 2026-08-07
group: Product / candidate feed
rule: Price-drop alerts on tracked (accept / "en seguimiento") properties run as an independent pass on the SAME hourly digest tick — gated by its own kill switch (`notifications.seguimiento_auto_enabled`), NOT by `digest_cadence` — with its own `digest_run.kind='seguimiento'` watermark (one table, two series), advanced every pass so a drop alerts at most once. Drops only; email reuses the digest sender (inert until SMTP).
---

# D-097: Seguimiento alerts — independent watchlist pass on the hourly tick

*Decided: 2026-08-07*

**Context** (issue #428, phase 5 of #415; closes #35 EC-3/EC-4): the owner
wanted to be told promptly when a property he is actively tracking drops in
price — "the single most actionable event in this whole app" (plan §1.2). Issue
#35 EC-3 had explicitly deferred this "pending a watchlist mechanism". Phase 4
(D-096) supplied that mechanism: the tracked set = properties whose latest
verdict is `accept`. The digest already computed generic price drops on *matched*
properties (item type b) and the scheduler already ticked hourly, so the
ingredients existed; what was missing was a *tracked-only, promptly-delivered*
alert that does not wait for the daily/weekly digest cadence.

**Decision**:

1. **Independent pass, same tick.** A second pass (`runSeguimientoPass`) runs on
   the existing hourly `setInterval` tick alongside the cadenced digest, but is
   gated **independently of `digest_cadence`** by its own kill switch
   (`notifications.seguimiento_auto_enabled`, default true). A profile with
   `digest_cadence='off'` is still watched — the owner explicitly tracked those
   properties. No new process, cron, or channel; worst-case latency ~1h, which
   is effectively instant for a purchase decision (plan D4).

2. **One watermark table, two series.** `digest_run` gains
   `kind TEXT NOT NULL DEFAULT 'digest'` (values `digest` / `seguimiento`,
   idempotent append-a-column migration). Each pass reads and advances ONLY its
   own kind's most-recent row, so the cadenced digest and the seguimiento pass
   never swallow each other's window. The seguimiento pass advances its
   watermark on **every** processed profile — including the empty case — so a
   drop already alerted can never re-alert (at-most-once). A never-run profile
   falls back to `now - notifications.seguimiento_lookback_hours` (default 24).

3. **Drops only, sanity-banded (owner decisions).** Only price DROPS alert
   (rises stay visible in the feed as a SUBIDA badge, no alert). The phase-2
   sanity band is reused verbatim (`feed.price_change_min_pct` /
   `price_change_max_pct`, 1%/60%), applied in SQL, so the in-app BAJADA badge,
   the digest section, and the alert can never disagree about which drops are
   real. Sold/withdrawn status changes on tracked properties alert too (closes
   the loop, plan §1.2).

4. **Both channels; email inert until SMTP.** The alert reuses the digest email
   sender (`sendDigestEmail`), a logged no-op until SMTP is configured — so the
   pass runs harmlessly with no SMTP, and email "just works" once the owner sets
   `notifications.smtp_*` + a recipient. The in-app half is a count endpoint
   (`GET /api/profiles/:id/seguimiento-alerts`) backing a badge next to the
   "En seguimiento" toggle; it uses a fixed recent window
   (`notifications.seguimiento_recent_days`, default 7), independent of the
   pass watermark (which zeroes right after alerting).

**Alternatives rejected**:
- *A separate watermark table anchored on `MAX(listing_price_history.observed_at)`
  already alerted per property* — more precise but needs its own table; the
  `kind` column is the cheaper first move and matches the append-a-column-to-
  `init.sql` house style (plan §3.5).
- *A true-instant trigger path* (webhook/queue on price ingestion) — a new
  moving part for no real gain; ~1h latency is immaterial here (plan D4).
- *Folding tracked drops into the generic matched-drops section (b)* — a drop on
  something the owner is tracking is categorically more actionable, so it gets
  its own top-placed section (issue #35 tech approach §1: item types stay
  visually distinguishable).

**Rationale**: reuses every existing primitive (the tick, the digest sender, the
`accept` tracked set, the phase-2 band) and adds exactly one column and one pass.
The per-kind watermark is the whole correctness argument for "alerts at most
once" without a second table or a second code path.

**See**: issue #428, #35 (EC-3/EC-4), plan #415 §3.5, D-096 (accept = seguimiento),
`dashboard/lib/notifications/{seguimiento,scheduler,digest,email}.ts`,
`dashboard/lib/db/digest.ts`, `etl/schema/init.sql` (digest_run.kind),
`dashboard/e2e/seguimiento-alerts.spec.ts`.
