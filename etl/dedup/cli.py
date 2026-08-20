"""`python -m etl.dedup.cli run|revert <id>` — the body cli/commands/dedup.sh calls.

Kept separate from etl.dedup.engine so the engine module has zero argparse/
process-exit concerns and stays trivially importable/testable.
"""

from __future__ import annotations

import argparse
import sys

from etl import orchestrator
from etl.config import Config
from etl.db.postgres import get_connection
from etl.dedup import actions, engine


def _cmd_run(conn) -> int:
    # Goes through orchestrator.run_dedup, not etl.dedup.engine.run()
    # directly (issue #185), so a manual `ps dedup run` records a
    # `dedup_runs` row exactly like the automatic post-connector-sweep pass
    # does — one observability path, not two divergent ones.
    result = orchestrator.run_dedup(
        conn,
        trigger="cli-manual",
        dedup_max_runtime_seconds=Config().dedup_max_runtime_seconds,
    )
    if result is None:
        # Skipped by the single-runner guard (D-036): another dedup pass
        # already holds the advisory lock. Not an error — a deliberate no-op
        # so we don't overlap a second ~84-min pass against the same corpus.
        print(
            "Another dedup pass is already running (single-runner guard, "
            "D-036) — skipped. Nothing to do; the in-flight run will finish "
            "on its own. Check `ps dedup status`."
        )
        return 0
    print(
        f"Compared {result.pairs_compared} pair(s): "
        f"{result.merged} merged, {result.suggested} suggested for review, "
        f"{result.conflicts} merge-time conflict(s) flagged."
    )
    if result.same_property_pending_resolved:
        # Issue #604: same visibility precedent as same_source_skipped
        # below — a pending row resolved this way never goes through
        # evaluate_pair, so it's invisible in the "Compared ..." line above.
        print(
            f"Resolved {result.same_property_pending_resolved} pending "
            f"suggestion(s) whose listings were already unified by a "
            f"different merge (issue #604) — marked confirmed, no new "
            f"merge performed."
        )
    if result.same_source_skipped:
        # Issue #197: same-source pairs are skipped before ever reaching
        # evaluate_pair, so they're invisible in the "Compared ..." line
        # above by construction — surfaced here instead so `ps dedup run`
        # stays the one place an operator can see them, per that issue's
        # "don't make same-source duplicates invisible" requirement.
        print(
            f"Skipped {result.same_source_skipped} same-source pair(s) "
            f"(never paired for merge/suggestion — issue #197), of which "
            f"{result.same_source_cadastral_collisions} shared a "
            f"cadastral_ref (data-quality flag, see logs)."
        )
    if result.photo_hash_zero_success_sources:
        # Issue #206: a source whose photos never hash is otherwise
        # invisible — match_ratio is only computed over successfully-
        # hashed photos, so this source contributes no photo evidence to
        # any pair it's in, and every such pair looks identical to "no
        # match found" rather than "couldn't check". Surfaced here (like
        # same_source_skipped above) so `ps dedup run` stays the one place
        # an operator sees it, not just a per-run WARNING in the logs.
        parts = ", ".join(
            f"{source} (0/{attempted})"
            for source, attempted in sorted(
                result.photo_hash_zero_success_sources.items()
            )
        )
        print(
            f"WARNING: 0% photo-hash success this run for: {parts} — "
            f"photo_hash contributes no evidence for pairs involving "
            f"these sources (issue #206)."
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


def _cmd_process_actions(conn) -> int:
    """Drain every pending `suggested_merge_action` row once and exit.

    The long-running container runs this on a poll loop
    (`actions.run_action_poll_loop`, started in etl/main.py) — this
    subcommand is the one-shot equivalent, for manual operation (`ps dedup
    process-actions`) and for tests that need a deterministic single tick
    instead of waiting on the background thread's interval.
    """
    count = actions.process_pending_actions(conn)
    print(f"Processed {count} pending dedup review-queue action(s).")
    return 0


def _cmd_purge_same_source(conn) -> int:
    """One-off migration companion for issue #197 (`ps dedup
    purge-same-source`): delete existing `pending` suggested_merge rows
    whose two listings share a source. Idempotent — a second run against an
    already-purged database deletes 0 rows and exits 0."""
    deleted = engine.purge_same_source_pending(conn)
    print(
        f"Purged {deleted} pending same-source suggestion(s) "
        "(issue #197 one-off migration)."
    )
    return 0


def _cmd_purge_phone(conn) -> int:
    """One-off migration companion for issue #603 (`ps dedup purge-phone`):
    delete remaining `pending` `match_basis='phone'` rows — run once,
    after the reordered/silenced signal has had a chance to reevaluate
    the existing backlog on its own (see `engine.purge_pending_phone`'s
    docstring for why this should normally find nothing left)."""
    deleted = engine.purge_pending_phone(conn)
    print(
        f"Purged {deleted} pending phone suggestion(s) (issue #603 one-off migration)."
    )
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
    subparsers.add_parser(
        "process-actions",
        help="Drain pending dashboard review-queue confirm/reject requests once",
    )
    subparsers.add_parser(
        "purge-same-source",
        help=(
            "One-off migration (issue #197): delete pending suggested_merge "
            "rows whose two listings share a source"
        ),
    )
    subparsers.add_parser(
        "purge-phone",
        help=(
            "One-off migration (issue #603): delete remaining pending "
            "match_basis='phone' suggested_merge rows"
        ),
    )

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
        if args.subcommand == "process-actions":
            return _cmd_process_actions(conn)
        if args.subcommand == "purge-same-source":
            return _cmd_purge_same_source(conn)
        if args.subcommand == "purge-phone":
            return _cmd_purge_phone(conn)
        return _cmd_resolve_conflict(conn, args.suggestion_id)
    finally:
        conn.close()


if __name__ == "__main__":
    sys.exit(main())
