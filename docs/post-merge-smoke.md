# Post-merge smoke gate

## Purpose

A lightweight GitHub Actions workflow that runs on every push to `main` to catch two classes of regression before they affect users:

1. **Build errors** — `next build` detects duplicate exports, missing imports, and TypeScript/ESLint violations that only surface when both sides of a parallel merge coexist on the same branch.
2. **Server-crash regressions** — curling a fixed set of routes after `next start` catches pages that crash on render (e.g. `undefined.messages.length`) without requiring a browser or Playwright.

## Status

**Pending human commit** (D-029 constraint — the AI worker cannot write `.github/workflows/` files).

The workflow YAML is provided in PR #605 (closing issue #585). Once @alvarolobato commits it to `.github/workflows/post-merge-smoke.yml`, the gate activates automatically on the next push to `main`.

## What it covers

| Check | Failure class caught |
|-------|---------------------|
| `npm run build` | Duplicate exports, bad imports, TS/lint errors |
| HTTP 200/302 on `/` | Root page crash |
| HTTP 200/302 on `/paneles` | Dashboard list crash |
| HTTP 200/302 on `/conversations` | Conversations page crash |
| HTTP 200/302 on `/inicio` | Home page crash |
| HTTP 200/302 on `/admin/config` | Admin config page crash |

## What it does NOT cover

- Wrong API response shapes (covered by unit/integration tests)
- UI rendering correctness (out of scope — no Playwright)
- DB-dependent data (runs with `POSTGRES_DSN=""`)

## On failure

The workflow posts a comment on the most recently merged PR explaining which step failed and linking the run. No auto-revert or auto-block — merge is still human-controlled.

## References

- Parent issue: #570 (AI Factory: prevent contract-regression cascades)
- Sub-task: #585
- D-029: Worker must not write `.github/workflows/` files
