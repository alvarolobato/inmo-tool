# PR Review Guidelines

You are reviewing a pull request for the inmo-tool project.

## Project Overview
- Python connector service crawling real-estate listing sites into PostgreSQL (see issue #1 for the full spec)
- Dedup engine collapsing duplicate cross-site listings into one property record
- Next.js + Tremor Dashboard App for AI-assisted candidate review
- CLI (`ps`) for all operations

## Critical Rules
1. **No credentials**: No API keys, passwords, or secrets in code
2. **No scraped personal data**: No owner names/phone numbers/real prices from live listings in committed files
3. **Connectors are read-only against source sites**: no automated form submission or contacting sellers — see issue #1 §15
4. **`profile_listing_state` (and anything downstream) keys on `property_id`, never `listing_id`** — this is the mechanism that makes dedup matter; see issue #1's "Review addressed" notes for why this was flagged as a defect

## Exit Criteria verification — FIRST, BLOCKING

**Before reading any code**, read the linked parent issue.

Find the parent issue number from the PR body (`Closes #NNN` or `Part of #NNN (Phase N of M)`).
Fetch its body:
```bash
gh issue view NNN --json body --jq .body
```

Find every line matching `- [ ] **EC-` or `- [x] **EC-`. For each:

1. State whether the code changes in this PR **satisfy** it — trace from the EC description to the specific file+function that implements it.
2. If the EC is NOT satisfied by code AND has no corresponding CI test (`.spec.ts`, `.test.ts`, `test_*.py`) that would catch a regression, **block the PR** with:

> 🚫 **EC-N not satisfied**: [EC description]. The code does not implement [what's missing], and there is no CI test that would catch this. This must be addressed before merge.

3. If the EC is satisfied by code but has no CI test, note it as a non-blocking warning:

> ⚠️ **EC-N has no automated test**: Satisfied by [file:line] but no test guards against regression.

4. If NO parent issue exists (no `Closes #` or `Part of #` in the PR body), skip this section.

**Why this matters**: The factory can ship code that compiles and passes unit tests but misses the feature's main point. EC items are the only machine-readable statement of user-observable behavior. If the reviewer does not verify them, no one does until the user runs the feature manually.

## Review Checklist
- [ ] No security vulnerabilities (OWASP top 10)
- [ ] SQL queries are parameterized
- [ ] Error handling is appropriate (not excessive)
- [ ] Tests are included for new functionality
- [ ] No breaking changes to existing APIs
- [ ] Docker/compose changes are backward compatible

## Test Coverage

### Test deletion warning

Compare deleted vs added lines in test files (`*__tests__*`, `*.test.ts`, `*.test.tsx`, `test_*.py`, `*.test.py`, `*.spec.ts`, `*.spec.tsx`).

**If the PR deletes more test lines than it adds**, post this warning block in the review:

> ⚠️ This PR deletes more test lines than it adds (−N deleted / +M added). The PR body must include a `## Test deletion rationale` section explaining why.

- If the PR body **already contains** `## Test deletion rationale`: acknowledge it and evaluate whether the rationale is credible. "Tests were rewritten" alone is not sufficient — the rationale must explain what coverage is preserved and how.
- If the PR body **does NOT contain** `## Test deletion rationale`: request changes and mark this as a **blocking comment**. The PR cannot be merged without this section.

### Coverage direction check (non-blocking)

If a PR adds new functionality (new exported functions, new API routes, new React components) but adds zero new test lines, note it as a non-blocking observation:

> ℹ️ This PR adds `<name>` but includes no new test lines — consider adding coverage.

This is advisory only. Do not block the PR on this check.

### Test file rename vs delete

Distinguish between two cases:
- **Rename / move**: a test file disappears from one path and reappears (possibly renamed) at another path with equivalent coverage. This is acceptable — note it without warning.
- **Delete with no replacement**: a test file is removed and no equivalent file appears elsewhere in the diff. This always requires a `## Test deletion rationale` section in the PR body, regardless of the line count delta.
