# Add /api/health endpoint

## Context
- **Problem**: No endpoint to check ETL sync freshness
- **Worktree**: `health-endpoint`
- **Scope**: One route, one test
- **Definition of done**: `GET /api/health` returns `{ status, last_sync }`. Tests pass.

## Phase 1 — Health endpoint

**Goal**: Implement and test the endpoint
**Branch**: `health-endpoint-p1`
**Depends on**: nothing

### Tasks

- [ ] 1) Create `dashboard/app/api/health/route.ts`
- [ ] 2) Add Vitest test
- [ ] 3) Run all checks and fix issues
- [ ] 4) Copilot review (one round only)
- [ ] 5) Opus review (one round only, clean context)
