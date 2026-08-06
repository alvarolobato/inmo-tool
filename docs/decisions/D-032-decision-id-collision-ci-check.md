---
id: D-032
title: Decision-record ID collisions are caught by a pytest check, not prevented by a scheme change
date: 2026-08-04
group: Plumbing / process
rule: '`scripts/tests/test_decision_ids.py` enforces unique decision IDs, matching frontmatter, resolvable `DECISIONS.md` links, and no stale cross-references. Sequential IDs stay — no scheme change.'
order: 6
---

# D-032: Decision-record ID collisions are caught by a pytest check, not prevented by a scheme change

*Decided: 2026-08-04*

**Context**: Issue #203. Six decision records landed on three colliding IDs
(D-008, D-009, D-010 each claimed twice) because parallel agents each
branched from a `main` where their chosen "next free ID" was, at that
moment, genuinely free — git cannot see the conflict since the two files
differ only in filename, so they merge cleanly with no marker. A human
caught it by chance while reviewing an unrelated merge. The same shape
recurred **three more times in the same day** after #203 was filed but
before this fix landed: D-010 (PR #205, renumbered to D-017/D-018), D-019
(PR #209, renumbered to D-020), D-021 (PR #213, renumbered to D-022).

**Decision**: `scripts/tests/test_decision_ids.py`, part of the normal
pytest suite (no workflow change needed to run it — it collects like any
other test), asserts:
1. No two `docs/decisions/D-*.md` files claim the same ID.
2. Every file's frontmatter `id:` matches its filename's ID.
3. Every `docs/decisions/...` link in `DECISIONS.md` resolves to a real file.
4. No `docs/decisions/(archive/)?D-NNN-*.md`-shaped reference anywhere else
   in the repo (docs, code comments, SQL, shell) points at a file that no
   longer exists under that name — `docs/decisions/archive/` is excluded as
   a *source* of references (frozen source-project history, not rewritten;
   see AGENTS.md's bootstrap note) but a reference *into* it must still
   resolve.

Check 4 is not one of #203's three named acceptance criteria — it's the
"worth adding" cross-reference check the issue also called for, because
renumbering (which happened three times in the day after #203 was filed)
silently orphans any comment/doc/SQL file that quoted the old filename.
The first run of this check found **five pre-existing stale references on
`main`** (a not-yet-renumbered path in `etl/schema/init.sql`, two `D-019`
mentions that should have followed the Milanuncios photo-CDN decision to
its new `D-020`, and two comments pointing at a bare
`docs/decisions/D-025-...` path that only exists under
`docs/decisions/archive/`) and **two decision files with no YAML
frontmatter at all** (`D-006`, `D-007`, predating the frontmatter template
in AGENTS.md). All seven were fixed in the same PR that added the check —
shipping a check that starts red on `main` and stays that way helps no one.

**ID-scheme change — assessed, not adopted here**: #203 also floated a
no-coordination-needed ID scheme (date-based `D-2026-08-04-slug` or
issue-based `D-197-slug`) that removes the race instead of detecting it.
Assessed and rejected for now:
- **Migration cost is real, not hypothetical.** This PR's own detector run
  found 7 pre-existing integrity defects across only 22 decision records and
  ~10 cross-reference sites — with zero renumbering having happened to the
  *scheme* itself yet. Renumbering all 22 records to a new scheme would
  touch every file in `docs/decisions/`, every `DECISIONS.md` row, and every
  cross-reference site in `docs/`, `etl/`, `dashboard/`, and `scripts/` in a
  single PR — an order of magnitude more churn than the 7 defects just
  found from years of ordinary sequential numbering, concentrated in one
  changeset with no incremental way to verify it.
- **Readability loss is real.** Sequential IDs read as a chronological,
  countable list ("we're at D-032"); date-based or issue-based IDs don't
  sort adjacent to related decisions made close in time and require a
  lookup to know "how many decisions has this project made."
- **The actual failure mode was detection latency, not collision
  frequency.** Three collisions happened in one unusually parallel day; the
  detector added here turns the *next* one into a failed build within
  minutes of the PR opening, instead of a human noticing it by chance days
  later. That closes the actual gap #203 reported without paying the
  migration cost today.

**Alternatives rejected**: date-based/issue-based ID scheme (see above,
rejected for now — not forever). Doing nothing (option 3 in the issue,
"rely on human review") — rejected because it's exactly the mechanism that
already failed three times.

**Revisit when**: collision *frequency* becomes the bottleneck rather than
detection latency — e.g. if the AI factory moves to routine double-digit
concurrent agents and the failed-build/renumber cycle itself starts
costing more than the migration would. Until then, the detector is the
right-sized fix.

**Other "pick the next free N" conventions checked**: none found. Schema
migrations (`etl/schema/init.sql`) are a single idempotent file
(`IF NOT EXISTS` / `CREATE TABLE IF NOT EXISTS etl_one_time_migrations`
markers), not a sequentially-numbered migration directory, so they don't
share this defect shape. No fixture-ID or other sequential-counter
convention was found elsewhere in the repo.

**See**: issue #203, `scripts/tests/test_decision_ids.py`, PRs #205/#209/#213
(the three post-#203 collisions that motivated prioritizing this fix).
