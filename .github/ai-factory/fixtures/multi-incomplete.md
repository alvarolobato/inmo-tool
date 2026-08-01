# Multi-phase feature with unverified EC (the #720 / PR #730 failure case)

## Context
- **Problem**: ...
- **Worktree**: `multi-feature`

## Plan

| Phase | Goal |
|-------|------|
| 1 | Foundation |
| 2 | Replay |
| 3 | Caching |
| 4 | Memory tools |

## Phase 1 — Foundation

### Tasks
- [x] 1) Module skeleton
- [x] 2) Move builders
- [x] 3) Run all checks and fix issues
- [x] 4) Copilot review
- [x] 5) Opus review

## Phase 2 — Replay

### Tasks
- [ ] 1) Structured replay
- [ ] 2) Run all checks and fix issues
- [ ] 3) Copilot review
- [ ] 4) Opus review

## Phase 3 — Caching

### Tasks
- [ ] 1) Wire caching
- [ ] 2) Run all checks and fix issues
- [ ] 3) Copilot review
- [ ] 4) Opus review

## Phase 4 — Memory tools

### Tasks
- [ ] 1) WrenAI client
- [ ] 2) Run all checks and fix issues
- [ ] 3) Copilot review
- [ ] 4) Opus review

## Exit criteria / Validation

- [ ] **EC-1**: Centralized seam exists — *Verified by*: lint script.
- [ ] **EC-2**: Tool calls preserved on replay — *Verified by*: history.test.ts.
- [ ] **EC-3**: Token budget enforced — *Verified by*: history.test.ts.
- [ ] **EC-4**: Summaries never re-summarized — *Verified by*: DB CHECK constraint.
- [ ] **EC-5**: All flows use cache_control — *Verified by*: openrouter.test.ts.
- [ ] **EC-6**: CLI path uncached — *Verified by*: cli.test.ts.
- [ ] **EC-7**: Per-flow tool scoping — *Verified by*: runner.test.ts.
- [ ] **EC-8**: WrenAI memory tools work — *Verified by*: memory.test.ts.
- [ ] **EC-9**: FTS memory tools work — *Verified by*: memory.test.ts.
- [ ] **EC-10**: 25+ turn recall works — *Human-only*.
- [ ] **EC-11**: search_dashboards works in UI — *Human-only*.
- [ ] **EC-12**: Docs updated — *Verified by*: build:knowledge.
