# Captura — guided-capture execution UI

**Page:** `dashboard/app/captura/page.tsx` — top-level, next to Perfiles (issue #268, part of #237).
**Decision:** [D-045](../decisions/D-045-capture-execution-top-level.md) — execution is top-level, setup stays in `/etl`.

## What it is

The first-class, owner-facing EXECUTION surface for guided capture. Distinct
from the admin SETUP surfaces under `/etl/*` (extension install, API key,
connector config, the raw `/etl/captura` worklist table). The day-to-day loop:

1. Pick a search profile (`GET /api/profiles`).
2. See, per capture portal, the profile's PRE-FILTERED search URL + its worklist
   progress.
3. Click **"Abrir búsqueda"** → the portal opens already filtered in a new tab;
   the browser extension's batch capture (#262) takes over from there.
4. Watch progress (captured / pending / skipped, a bar) — "Actualizar progreso"
   re-polls the worklist.

It never captures or navigates itself (that's the extension), and never
re-implements the worklist / search-url logic (it reuses their APIs).

## Composition (reuses existing infra — do not duplicate)

| Piece | Source |
|-------|--------|
| Profile list | `GET /api/profiles` → `SearchProfileRow[]` |
| Per-portal pre-filtered URLs + loosened flags | `GET /api/profiles/[id]/search-urls` (#267, `lib/search-url/`) |
| Per-portal worklist roll-up | `GET /api/etl/worklist` (#260, `lib/worklist.ts`) |
| Join logic (pure, tested) | `dashboard/lib/captura-view.ts` — `buildPortalCaptureViews`, `captureTotals`, `capturedPct`, `portalLabel` |
| Per-portal card | `dashboard/components/captura/PortalCaptureCard.tsx` |

The worklist is GLOBAL per portal (no profile column on `capture_worklist`), so
a portal's progress is "everything captured for that portal so far", framed
against the profile whose pre-filtered search opens it. That join lives only in
`lib/captura-view.ts`.

## Loosened searches (#267 caveat)

Pre-filtered URLs are reverse-engineered and unverified. The card surfaces every
`loosened` constraint as a "búsqueda ampliada: <reason>" note (broader, never
narrower) so the owner can eyeball that the link lands filtered — failures are
shown, never hidden. Aliseda always loosens geography (no radius search).

## Auth

The whole app is admin-gated (`middleware.ts`, single-operator tool). Same-origin
browser fetches carry the `ps_admin` cookie, so `/captura` reaches the
admin-gated `/api/etl/worklist` route with no separate auth surface.

## Tests

- Unit: `lib/__tests__/captura-view.test.ts`, `components/captura/__tests__/PortalCaptureCard.test.tsx`, `app/__tests__/captura-page.test.tsx`.
- E2e (D-041): `dashboard/e2e/captura-execution.spec.ts` — seeds a profile + worklist rows, asserts cards + open-search links + progress + no error surface.
