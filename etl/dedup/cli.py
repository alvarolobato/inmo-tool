"""`python -m etl.dedup.cli run|revert <id>` — the body cli/commands/dedup.sh calls.

Kept separate from etl.dedup.engine so the engine module has zero argparse/
process-exit concerns and stays trivially importable/testable.
"""

from __future__ import annotations

import argparse
import sys

from etl.config import Config
from etl.db.postgres import get_connection
from etl.dedup import engine


def _cmd_run(conn) -> int:
    result = engine.run(conn)
    print(
        f"Compared {result.pairs_compared} pair(s): "
        f"{result.merged} merged, {result.suggested} suggested for review, "
        f"{result.conflicts} merge-time conflict(s) flagged."
    )
    return 0


def _cmd_revert(conn, merge_log_id: int) -> int:
    try:
        engine.revert(conn, merge_log_id)
    except ValueError as exc:
        print(f"revert failed: {exc}", file=sys.stderr)
        return 1
    print(f"Reverted merge {merge_log_id}.")
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="python -m etl.dedup.cli")
    subparsers = parser.add_subparsers(dest="subcommand", required=True)
    subparsers.add_parser("run", help="Run the dedup engine once")
    revert_parser = subparsers.add_parser("revert", help="Revert one auto-merge")
    revert_parser.add_argument("merge_log_id", type=int)

    args = parser.parse_args(argv)

    config = Config()
    conn = get_connection(config)
    try:
        if args.subcommand == "run":
            return _cmd_run(conn)
        return _cmd_revert(conn, args.merge_log_id)
    finally:
        conn.close()


if __name__ == "__main__":
    sys.exit(main())
