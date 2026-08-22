---
id: D-045
title: Guided-capture EXECUTION is a top-level page; SETUP is a separate admin surface
date: 2026-08-05
group: Data / connectors
rule: "Guided-capture EXECUTION is the top-level `/captura` page (nav, next to Perfiles); SETUP is a separate admin-gated surface (location REVISED by D-154 — `/admin/fuentes`, not `/etl/*`). It composes `/api/profiles/[id]/search-urls` + `/api/etl/worklist` via pure `lib/captura-view.ts`, never re-implements the batch loop, and surfaces loosened pre-filter flags."
order: 48
---

# D-045: Guided-capture EXECUTION is a top-level page; SETUP is a separate admin surface

*Decided: 2026-08-05*

**Partially superseded (2026-08-21) by [D-154](D-154-fuentes-merges-connector-setup.md)**:
issue #642 P1 moved SETUP from `/etl/connectors` + `/etl/captura` to
`/admin/fuentes` + `/admin/fuentes/[name]` (both old routes now 301). Only
this decision's *location* clause ("SETUP stays under `/etl/*`") is
superseded — the EXECUTION-vs-SETUP split itself, and everything else below,
still stands as written.

**Location clause fully superseded (2026-08-22) by
[D-168](D-168-admin-six-sections-etl-tree-deleted.md)**: issue #642 P2 deleted
the `/etl` tree outright. The last setup surface this decision placed there,
the extension-install page, is `/admin/extension` now (`/etl/extension` keeps a
permanent wire-level 308). There is no `/etl/*` left to stay under. The
EXECUTION (`/captura`) vs. SETUP (admin) split is still exactly as decided
here; only every path in the text below is historical.

**Context**: Issue #268 (capstone of #237). The guided-capture pieces landed
under `/etl/*` as they were built: the worklist table page (`/etl/captura`,
#260/#261), the extension-setup page (`/etl/extension`, #256), and connector
config (`/etl/connectors`). `/etl/*` is admin chrome (`AdminChrome`) intended
for infrastructure/setup. But the day-to-day capture LOOP — pick a profile, open
its pre-filtered searches, watch what's been captured — is a normal-user task
the owner does repeatedly, and burying it in admin made it feel like plumbing.
The owner's 2026-08-05 decision: capture execution must be "a first-class,
polished interface at the top level next to Profiles", with `/etl/*` kept for
setup only.

**Decision**:
1. **A top-level `/captura` page** (`dashboard/app/captura/page.tsx`), added to
   the primary nav (`TopBar.tsx`) immediately after **Perfiles**. It is the
   EXECUTION surface: pick a profile → per-portal pre-filtered search URL +
   worklist progress → **"Abrir búsqueda"** (opens the portal filtered; the
   extension's batch capture, D-043, takes over) → live captured/pending/skipped
   progress. Polished: redesign tokens, real loading/empty/error states, not the
   raw admin table.
2. **SETUP stays under `/etl/*`** (admin-gated `AdminChrome`): extension install
   + API key (`/etl/extension`), connector config (`/etl/connectors`), and the
   raw worklist table + manual URL paste + sitemap seed (`/etl/captura`).
   `/captura` cross-links to these for first-time setup; it does NOT duplicate
   their write actions.
3. **It composes, never re-implements.** `/captura` reuses
   `GET /api/profiles/[id]/search-urls` (#267) and `GET /api/etl/worklist`
   (#260). The only new logic is the pure join in `dashboard/lib/captura-view.ts`
   (`buildPortalCaptureViews` / `captureTotals`). The batch-capture loop is the
   extension's job (D-043) and is not reimplemented here.
4. **Loosened pre-filter constraints are surfaced, never hidden** (#267 caveat):
   the per-portal card shows each `loosened` flag as "búsqueda ampliada:
   <reason>" so the owner can eyeball that the (reverse-engineered, unverified)
   URL lands filtered.

**Alternatives rejected**:
- *Promote `/etl/captura` itself to top-level.* It is the admin worklist table
  (manual paste, sitemap seed, per-row skip/reset) — setup/maintenance
  affordances, not the polished execution flow. Kept as the admin surface;
  `/captura` is a new, purpose-built page.
- *A profile-scoped worklist.* `capture_worklist` has no profile column; the
  worklist is global per portal. Rather than a schema change, `/captura` frames
  the global per-portal progress against the profile whose search opens it, and
  documents that framing (`lib/captura-view.ts` header).

**Rationale**: Separating EXECUTION (frequent, user-facing, top-level) from
SETUP (occasional, admin) matches how the owner actually works and keeps admin
chrome uncluttered, without any auth change — the whole app is already
single-operator admin-gated (`middleware.ts`), so same-origin fetches from
`/captura` reach the admin-gated `/api/etl/*` route via the `ps_admin` cookie.

**See**: issue #268, #237 (master plan Phase 4); `dashboard/app/captura/page.tsx`,
`dashboard/components/captura/PortalCaptureCard.tsx`,
`dashboard/lib/captura-view.ts`, `dashboard/components/TopBar.tsx`;
`docs/skills/captura-execution.md`; D-037 (guided capture), D-043 (batch
capture), #267 (pre-filtered search URLs), #260/#261 (worklist).
