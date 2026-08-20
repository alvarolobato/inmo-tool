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
    if result.vetoed_pending_resolved:
        # Issue #605 Part 2 revision (PR #611 review B1): same visibility
        # precedent — a pending row resolved this way never goes through
        # evaluate_pair either, so it's invisible in "Compared ..." above.
        print(
            f"Resolved {result.vetoed_pending_resolved} pending "
            f"suggestion(s) whose PROPERTY pair was vetoed by an earlier "
            f"rejection — marked rejected, no new merge performed."
        )
    if result.vetoed_pairs_skipped:
        # Issue #605 Part 2 revision (PR #611 second review, M-3): before
        # this counter existed, veto suppression was completely silent —
        # no counter, no log line, and nothing in the CLI or dashboard
        # ever read property_merge_veto. Skipped before evaluate_pair, so
        # invisible in "Compared ..." above by construction (same
        # same_source_skipped precedent below).
        print(
            f"Skipped {result.vetoed_pairs_skipped} pair(s) covered by a "
            f"property_merge_veto (issue #605 Part 2 — a human rejected "
            f"that property pair). Use `ps dedup unveto <id> <id>` to "
            f"undo one."
        )
    if result.vetoed_merge_refused:
        # Issue #605 Part 2 revision (PR #611 second review, M-1): the
        # rare race — a veto committed by a concurrent action after this
        # pair's evaluation had already started. Refused correctly, run
        # continued; surfaced here so an operator can tell "the pass
        # skipped some vetoed work" (expected, silent-by-design in
        # vetoed_pairs_skipped above) apart from "the pass hit a live
        # race" (worth a glance, not an error).
        print(
            f"WARNING: {result.vetoed_merge_refused} merge attempt(s) "
            f"refused mid-run by a property_merge_veto committed by a "
            f"concurrent action (race, not an error) — those pairs will "
            f"be swept to 'rejected' on the next run."
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


def _cmd_reject_pair(conn, suggestion_id: int) -> int:
    """`ps dedup reject-pair <id>` — issue #605 Part 2 revision (PR #611
    review B1). Rejects the whole PROPERTY pair behind `suggestion_id`,
    not just that one listing pair — see `engine.reject_property_pair`'s
    docstring for why the plain per-listing reject above isn't enough."""
    try:
        count = engine.reject_property_pair(conn, suggestion_id)
    except ValueError as exc:
        print(f"reject-pair failed: {exc}", file=sys.stderr)
        return 1
    print(
        f"Rejected the property pair behind suggestion {suggestion_id} "
        f"({count} pending suggestion(s) marked rejected) — permanently "
        "vetoed from future merge/suggestion."
    )
    return 0


def _cmd_unveto(conn, property_id_a: int, property_id_b: int) -> int:
    """`ps dedup unveto <id> <id>` — issue #605 Part 2 revision (PR #611
    second review, M-2). Undoes a `property_merge_veto` — the only way to
    clear one, since it never expires on its own. Ids in either order —
    see `engine.remove_property_veto`'s docstring for why."""
    deleted = engine.remove_property_veto(conn, property_id_a, property_id_b)
    if deleted:
        print(
            f"Removed the veto between properties {property_id_a} and "
            f"{property_id_b} — they can be suggested/auto-merged again "
            "on a future dedup run."
        )
    else:
        print(
            f"No veto existed between properties {property_id_a} and "
            f"{property_id_b} — nothing to remove."
        )
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


def _confirm(prompt: str) -> bool:
    """Interactive y/N confirmation for a destructive one-off migration
    (issue #607/S1). Anything other than an explicit y/yes — including no
    stdin at all (EOFError for a closed/exhausted stdin; OSError for a
    non-interactive stream that refuses reads outright, e.g. pytest's
    captured-output stdin substitute) — is a refusal, never a default-yes.
    """
    try:
        answer = input(f"{prompt} [y/N] ")
    except (EOFError, OSError):
        return False
    return answer.strip().lower() in ("y", "yes")


def _cmd_purge_phone(conn, dry_run: bool = False, yes: bool = False) -> int:
    """One-off migration companion for issue #603 (`ps dedup purge-phone`):
    delete remaining `pending` `match_basis='phone'` rows at confidence
    0.500 — run once, after the reordered/silenced signal has had a chance
    to reevaluate the existing backlog on its own (see
    `engine.purge_pending_phone`'s docstring for why this should normally
    find nothing left, and for why it's scoped to 0.500 — issue #607/B3:
    an unscoped delete would also take any 0.750 corroborated-unconfirmed-
    kind row filed since deploy, which D-131 deliberately keeps)."""
    if dry_run:
        would_delete, would_keep = engine.preview_purge_pending_phone(conn)
        print(
            f"[dry-run] Would purge {would_delete} pending phone "
            f"suggestion(s) at confidence 0.500; would keep {would_keep} "
            "corroborated (confidence != 0.500) row(s) untouched (issue "
            "#603 one-off migration)."
        )
        return 0
    if not yes and not _confirm(
        "This will permanently DELETE pending phone suggestions at "
        "confidence 0.500. Continue?"
    ):
        print("Aborted (no changes made). Pass --yes to skip this prompt.")
        return 1
    deleted = engine.purge_pending_phone(conn)
    print(
        f"Purged {deleted} pending phone suggestion(s) at confidence 0.500 "
        "(issue #603 one-off migration)."
    )
    return 0


def _cmd_purge_fuzzy(conn, dry_run: bool = False, yes: bool = False) -> int:
    """One-off migration companion for issue #601 (`ps dedup purge-fuzzy`):
    delete pending `match_basis='fuzzy'` rows EXCEPT the rescue set (exact
    m2_built+current_price, corroborated by shared photo evidence or a
    near-identical description) — see `engine.purge_pending_fuzzy`'s
    docstring for exactly what qualifies.

    Aborts (issue #607/B2) rather than purging when the persistent
    photo-hash store is unreachable — see
    `engine.PhotoHashStoreUnavailableError`."""
    try:
        if dry_run:
            would_delete, would_rescue = engine.preview_purge_pending_fuzzy(conn)
            print(
                f"[dry-run] Would purge {would_delete} pending fuzzy "
                f"suggestion(s), would rescue {would_rescue} corroborated "
                "pair(s) (issue #601 one-off migration)."
            )
            return 0
        if not yes and not _confirm(
            "This will permanently DELETE pending fuzzy suggestions except "
            "the corroborated rescue set. Continue?"
        ):
            print("Aborted (no changes made). Pass --yes to skip this prompt.")
            return 1
        deleted, rescued = engine.purge_pending_fuzzy(conn)
    except engine.PhotoHashStoreUnavailableError as exc:
        print(f"ABORTED: {exc}", file=sys.stderr)
        return 1
    print(
        f"Purged {deleted} pending fuzzy suggestion(s), rescued {rescued} "
        "corroborated pair(s) (issue #601 one-off migration)."
    )
    return 0


def _cmd_backfill_matched_photos(conn, dry_run: bool = False, yes: bool = False) -> int:
    """One-off migration (issue #615, supersedes the separately-filed #622):
    populate `detail.matched_photos` on pending `photo_hash`
    suggested_merge rows filed before #615's `matched_pairs` landed —
    read-only against the persistent photo_hashes store, never a live
    fetch. See `engine.backfill_matched_photos`'s docstring for exactly
    what it does and does not touch (status/confidence/match_basis are
    never modified).

    Aborts rather than writing anything when the persistent photo-hash
    store is unreachable — see `engine.PhotoHashStoreUnavailableError`."""
    try:
        if dry_run:
            scanned, would_update = engine.preview_backfill_matched_photos(conn)
            print(
                f"[dry-run] Would add detail.matched_photos to {would_update} "
                f"of {scanned} pending photo_hash suggestion(s) (issue #615 "
                "backfill, read-only against the photo_hashes store)."
            )
            return 0
        if not yes and not _confirm(
            "This will add detail.matched_photos to pending photo_hash "
            "suggestions (status, confidence and match_basis are never "
            "changed). Continue?"
        ):
            print("Aborted (no changes made). Pass --yes to skip this prompt.")
            return 1
        scanned, updated = engine.backfill_matched_photos(conn)
    except engine.PhotoHashStoreUnavailableError as exc:
        print(f"ABORTED: {exc}", file=sys.stderr)
        return 1
    print(
        f"Added detail.matched_photos to {updated} of {scanned} pending "
        "photo_hash suggestion(s) (issue #615 backfill)."
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
    reject_pair_parser = subparsers.add_parser(
        "reject-pair",
        help=(
            "Reject the whole PROPERTY pair behind a suggested_merge row "
            "(issue #605 Part 2 revision, PR #611 review B1) — permanent, "
            "vetoes every listing combination between the two properties"
        ),
    )
    reject_pair_parser.add_argument("suggestion_id", type=int)
    unveto_parser = subparsers.add_parser(
        "unveto",
        help=(
            "Undo a property_merge_veto between two property ids "
            "(issue #605 Part 2 revision, PR #611 second review, M-2) — "
            "the only way to clear one, since it never expires on its own"
        ),
    )
    unveto_parser.add_argument("property_id_a", type=int)
    unveto_parser.add_argument("property_id_b", type=int)
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
    purge_phone_parser = subparsers.add_parser(
        "purge-phone",
        help=(
            "One-off migration (issue #603): delete remaining pending "
            "match_basis='phone' suggested_merge rows at confidence 0.500"
        ),
    )
    purge_phone_parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Print (would_delete, would_keep) without deleting anything",
    )
    purge_phone_parser.add_argument(
        "--yes",
        action="store_true",
        help="Skip the interactive confirmation prompt",
    )
    purge_fuzzy_parser = subparsers.add_parser(
        "purge-fuzzy",
        help=(
            "One-off migration (issue #601): delete pending "
            "match_basis='fuzzy' suggested_merge rows, except the "
            "corroborated rescue set"
        ),
    )
    purge_fuzzy_parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Print (would_delete, would_rescue) without deleting anything",
    )
    purge_fuzzy_parser.add_argument(
        "--yes",
        action="store_true",
        help="Skip the interactive confirmation prompt",
    )
    backfill_matched_photos_parser = subparsers.add_parser(
        "backfill-matched-photos",
        help=(
            "One-off migration (issue #615): add detail.matched_photos to "
            "pending photo_hash suggested_merge rows filed before #615, "
            "read-only against the photo_hashes store"
        ),
    )
    backfill_matched_photos_parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Print (scanned, would_update) without writing anything",
    )
    backfill_matched_photos_parser.add_argument(
        "--yes",
        action="store_true",
        help="Skip the interactive confirmation prompt",
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
        if args.subcommand == "reject-pair":
            return _cmd_reject_pair(conn, args.suggestion_id)
        if args.subcommand == "unveto":
            return _cmd_unveto(conn, args.property_id_a, args.property_id_b)
        if args.subcommand == "process-actions":
            return _cmd_process_actions(conn)
        if args.subcommand == "purge-same-source":
            return _cmd_purge_same_source(conn)
        if args.subcommand == "purge-phone":
            return _cmd_purge_phone(conn, dry_run=args.dry_run, yes=args.yes)
        if args.subcommand == "purge-fuzzy":
            return _cmd_purge_fuzzy(conn, dry_run=args.dry_run, yes=args.yes)
        if args.subcommand == "backfill-matched-photos":
            return _cmd_backfill_matched_photos(
                conn, dry_run=args.dry_run, yes=args.yes
            )
        return _cmd_resolve_conflict(conn, args.suggestion_id)
    finally:
        conn.close()


if __name__ == "__main__":
    sys.exit(main())
