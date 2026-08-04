---
id: D-039
title: Listing staleness surfacing — last_seen_at, day-grained bands
date: 2026-08-04
---

# D-039: Listing staleness surfacing — `last_seen_at`, day-grained bands

*Decided: 2026-08-04*

**Context**: `docs/roadmap/connector-etl-ops.md` §6 (the roadmap's sharpest
finding) — withdrawal detection is dormant for 7 of 9 connectors
(`discovers_full_inventory = False`) and, per D-030's scope rotation, forced
off for the other two on most runs. So a sold/removed listing may never leave
`status = 'active'`, and the owner can't tell a freshly-confirmed candidate
from one last seen weeks ago (possibly already gone). `listing.last_seen_at`
records exactly this but nothing surfaced it (issue #243). This is the cheap,
no-new-ETL interim signal §6.1 calls for.

**Decision**:
1. **Timestamp**: surface `listing.last_seen_at` ("last time a `discover()`
   sweep re-confirmed the listing exists"), NOT `last_fetched_at`.
   `last_fetched_at` is gated by the skip-if-seen fetch budget (issue #143 /
   D-028): a live, freshly re-confirmed listing is deliberately not re-fetched
   for up to a connector's skip window, so it would read "stale" for listings
   the pipeline is actively confirming. `last_seen_at` is the confirmation
   signal; `last_fetched_at` is a scraping-budget signal.
2. **Bands** (whole days since `last_seen_at`): `fresh` ≤ 7, `aging` 8–21,
   `stale` > 21. Day-grained, not the "2× the connector's scheduled interval"
   (≈ 2h) the roadmap floated as an illustration: the orchestrator sweeps
   hourly, but partial-inventory connectors (7 of 9) only re-see a listing
   when it resurfaces in a page/sitemap slice, so a genuinely-live listing can
   go days between confirmations with nothing wrong. The bands absorb that
   normal partial-coverage jitter and escalate only once a gap is worth a
   human's attention.
3. **Deduped properties** reflect the **freshest** (MAX) `last_seen_at` across
   their **active** listings — "if any linked listing was seen recently, the
   property isn't stale." Active-only, matching how `lib/candidates.ts` already
   derives `min_price` / source badges / the photo union: a withdrawn/sold
   sibling's frozen timestamp must neither rescue a stale property nor be
   treated as a live re-confirmation.
4. **Honesty**: the label is a fact ("visto hace N días"), never an inference
   ("vendido"). Unknown `last_seen_at` renders nothing (not "visto hoy") —
   unknown is not fresh. A partial-inventory connector that never re-confirms
   a listing will make it look increasingly stale; that is correct and is the
   point (§6.4: claim less confidence over time, never more). Distinct from a
   `discovers_full_inventory = True` connector's `status = 'withdrawn'`, a
   *confirmed* absence shown elsewhere (linked-listing status / status-event
   timeline).

**Alternatives rejected**:
- *`last_fetched_at`* — see (1); would false-positive stale on actively
  confirmed listings under skip-if-seen.
- *2×-interval (hours) threshold* — technically what §6.1 sketched, but for
  partial-inventory connectors it would paint almost everything "stale" within
  a day, destroying the signal's value. Rejected in favour of day bands.
- *Inferring "sold"/"probably withdrawn"* — that's the over-claiming §6/D-030
  spend their whole design avoiding. We state the fact only.
- *Writing a `listing_status_event` `'not_reconfirmed'` row* (§6.2) — a
  separate, additive follow-up; this decision is UI-only, no schema change.

**Rationale**: Cheapest honest closure of the roadmap's highest-risk gap —
existing column, no ETL change, no `listing.status` mutation. Bands chosen to
match how the connector fleet actually re-confirms listings so the signal
escalates on real staleness, not on normal partial-coverage jitter.

**See**: issue #243; `docs/roadmap/connector-etl-ops.md` §6;
`dashboard/lib/staleness.ts` (single source of the bands + freshest-of-linked
rule); `dashboard/components/StalenessBadge.tsx`; `dashboard/lib/candidates.ts`
(freshest-active `last_seen_at` in the candidate query);
`dashboard/components/property/PropertyHeader.tsx`; D-028 (skip-if-seen),
D-030 (scope rotation / withdrawal forced off), `etl/schema/init.sql`
(`last_seen_at` vs `last_fetched_at` column comments).
