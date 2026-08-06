---
id: D-054
title: Daily "what's new" digest is a dashboard-side scheduled email job
date: 2026-08-05
group: Product
rule: 'The daily "what''s new" digest is a dashboard-side in-process scheduled pass (`lib/notifications/scheduler.ts` from `instrumentation.ts`, mirroring D-052), emailed via SMTP/`nodemailer`. "New" reuses #195''s matched+first-seen-since-anchor definition (anchor = last `digest_run.sent_at`, else 24h). Ranks by opportunity signal (never rebuilds scoring); 3 distinct item types. No-op when SMTP unconfigured; empty digest advances the watermark but sends nothing; idempotent per-profile daily/weekly via `digest_run`. `relisted_lower`/watchlist alerts are v2 (#34).'
order: 74
---

# D-054: Daily "what's new" digest is a dashboard-side scheduled email job

*Decided: 2026-08-05*

**Context**: Issue #35 (Phase 5.5), re-scoped by the #307 strategic review into a v1/v2 split.
The persona (#307) is a busy investor who wants a daily assessment of what NEW opportunities
appeared across his profiles, so he can glance and act without trawling portals — the single most
explicitly requested capability, and the mechanism that removes daily manual dashboard-checking
entirely. The full #35 also wanted the `relisted_lower` cross-listing pattern and an instant
watchlist alert, both of which genuinely need #34 (market-signals / days-on-market), still
unimplemented. But the raw data a simpler digest needs already flows every ETL run
(`listing_price_history`, `listing_status_event`, `profile_listing_state.matched`), and the
"new since I last looked" definition already exists from #195/#192. The repo had **no** mail
infrastructure and no scheduled job beyond the hourly connector sweep.

**Decision**:
- The digest is assembled and delivered by a **dashboard-side in-process scheduled pass**
  (`dashboard/lib/notifications/scheduler.ts`), started once from `instrumentation.ts` — the
  **same** startup seam, DB-gating (`SKIP_DB_MIGRATE`), idempotency, and non-fatal handling as the
  AI-assessment scheduler (D-052). Not an ETL/Python cron: the digest reuses `lib/candidates`,
  `lib/analytics/area-price`, the AI-assessment badge vocabulary, and `nodemailer` — all
  TypeScript — so a Python trigger would only call back into the dashboard anyway (same reasoning
  as D-052, avoids churn with the connector scheduler D-046).
- **"New" reuses #195's definition, does not diverge**: matched properties (`profile_listing_state.matched = true`)
  first-seen (`property.created_at`) since an anchor. The digest's anchor is the previous
  `digest_run.sent_at`, falling back to `now() - 1 day` on the first run — the exact 24h fallback
  the novedades strip uses. Only the anchor differs (last digest vs. last visit); the predicate
  shape is identical, so digest and strip can never disagree about *what* is new.
- **Three distinct item types** (issue #35 §1): (a) new candidates ranked by opportunity signal —
  below-market discount, then distress red-flag count, then the existing trained/cold-start score
  (ranking only reorders already-computed signals; scoring is never rebuilt); (b) ordinary price
  drops; (c) sold/withdrawn status changes. AI-assessment badges (#308: occupancy/condition/redflags
  + below-market) are included when present and degrade to absent gracefully.
- **Delivery is email via SMTP** (`nodemailer`), the #1 §17 default channel. SMTP creds live in
  `config/schema.yaml` under `notifications.smtp_*` (never hardcoded). When SMTP is unconfigured
  (no host / no from), `sendDigestEmail` is a **logged no-op** returning
  `{ sent: false, reason: "smtp-not-configured" }` — never throws — so a deployment without mail
  runs the scheduler harmlessly and the watermark still advances.
- **Empty digest is never sent** (EC-2): a profile with zero qualifying activity records a
  `digest_run` row (watermark advances) but sends no content-free email.
- **Idempotent, one digest per day**: per-profile cadence (`daily`/`weekly`/`off`) on
  `search_profile.digest_cadence`; `isDigestDue` (pure) gates on the last `digest_run.sent_at` and a
  configurable send hour. The just-written watermark makes a profile no longer due, so a re-run or a
  second process cannot double-send.

**v2 (deferred, needs #34)**: the `relisted_lower` withdrawal-then-relist item type (issue #35 EC-4)
and the separate instant watchlist alert (EC-3). Slack/push channels are plausible future additions,
out of scope for v1.

**Alternatives rejected**:
- *ETL/Python cron trigger* — the whole digest pipeline is dashboard-side TypeScript; a Python
  trigger adds a cross-process hop for zero benefit (same call D-052 rejected).
- *A dashboard-rendered digest page instead of email* — the persona's explicit ask is to NOT have to
  open the app; a passive push channel is the point. The novedades strip (#195) already covers the
  in-app glance.
- *Blocking / throwing when SMTP is absent* — would break every deployment that hasn't set up mail;
  the no-op keeps the scheduler safe to ship on by default.

**Rationale**: Ships the persona's highest-value capability now without waiting on #34, reusing the
existing "new" definition, scoring, and badge vocabulary rather than inventing parallels. The
dashboard-side scheduler is the established pattern (D-052); the no-op-when-unconfigured and
empty-skip rules make it safe to enable by default.

**See**: `dashboard/lib/notifications/{digest,email,scheduler,config-read}.ts`,
`dashboard/lib/db/digest.ts`, `dashboard/instrumentation.ts`, `etl/schema/init.sql` (`digest_run`,
`search_profile.digest_cadence`/`digest_email`), `config/schema.yaml` (`notifications.*`),
issues #35 / #307 / #195, decisions D-052 / D-046 / D-012.
