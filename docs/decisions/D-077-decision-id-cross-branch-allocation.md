---
id: D-077
title: Cross-branch decision-id allocation + collision detection
date: 2026-08-06
group: Plumbing / process
rule: Allocate decision IDs with `scripts/next-decision-id.py` (scans local tree + every open PR head) BEFORE writing a record; `test_decision_id_collision.py` fails when a HEAD-vs-`origin/main` new ID is claimed on another open PR. Both skip gracefully offline; sequential IDs kept (extends D-032); renumber-at-merge is the residual-race backstop.
order: 7
---

# D-077: Cross-branch decision-id allocation + collision detection

*Decided: 2026-08-06*

**Context**: Decision-record ids kept colliding under parallel work — ~8 times in
one session; issue #229 counts seven, most recently three branches simultaneously
claiming the same id. Each agent branches from `main`, reads `DECISIONS.md`,
picks "the next free id", and writes its file. Every agent is correct at the
moment it looks. But two branches' files differ only in their filename slug
(`D-077-foo.md` vs `D-077-bar.md`), so git merges them with **no conflict
marker**, and the within-tree guard from D-032 (`scripts/tests/test_decision_ids.py`)
can only see one tree, so it passes on each side. The collision surfaces only
after both land and a human notices. Adding a warning to each agent's brief did
not help — an agent that opens a record mid-task doesn't re-check what was
claimed while it worked. Running the allocator built here against the five open
PRs revealed ids reserved all the way to D-076 (PR #348), which is why this
record is D-077 and not D-069.

**Decision**: Add two mechanisms that consult **claimed-but-unmerged** ids, not
just the local tree, sharing one library (`scripts/decision_ids.py`):

1. **Prevention — a pre-flight allocator** (`scripts/next-decision-id.py`). Run it
   BEFORE writing a decision record. It scans the local `docs/decisions/` tree
   AND every open PR's head branch (`gh pr list` + `gh api .../contents/docs/decisions?ref=<branch>`)
   and prints the next id free everywhere (max across all sources + 1). AGENTS.md
   § Recording decisions now requires this step in place of "pick the next free id".

2. **Detection — a cross-branch suite check** (`scripts/tests/test_decision_id_collision.py`).
   It computes the ids **added on HEAD vs `origin/main`** and fails if any is
   already claimed on another open PR. This catches the mid-task case the brief
   warning missed.

Both **degrade gracefully**: when `gh` is missing/offline or `origin/main` isn't
resolvable, the allocator falls back to the local tree with a loud stderr
warning (still prints an id) and the test `pytest.skip`s with a clear message —
neither ever hard-fails a run for lack of network. The within-tree D-032 guard
stays intact and unchanged.

**Sequential ids are KEPT** — this supersedes neither D-032's rejection of a
scheme change nor the readable "we're at D-N" convention. #229 asked this be
stated explicitly: we chose prevention + detection over switching to
`D-<YYYYMMDD>-slug` / issue-number ids.

**Residual race**: even the allocator races if two agents call it in the same
window before either pushes a branch — GitHub can't yet see an unpushed local
record. The allocator narrows the window from "whole task duration" to "seconds
between allocate and push", and the detection test catches most of what slips
through before merge. We deliberately did NOT build a distributed lock or a
reservation file (a reservation file adds its own race and needs discipline —
#229's weakest option). **Renumber-at-merge remains the backstop** for the
residual race; the goal is to cut collisions drastically, not to claim they're
impossible.

**Alternatives rejected**:
- *Switch to date/issue-number ids* (removes the scarce global counter entirely):
  rejected to preserve the countable sequential convention D-032 already settled;
  revisit only if collisions persist despite this.
- *A CI workflow that reads other PR branches*: would live under
  `.github/workflows/` — D-004/#275 forbids the worker committing there. The
  detection lives in the pytest suite instead (runs in the existing test job);
  the optional CI wiring is proposed as YAML in the PR body for a human to commit.
- *A reservation file agents append to*: adds a different race and needs
  discipline (#229's own weakest option).

**See**: `scripts/decision_ids.py`, `scripts/next-decision-id.py`,
`scripts/tests/test_decision_id_collision.py`, `scripts/tests/test_next_decision_id.py`,
AGENTS.md § Recording decisions, D-032 (within-tree guard, extended here),
D-004 (no worker workflow commits), issues #203 / #229.
