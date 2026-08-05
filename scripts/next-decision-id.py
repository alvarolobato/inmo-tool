#!/usr/bin/env python3
"""Allocate the next free decision-record ID across main AND every open PR.

Run this **before** writing a new ``docs/decisions/D-NNN-<slug>.md`` record.
It scans the local ``docs/decisions/`` tree and — when the ``gh`` CLI is
authenticated — every open PR's head branch, so two agents working in parallel
don't both grab the same id (issues #203, #229).

    $ python3 scripts/next-decision-id.py
    D-073

    $ python3 scripts/next-decision-id.py --verbose
    # prints, to stderr, which ids are reserved and by which PR

    $ python3 scripts/next-decision-id.py --json
    {"next": "D-073", "checked_open_prs": true, "reserved": { ... }}

Offline / no ``gh``: the tool falls back to the **local tree only**, prints a
clear warning to stderr, and still emits an id on stdout. That id may collide
with an unmerged branch, so re-run once you have network before committing.

Exit codes: 0 always on success (even in the degraded offline path). The
warning is advisory, not an error, so scripting around it stays simple.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from decision_ids import (
    format_id,
    local_decision_ids,
    next_free_id,
    open_pr_decision_ids,
)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--verbose",
        action="store_true",
        help="print reservation detail (who claims what) to stderr",
    )
    parser.add_argument(
        "--json",
        action="store_true",
        help="emit a JSON object on stdout instead of a bare id",
    )
    args = parser.parse_args(argv)

    local = local_decision_ids()
    pr_map = open_pr_decision_ids()

    pr_ids: set[int] = set()
    if pr_map is not None:
        for _branch, ids in pr_map.values():
            pr_ids |= ids

    nxt = next_free_id(local, pr_ids)
    next_str = format_id(nxt)

    checked = pr_map is not None
    if not checked:
        print(
            "warning: could not reach GitHub via `gh` — checked the LOCAL tree "
            "ONLY. The id below may already be claimed on an unmerged branch; "
            "re-run with network before committing.",
            file=sys.stderr,
        )

    if args.verbose:
        highest_local = max(local) if local else 0
        print(
            f"local highest: {format_id(highest_local) if local else '(none)'}",
            file=sys.stderr,
        )
        if pr_map:
            print("open-PR claims:", file=sys.stderr)
            for pr_num, (branch, ids) in sorted(pr_map.items()):
                shown = ", ".join(format_id(i) for i in sorted(ids)) or "(none)"
                print(f"  #{pr_num} {branch}: {shown}", file=sys.stderr)
        elif checked:
            print("open-PR claims: (none)", file=sys.stderr)

    if args.json:
        reserved: dict[str, str] = {}
        if pr_map:
            for pr_num, (branch, ids) in pr_map.items():
                for i in ids:
                    reserved[format_id(i)] = f"#{pr_num} {branch}"
        json.dump(
            {
                "next": next_str,
                "checked_open_prs": checked,
                "local_highest": format_id(max(local)) if local else None,
                "reserved": reserved,
            },
            sys.stdout,
            indent=2,
        )
        sys.stdout.write("\n")
    else:
        print(next_str)

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
