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


def _cmd_confirm(conn, suggestion_id: int) -> int:
    try:
        survivor_id, losing_id, had_conflict = engine.confirm_suggestion(
            conn, suggestion_id
        )
    except ValueError as exc:
        print(f"confirm failed: {exc}", file=sys.stderr)
        return 1
    msg = (
        f"Confirmed suggestion {suggestion_id}: merged property {losing_id} "
        f"into {survivor_id}."
    )
    if had_conflict:
        msg += (
            " A per-profile state conflict was flagged during reconciliation — "
            "see `ps dedup suggestions`."
        )
    print(msg)
    return 0


def _cmd_reject(conn, suggestion_id: int) -> int:
    try:
        engine.reject_suggestion(conn, suggestion_id)
    except ValueError as exc:
        print(f"reject failed: {exc}", file=sys.stderr)
        return 1
    print(f"Rejected suggestion {suggestion_id}; it won't be suggested again.")
    return 0


def _cmd_resolve_conflict(conn, suggestion_id: int) -> int:
    try:
        engine.resolve_conflict(conn, suggestion_id)
    except ValueError as exc:
        print(f"resolve-conflict failed: {exc}", file=sys.stderr)
        return 1
    print(f"Marked conflict {suggestion_id} as resolved.")
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="python -m etl.dedup.cli")
    subparsers = parser.add_subparsers(dest="subcommand", required=True)
    subparsers.add_parser("run", help="Run the dedup engine once")
    revert_parser = subparsers.add_parser("revert", help="Revert one auto-merge")
    revert_parser.add_argument("merge_log_id", type=int)
    confirm_parser = subparsers.add_parser(
        "confirm", help="Merge the pair behind a suggested_merge row"
    )
    confirm_parser.add_argument("suggestion_id", type=int)
    reject_parser = subparsers.add_parser(
        "reject", help="Mark a suggestion as not-the-same-property"
    )
    reject_parser.add_argument("suggestion_id", type=int)
    resolve_parser = subparsers.add_parser(
        "resolve-conflict", help="Clear a merge-time state conflict flag"
    )
    resolve_parser.add_argument("suggestion_id", type=int)

    args = parser.parse_args(argv)

    config = Config()
    conn = get_connection(config)
    try:
        if args.subcommand == "run":
            return _cmd_run(conn)
        if args.subcommand == "revert":
            return _cmd_revert(conn, args.merge_log_id)
        if args.subcommand == "confirm":
            return _cmd_confirm(conn, args.suggestion_id)
        if args.subcommand == "reject":
            return _cmd_reject(conn, args.suggestion_id)
        return _cmd_resolve_conflict(conn, args.suggestion_id)
    finally:
        conn.close()


if __name__ == "__main__":
    sys.exit(main())
