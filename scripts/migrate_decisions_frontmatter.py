#!/usr/bin/env python3
"""One-time migration (#352): stamp ``group``/``rule``/``order`` frontmatter.

Parses the hand-maintained ``DECISIONS.md`` and, for each row, injects the
group header it lives under, its one-line binding rule, and its global position
(``order``) into the matching ``docs/decisions/D-NNN-*.md`` file's frontmatter —
so ``scripts/build-decisions-index.py`` can regenerate the index byte-for-byte.

Idempotent: re-running overwrites the three managed fields, never duplicates
them, and preserves every other frontmatter field and the file body verbatim.

Run once from the repo root, then verify:

    python3 scripts/migrate_decisions_frontmatter.py
    python3 scripts/build-decisions-index.py
    git diff --exit-code DECISIONS.md   # must be empty
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

import yaml

REPO_ROOT = Path(__file__).resolve().parents[1]
DECISIONS_DIR = REPO_ROOT / "docs" / "decisions"
INDEX_PATH = REPO_ROOT / "DECISIONS.md"

_GROUP_RE = re.compile(r"^##\s+(.*?)\s*$")
_ROW_RE = re.compile(
    r"^\|\s*\[(D-\d+)\]\((docs/decisions/[^)]+)\)\s*\|\s*(.*?)\s*\|\s*$"
)


def parse_index(text: str) -> list[tuple[str, str, str]]:
    """Return ``[(decision_id, group, rule)]`` in the index's file order."""
    rows: list[tuple[str, str, str]] = []
    group = None
    for line in text.splitlines():
        gm = _GROUP_RE.match(line)
        if gm:
            group = gm.group(1)
            continue
        rm = _ROW_RE.match(line)
        if rm and group is not None:
            rows.append((rm.group(1), group, rm.group(3)))
    return rows


def _yaml_scalar(key: str, value) -> str:
    """One frontmatter line, robustly quoted, no line wrapping."""
    dumped = yaml.safe_dump(
        {key: value}, default_flow_style=False, allow_unicode=True, width=10**9
    )
    return dumped.rstrip("\n")


def inject(path: Path, group: str, rule: str, order: int) -> None:
    text = path.read_text(encoding="utf-8")
    if not text.startswith("---"):
        raise SystemExit(f"{path.name}: no frontmatter block")
    _, fm, body = text.split("---", 2)

    # Drop any previously-managed lines, then re-append (idempotent).
    kept = [
        ln
        for ln in fm.strip("\n").splitlines()
        if not re.match(r"^(group|rule|order):", ln)
    ]
    kept.append(_yaml_scalar("group", group))
    kept.append(_yaml_scalar("rule", rule))
    kept.append(_yaml_scalar("order", order))

    new_fm = "\n".join(kept)
    path.write_text(f"---\n{new_fm}\n---{body}", encoding="utf-8")


def main() -> int:
    rows = parse_index(INDEX_PATH.read_text(encoding="utf-8"))
    files = {}
    for p in DECISIONS_DIR.glob("D-*.md"):
        m = re.match(r"^(D-\d+)-", p.name)
        if m:
            files[m.group(1)] = p

    missing = [rid for rid, _, _ in rows if rid not in files]
    if missing:
        raise SystemExit(f"index rows with no file: {missing}")

    for order, (rid, group, rule) in enumerate(rows, start=1):
        inject(files[rid], group, rule, order)

    print(f"Migrated {len(rows)} decision files.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
