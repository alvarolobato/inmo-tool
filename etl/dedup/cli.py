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
from etl.dedup import actions, engine, retroactive


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


def _cmd_retroactive(conn, apply: bool) -> int:
    """`ps dedup retroactive [--apply]` (issue #568) — dry-run by default.

    Reports what the D-116/D-117/D-119 hard vetoes would retroactively
    change against what's already in the DB: which currently-merged
    properties D-116 would revert, and how many currently-pending `fuzzy`
    suggestions D-117/D-119 would demote to `rejected` on the next
    `ps dedup run`. `--apply` performs the D-116 reverts (never deletes a
    row — see `etl.dedup.engine.revert`); it does NOT trigger the
    pending-suggestion demotion itself, which happens automatically on the
    next `ps dedup run` (D-024) — see `etl.dedup.retroactive`'s module
    docstring for why that's a deliberate choice, not an oversight.
    """
    report = retroactive.run_retroactive_pass(conn, apply=apply)

    print("Retroactive dedup-rule application (issue #568)")
    print(
        f"  Mode: {'APPLY (writing)' if apply else 'DRY RUN (default — nothing written)'}"
    )
    print()

    if not report.reference_code_rule_available:
        print(
            "D-116 (reference-code conflict, PR #565): rule not present in "
            "this build yet — 0 candidates found. Re-run this command once "
            "#565 merges."
        )
    else:
        candidates = report.reference_code_candidates
        if not candidates:
            print(
                "D-116 (reference-code conflict): rule is live — 0 "
                "currently-merged properties conflict (checked through the "
                "same cross-source, non-same-property reachability filter "
                "engine._run() itself applies — issue #197). Measured ZERO "
                "against the live demo DB too; see D-116/reference_code.py "
                "for why that's expected, not broken."
            )
        else:
            n_properties = len({c.property_id for c in candidates})
            print(
                f"D-116 (reference-code conflict): {len(candidates)} "
                f"merge_log row(s) across {n_properties} currently-merged "
                f"propert{'y' if n_properties == 1 else 'ies'} would be "
                f"REVERTED:"
            )
            for c in candidates:
                print(
                    f"    merge_log #{c.merge_log_id}: property "
                    f"{c.property_id} <- losing property "
                    f"{c.losing_property_id} (listing {c.a_listing_id} "
                    f"code={c.a_reference_code!r} vs listing "
                    f"{c.b_listing_id} code={c.b_reference_code!r})"
                )
            if apply:
                print(
                    f"  -> reverted merge_log id(s): "
                    f"{list(report.reverted_merge_log_ids)}"
                )
    print()

    pd = report.pending_demotions
    print(
        f"Pending 'fuzzy' suggestions currently in the review queue: "
        f"{pd.total_pending_fuzzy}"
    )
    if pd.structured_fields_rule_available:
        print(
            f"  D-117 (type/rooms conflict, PR #567): "
            f"{pd.structured_fields_conflicts} would demote to 'rejected'"
        )
    else:
        print(
            "  D-117 (type/rooms conflict, PR #567): rule not present in "
            "this build yet — 0 counted"
        )
    print(
        f"  D-119 (municipality conflict, this issue): "
        f"{pd.municipality_conflicts} would demote to 'rejected'"
    )
    print(f"  Union (at least one rule fires): {pd.either}")
    print(
        "  These demote automatically on the NEXT `ps dedup run` (D-024's "
        "existing per-run pending re-evaluation) — this command does not "
        "trigger a full run."
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
    retroactive_parser = subparsers.add_parser(
        "retroactive",
        help=(
            "Issue #568: report (dry-run by default) what the D-116/D-117/"
            "D-119 hard vetoes would retroactively change; --apply reverts "
            "the D-116 merges"
        ),
    )
    retroactive_parser.add_argument(
        "--apply",
        action="store_true",
        help="Actually revert the D-116 merges (default: dry-run report only)",
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
        if args.subcommand == "retroactive":
            return _cmd_retroactive(conn, args.apply)
        return _cmd_resolve_conflict(conn, args.suggestion_id)
    finally:
        conn.close()


if __name__ == "__main__":
    sys.exit(main())
