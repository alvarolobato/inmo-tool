#!/usr/bin/env python3
"""Render ``DECISIONS.md`` from the per-decision files' frontmatter.

    $ python3 scripts/build-decisions-index.py          # write DECISIONS.md
    $ python3 scripts/build-decisions-index.py --check   # drift guard (no write)

``--check`` regenerates in memory and compares against the on-disk
``DECISIONS.md``; it exits non-zero (and prints a unified diff) when they
differ, mirroring the ``knowledge.ts`` drift guard. Wire it into CI alongside
`git diff --exit-code DECISIONS.md`.

See ``scripts/decisions_index.py`` for the generation logic and the frontmatter
contract (``rule:`` / ``group:`` / optional ``order:``).
"""

from __future__ import annotations

import argparse
import difflib
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from decisions_index import INDEX_PATH, generate, write_index


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--check",
        action="store_true",
        help="don't write; exit 1 if the on-disk DECISIONS.md is out of date",
    )
    args = parser.parse_args(argv)

    generated = generate()

    if args.check:
        current = INDEX_PATH.read_text(encoding="utf-8") if INDEX_PATH.is_file() else ""
        if current == generated:
            print("DECISIONS.md is up to date.")
            return 0
        diff = difflib.unified_diff(
            current.splitlines(keepends=True),
            generated.splitlines(keepends=True),
            fromfile="DECISIONS.md (on disk)",
            tofile="DECISIONS.md (regenerated)",
        )
        sys.stdout.writelines(diff)
        print(
            "\nDECISIONS.md is out of date. Run: python3 scripts/build-decisions-index.py",
            file=sys.stderr,
        )
        return 1

    write_index()
    print(f"Wrote {INDEX_PATH.name}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
