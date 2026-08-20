#!/usr/bin/env bash
# ps dedup — the deduplication engine (task 2.2, #16)
set -e

REPO_ROOT="${REPO_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"

RED='\033[0;31m'
CYAN='\033[0;36m'
NC='\033[0m'

# Same array-not-string reasoning as cli/commands/connector.sh.
DC=(docker compose -f "${REPO_ROOT}/docker-compose.yml")

usage() {
    cat <<EOF
Usage: ps dedup <subcommand> [args]

Subcommands:
  run                     Run the dedup engine once (compare listings, merge/suggest)
  status                  Show the most recent dedup_runs rows (issue #185)
  revert <id>             Undo one auto-merge by its property_merge_log id
  suggestions             List pending suggested_merge rows for human review
  confirm <id>            Merge the pair behind a suggested_merge row
  reject <id>             Mark a suggestion as not-the-same-property
  reject-pair <id>        Reject the whole PROPERTY pair behind a suggestion
                          (issue #605 Part 2 revision) — permanently vetoes
                          every listing combination between the two
                          properties, not just this one suggested_merge row
  resolve-conflict <id>   Clear a merge-time state conflict flag
  process-actions         Drain pending dashboard review-queue confirm/reject
                          requests once (the long-running container drains
                          these automatically on a 3s poll — this is the
                          manual/one-shot equivalent)
  purge-same-source       One-off migration (issue #197): delete pending
                          same-source suggested_merge rows
  purge-phone [--dry-run] [--yes]
                          One-off migration (issue #603/D-131): delete
                          remaining pending match_basis='phone' rows at
                          confidence 0.500 (the 0.750 corroborated tier is
                          kept). --dry-run prints (would_delete, would_keep)
                          without deleting; otherwise prompts for
                          confirmation unless --yes is passed.
  purge-fuzzy [--dry-run] [--yes]
                          One-off migration (issue #601/D-130): delete
                          pending match_basis='fuzzy' rows except the
                          corroborated rescue set. Aborts (no changes) if
                          the photo-hash store is unreachable. --dry-run
                          prints (would_delete, would_rescue) without
                          deleting; otherwise prompts for confirmation
                          unless --yes is passed.

  Review workflow: 'suggestions' lists what needs a human decision, then
  'confirm' or 'reject' each by its id. A row listed with status 'conflict'
  is a merge that already happened but left clashing per-profile state —
  inspect it, then 'resolve-conflict' to clear the flag.

  'status' is what makes a dedup pass that ran-and-found-nothing
  distinguishable from a dedup pass that never ran at all (issue #185's
  root cause) — every connector sweep now runs dedup automatically
  afterward (trigger != 'cli-manual'), so this should never show a large
  gap since the last connector_runs row.
EOF
}

# Mirrors cli/commands/connector.sh's _run_in_etl — same exec-vs-run
# fallback reasoning, duplicated rather than shared since each command file
# in this repo owns its own copy (see cli/commands/db.sh, connector.sh).
_run_in_etl() {
    if "${DC[@]}" ps --status running --quiet etl 2>/dev/null | grep -q .; then
        "${DC[@]}" exec -T etl "$@"
    else
        "${DC[@]}" run --rm etl "$@"
    fi
}

cmd_run() {
    echo -e "${CYAN}Running dedup engine...${NC}"
    _run_in_etl python -m etl.dedup.cli run
}

cmd_revert() {
    local id="${1:-}"
    if [ -z "$id" ]; then
        echo -e "${RED}ps dedup revert: missing <id>${NC}" >&2
        usage >&2
        exit 1
    fi
    _run_in_etl python -m etl.dedup.cli revert "$id"
}

cmd_status() {
    "${DC[@]}" exec -T postgres psql \
        -U "${POSTGRES_USER:-postgres}" \
        -d "${POSTGRES_DB:-inmotool}" \
        -v ON_ERROR_STOP=1 \
        -c "SELECT id, trigger, connector_run_id, status, pairs_compared, merged, suggested, conflicts, to_char(started_at, 'YYYY-MM-DD HH24:MI') AS started_at, duration_ms, left(error_msg, 80) AS error_msg FROM dedup_runs ORDER BY started_at DESC LIMIT 20"
}

cmd_suggestions() {
    "${DC[@]}" exec -T postgres psql \
        -U "${POSTGRES_USER:-postgres}" \
        -d "${POSTGRES_DB:-inmotool}" \
        -v ON_ERROR_STOP=1 \
        -c "SELECT id, listing_id_a, listing_id_b, match_basis, confidence, status, detail, created_at FROM suggested_merge WHERE status IN ('pending','conflict') ORDER BY created_at DESC"
}

# confirm/reject/resolve-conflict all take a single suggested_merge id and
# differ only in which engine entry point they call, so they share one body.
_cmd_with_suggestion_id() {
    local subcmd="$1"
    local id="${2:-}"
    if [ -z "$id" ]; then
        echo -e "${RED}ps dedup ${subcmd}: missing <id>${NC}" >&2
        usage >&2
        exit 1
    fi
    _run_in_etl python -m etl.dedup.cli "$subcmd" "$id"
}

cmd_process_actions() {
    _run_in_etl python -m etl.dedup.cli process-actions
}

cmd_purge_same_source() {
    _run_in_etl python -m etl.dedup.cli purge-same-source
}

# purge-phone/purge-fuzzy both just forward their flags (--dry-run/--yes)
# straight through to the Python subcommand, which does the real argparse
# validation — this wrapper's only job is to exist so `ps dedup purge-*`
# is a real, wired-up command (issue #607/S2) instead of only reachable via
# `python -m etl.dedup.cli` inside the container.
cmd_purge_phone() {
    _run_in_etl python -m etl.dedup.cli purge-phone "$@"
}

cmd_purge_fuzzy() {
    _run_in_etl python -m etl.dedup.cli purge-fuzzy "$@"
}

SUBCMD="${1:-}"
if [ -z "$SUBCMD" ] || [ "$SUBCMD" = "-h" ] || [ "$SUBCMD" = "--help" ]; then
    usage
    exit 0
fi
shift

case "$SUBCMD" in
    run)              cmd_run ;;
    status)           cmd_status ;;
    revert)           cmd_revert "$@" ;;
    suggestions)      cmd_suggestions ;;
    confirm)          _cmd_with_suggestion_id confirm "$@" ;;
    reject)           _cmd_with_suggestion_id reject "$@" ;;
    reject-pair)      _cmd_with_suggestion_id reject-pair "$@" ;;
    resolve-conflict) _cmd_with_suggestion_id resolve-conflict "$@" ;;
    process-actions)  cmd_process_actions ;;
    purge-same-source) cmd_purge_same_source ;;
    purge-phone)      cmd_purge_phone "$@" ;;
    purge-fuzzy)      cmd_purge_fuzzy "$@" ;;
    *)
        echo -e "${RED}ps dedup: unknown subcommand '${SUBCMD}'${NC}" >&2
        usage >&2
        exit 1
        ;;
esac
