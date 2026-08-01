# Add /api/health endpoint with EC

## Context
- **Problem**: No endpoint to check ETL sync freshness

## Phase 1 — Health endpoint

### Tasks

- [ ] 1) Create the route
- [ ] 2) Add the test
- [ ] 3) Copilot review
- [ ] 4) Opus review

## Exit criteria / Validation

- [ ] **EC-1**: `GET /api/health` returns 200 with `status` key — *Verified by*: `dashboard/app/api/health/route.test.ts` → `"returns status"`.
- [ ] **EC-2**: When `last_sync > 48h`, response is `{ status: "stale" }` — *Verified by*: same test file → `"stale when old"`.
- [ ] **EC-3**: I can `curl localhost:3000/api/health` and see the JSON — *Human-only* — *Evidence*: terminal screenshot.
