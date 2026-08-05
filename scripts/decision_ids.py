"""Shared helpers for decision-record ID allocation and cross-branch collision detection.

Issues #203 / #229. Decision records use a sequential ``D-NNN`` id. When two
agents work in parallel, each branches from ``main``, reads ``DECISIONS.md``,
picks "the next free id", and writes its record. Both are correct at the moment
they look — but the two files differ only in their filename slug
(``D-073-foo.md`` vs ``D-073-bar.md``), so git merges them with **no conflict
marker**. The within-tree guard (``test_decision_ids.py``) can't see the other
branch, so it passes on each side and the collision only surfaces after both
land. This has now happened ~8 times in one session.

This module is the shared core for two mechanisms that consult
**claimed-but-unmerged** ids, not just the local tree:

* ``next-decision-id.py`` (prevention) — a pre-flight allocator an agent runs
  BEFORE writing a record. It returns an id free on ``main`` AND on every open
  PR head branch.
* ``tests/test_decision_id_collision.py`` (detection) — a suite check that
  fails when an id newly added on the current branch already appears on another
  open PR.

Everything that reaches the network is funnelled through :func:`_run_gh` /
:func:`open_pr_decision_ids` (GitHub) and :func:`new_ids_vs_base` /
:func:`current_branch` (git). Each degrades gracefully — returning ``None``
rather than raising — so a CI run or a local run without ``gh``/network never
hard-fails on account of these helpers.
"""

from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
DECISIONS_DIR = REPO_ROOT / "docs" / "decisions"

# "D-073-below-market-distress-ranking.md" -> id="D-073", num="073"
FILENAME_RE = re.compile(r"^(D-(\d+))-[A-Za-z0-9-]+\.md$")


class GhUnavailable(Exception):
    """Raised internally when the ``gh`` CLI cannot be used (missing / offline / error)."""


# --------------------------------------------------------------------------- #
# Pure id helpers (no I/O — trivially unit-testable)
# --------------------------------------------------------------------------- #
def id_num(filename: str) -> int | None:
    """Return the integer id encoded in a decision filename, or ``None`` if it doesn't match."""
    m = FILENAME_RE.match(filename)
    return int(m.group(2)) if m else None


def format_id(n: int) -> str:
    """Render an integer id in the canonical zero-padded ``D-NNN`` form."""
    return f"D-{n:03d}"


def parse_ids(filenames) -> set[int]:
    """Extract the set of integer ids from an iterable of decision filenames."""
    out: set[int] = set()
    for name in filenames:
        v = id_num(name)
        if v is not None:
            out.add(v)
    return out


def next_free_id(*id_sets: set[int], start: int = 1) -> int:
    """Return the next sequential id above the highest id in any of ``id_sets``.

    The convention (AGENTS.md § Recording decisions) is **max + 1**, never
    filling gaps: "Skip IDs are fine when a decision is retired — never reuse
    them." So this deliberately does not return the lowest free integer.
    """
    taken: set[int] = set()
    for s in id_sets:
        taken |= s
    return (max(taken) + 1) if taken else start


def local_decision_ids(decisions_dir: Path = DECISIONS_DIR) -> set[int]:
    """Ids present as ``D-*.md`` files directly under ``decisions_dir`` (not ``archive/``)."""
    if not decisions_dir.is_dir():
        return set()
    return parse_ids(p.name for p in decisions_dir.glob("D-*.md") if p.is_file())


def detect_collisions(
    new_ids: set[int], pr_map: dict[int, tuple[str, set[int]]]
) -> list[str]:
    """Human-readable messages for any ``new_ids`` also claimed by an open PR.

    ``pr_map`` is shaped like the return of :func:`open_pr_decision_ids`:
    ``{pr_number: (head_branch, {ids})}``. Pure — no I/O — so the detection
    logic can be unit-tested directly.
    """
    msgs: list[str] = []
    for nid in sorted(new_ids):
        for pr_num, (branch, ids) in sorted(pr_map.items()):
            if nid in ids:
                msgs.append(
                    f"{format_id(nid)} is newly added on this branch but is already "
                    f"claimed by open PR #{pr_num} ({branch})"
                )
    return msgs


# --------------------------------------------------------------------------- #
# gh CLI access (network — isolated + monkeypatch-friendly)
# --------------------------------------------------------------------------- #
def gh_available() -> bool:
    """True if the ``gh`` binary is on PATH. (Does not check auth/network.)"""
    return shutil.which("gh") is not None


