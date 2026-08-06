"""Cross-branch decision-id collision detection (issue #229).

``test_decision_ids.py`` catches duplicate ids *within a tree*. It structurally
cannot catch the case that actually keeps happening: two branches each add a
differently-slugged file for the same id, git merges them cleanly, and the
within-tree guard passes on each side in isolation.

This module closes that gap. It has two layers:

1. Pure unit tests for :func:`decision_ids.detect_collisions` — the logic that,
   given the ids newly added on this branch and the ids claimed on other open
   PRs, reports any overlap. No I/O.
2. A live suite check (:func:`test_this_branch_has_no_cross_pr_collision`) that
   wires real git (ids added vs ``origin/main``) to real ``gh`` (open-PR
   claims) and fails if this branch's new id is already claimed elsewhere.

The live check **skips gracefully** — never fails — when ``gh`` is unavailable
or ``origin/main`` isn't resolvable (offline clone, CI without network), so it
can't break a run for lack of connectivity. That's the deliberate trade: it's a
best-effort early-warning, and renumber-at-merge remains the backstop.
"""

import sys
from pathlib import Path

import pytest

SCRIPTS_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SCRIPTS_DIR))

import decision_ids as di


# --------------------------------------------------------------------------- #
# Pure detection logic
# --------------------------------------------------------------------------- #
def test_detect_collisions_finds_overlap():
    new_ids = {73}
    pr_map = {
        348: ("feat/escogecasa", {73, 74, 75, 76}),
        347: ("feat/pisos", {71, 72}),
    }
    msgs = di.detect_collisions(new_ids, pr_map)
    assert len(msgs) == 1
    assert "D-073" in msgs[0]
    assert "#348" in msgs[0]
    assert "feat/escogecasa" in msgs[0]


def test_detect_collisions_clean_when_unique():
    new_ids = {77}
    pr_map = {
        348: ("feat/escogecasa", {73, 74, 75, 76}),
        347: ("feat/pisos", {71, 72}),
    }
    assert di.detect_collisions(new_ids, pr_map) == []


def test_detect_collisions_reports_each_offender():
    new_ids = {73, 71}
    pr_map = {
        348: ("feat/escogecasa", {73}),
        347: ("feat/pisos", {71}),
    }
    msgs = di.detect_collisions(new_ids, pr_map)
    assert len(msgs) == 2


def test_detect_collisions_empty_inputs():
    assert di.detect_collisions(set(), {}) == []
    assert di.detect_collisions({5}, {}) == []
    assert di.detect_collisions(set(), {1: ("b", {5})}) == []


# --------------------------------------------------------------------------- #
# Live wiring — skips gracefully offline / without gh
# --------------------------------------------------------------------------- #
def test_this_branch_has_no_cross_pr_collision():
    """Fail if an id newly added on HEAD is already claimed by another open PR.

    Skips (never fails) when the data needed can't be gathered without a
    network — see module docstring.
    """
    new_ids = di.new_ids_vs_base("origin/main")
    if new_ids is None:
        pytest.skip(
            "origin/main not resolvable (offline / not fetched) — skipping cross-PR check"
        )
    if not new_ids:
        pytest.skip("this branch adds no new decision records — nothing to check")

    # Resolve "our own" PR so it isn't flagged as colliding with itself.
    # A detached-HEAD checkout (CI, `gh pr checkout` of a branch already in a
    # worktree, a reviewer worktree) reports its branch as "HEAD", so we can't
    # rely on the branch name alone: prefer the CI-provided source-branch env,
    # fall back to the local branch name, and ALSO exclude by head commit sha.
    import os

    branch = os.environ.get("GITHUB_HEAD_REF") or di.current_branch()
    pr_map = di.open_pr_decision_ids(exclude_branch=branch, exclude_sha=di.head_sha())
    if pr_map is None:
        pytest.skip(
            "gh unavailable/offline — cannot read other open PRs; renumber-at-merge is the backstop"
        )

    collisions = di.detect_collisions(new_ids, pr_map)
    assert not collisions, (
        "This branch's new decision id(s) are already claimed on another open PR. "
        "Run `python3 scripts/next-decision-id.py` to pick a free id and rename the "
        "file + its frontmatter + the DECISIONS.md row:\n"
        + "\n".join(f"  {m}" for m in collisions)
    )