def _run_gh(args: list[str], timeout: int = 30) -> str:
    """Run ``gh <args>`` and return stdout, or raise :class:`GhUnavailable`.

    All the failure modes an offline/unauthenticated environment produces
    (missing binary, network error, non-zero exit) are funnelled into a single
    exception type callers turn into a graceful ``None``.
    """
    if not gh_available():
        raise GhUnavailable("gh CLI not found on PATH")
    try:
        proc = subprocess.run(
            ["gh", *args],
            capture_output=True,
            text=True,
            timeout=timeout,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired) as e:
        raise GhUnavailable(f"gh invocation failed: {e}") from e
    if proc.returncode != 0:
        raise GhUnavailable(
            f"gh {' '.join(args)} exited {proc.returncode}: {proc.stderr.strip()}"
        )
    return proc.stdout


def _repo_slug() -> str | None:
    """The ``owner/repo`` slug, from env override or ``gh repo view``; ``None`` if undeterminable."""
    env = os.environ.get("INMO_REPO_SLUG") or os.environ.get("GH_REPO")
    if env:
        return env
    try:
        return _run_gh(
            ["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"]
        ).strip()
    except GhUnavailable:
        return None


def open_pr_decision_ids(
    exclude_branch: str | None = None,
) -> dict[int, tuple[str, set[int]]] | None:
    """Decision ids claimed on every open PR's head branch.

    Returns ``{pr_number: (head_branch, {ids})}``, or ``None`` when ``gh`` is
    unavailable/offline (so callers degrade gracefully). ``exclude_branch``
    skips one branch — the caller's own — so a PR never collides with itself.

    A branch that has no ``docs/decisions/`` dir (404) or an individual API
    hiccup is treated as "no ids on that branch" and skipped, rather than
    failing the whole scan — only a failure of the top-level ``pr list`` (the
    signal that ``gh`` itself can't be used) collapses to ``None``.
    """
    try:
        out = _run_gh(
            [
                "pr",
                "list",
                "--state",
                "open",
                "--limit",
                "200",
                "--json",
                "number,headRefName",
            ]
        )
    except GhUnavailable:
        return None

    try:
        prs = json.loads(out)
    except json.JSONDecodeError:
        return None

    slug = _repo_slug()
    if not slug:
        return None

    result: dict[int, tuple[str, set[int]]] = {}
    for pr in prs:
        branch = pr.get("headRefName")
        number = pr.get("number")
        if branch is None or number is None:
            continue
        if exclude_branch is not None and branch == exclude_branch:
            continue
        try:
            contents = _run_gh(
                [
                    "api",
                    f"repos/{slug}/contents/docs/decisions?ref={branch}",
                    "--jq",
                    ".[].name",
                ]
            )
        except GhUnavailable:
            # No docs/decisions on that branch, or a transient per-branch error.
            # Record an empty claim set so the branch still appears in the map.
            result[number] = (branch, set())
            continue
        names = [ln.strip() for ln in contents.splitlines() if ln.strip()]
        result[number] = (branch, parse_ids(names))
    return result


# --------------------------------------------------------------------------- #
# git access (for the collision test — also isolated + graceful)
# --------------------------------------------------------------------------- #
def _run_git(args: list[str], timeout: int = 30) -> str | None:
    """Run ``git <args>`` in the repo, returning stdout or ``None`` on any failure."""
    try:
        proc = subprocess.run(
            ["git", *args],
            cwd=REPO_ROOT,
            capture_output=True,
            text=True,
            timeout=timeout,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired):
        return None
    if proc.returncode != 0:
        return None
    return proc.stdout


def current_branch() -> str | None:
    """The current git branch name, or ``None`` (e.g. detached HEAD / no git)."""
    out = _run_git(["rev-parse", "--abbrev-ref", "HEAD"])
    if out is None:
        return None
    name = out.strip()
    return name or None


def new_ids_vs_base(base: str = "origin/main") -> set[int] | None:
    """Ids for decision files **added** on HEAD relative to ``base``.

    Returns ``None`` when ``base`` can't be resolved (e.g. ``origin/main`` not
    fetched, offline clone) so callers can skip rather than fail.
    """
    # Verify the base ref exists first — otherwise `git diff` errors and we'd
    # can't tell "no new ids" from "base missing".
    if _run_git(["rev-parse", "--verify", "--quiet", base]) is None:
        return None
    out = _run_git(
        [
            "diff",
            "--diff-filter=A",
            "--name-only",
            f"{base}...HEAD",
            "--",
            "docs/decisions/",
        ]
    )
    if out is None:
        return None
    names = [Path(line).name for line in out.splitlines() if line.strip()]
    return parse_ids(names)
