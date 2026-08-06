"""Typed failure classification for connector run results (issue #242, D-079).

`connector_run_results.error_msg` has always been free text: the only way to
tell a soft-block backoff from a genuine parse break from a dead network was to
string-match prose, which nothing downstream could trend-analyze (issue #171).

This module turns the failure kinds the orchestrator ALREADY distinguishes at
write time into a small, queryable enum written to
`connector_run_results.failure_classification`. It is deliberately tiny and
pure (no DB, no I/O) so it is trivially unit-testable and reusable — the same
exception-classifier that runs live in `etl.orchestrator.run_all_connectors`
also backs the migration/backfill of historical rows conceptually (the SQL
backfill in init.sql mirrors `classify_error_message` below).

The taxonomy (see the column comment in etl/schema/init.sql for the authoritative
description):

    soft_block        site rate-throttling / bot-mitigation wall
    network           connection / timeout / DNS / TLS failure
    structure_change  parse / markup / JSON break, or a fatal circuit trip
    unresolvable      a profile centre matching no place in the gazetteer
    uncovered         the connector covers no target for this scope
    empty_result      ran cleanly but discovered nothing
    other             a fatal failure matching none of the above

`None` means "no notable failure signal" — a clean run that ingested data.
"""

from __future__ import annotations

# The full set of allowed values, mirroring the CHECK constraint in
# etl/schema/init.sql. `None` (a clean run) is always additionally allowed.
FAILURE_CLASSIFICATIONS: frozenset[str] = frozenset(
    {
        "soft_block",
        "network",
        "structure_change",
        "unresolvable",
        "uncovered",
        "empty_result",
        "other",
    }
)

# Substrings (lower-cased) that mark a fatal ConnectorError as a network-layer
# failure rather than a site-structure break. Kept as plain membership tests so
# this stays dependency-free and matches the SQL ILIKE backfill 1:1.
_NETWORK_MARKERS: tuple[str, ...] = (
    "timeout",
    "timed out",
    "connection",
    "could not connect",
    "refused",
    "unreachable",
    "reset by peer",
    "econnreset",
    "name resolution",
    "getaddrinfo",
    "dns",
    "ssl",
    "certificate",
    "network is unreachable",
)

# Substrings marking a fatal ConnectorError as a site-structure / parse break —
# the "go look at it, the markup changed" signal.
_STRUCTURE_MARKERS: tuple[str, ...] = (
    "parse",
    "json",
    "html",
    "selector",
    "marker",
    "nonetype",
    "keyerror",
    "attributeerror",
    "indexerror",
    "no such element",
    "structure",
    "decode",
    "unexpected",
    "missing",
)


def classify_fatal_exception(exc: BaseException) -> str:
    """Classify a *fatal* connector failure (a non-soft-block, non-unresolvable
    exception raised out of discover()/fetch_detail()/normalize()) into
    'network', 'structure_change', or 'other'.

    Soft-block (SoftBlockError) and unresolvable-geography
    (UnresolvableGeographyError) are handled at their own dedicated call sites
    in the orchestrator and never reach here — this only sees the generic
    fatal path.
    """
    text = f"{type(exc).__name__} {exc}".lower()
    if any(marker in text for marker in _NETWORK_MARKERS):
        return "network"
    if any(marker in text for marker in _STRUCTURE_MARKERS):
        return "structure_change"
    return "other"


def classify_error_message(status: str, error_msg: str | None) -> str | None:
    """Best-effort classification of an EXISTING row from its status + prose,
    for the one-time historical backfill (init.sql runs the SQL equivalent).

    Kept here as the single readable source of truth for the backfill's
    ordering/markers and so the migration logic is unit-testable in Python
    (the SQL CASE in init.sql mirrors this branch-for-branch). Returns None for
    rows that carry no failure signal (clean 'ok', 'skipped', or unclassifiable
    non-failures).
    """
    if status not in ("failed", "circuit_open"):
        return None
    msg = (error_msg or "").lower()
    if "unresolvable geography" in msg:
        return "unresolvable"
    if "resolved but uncovered" in msg or "no known coverage" in msg:
        return "uncovered"
    if (
        "bloqueo temporal" in msg
        or "rate-throttl" in msg
        or "soft-block" in msg
        or "presupuesto" in msg
    ):
        return "soft_block"
    if status == "circuit_open":
        return "structure_change"
    # status == 'failed' from here.
    if any(marker in msg for marker in _NETWORK_MARKERS):
        return "network"
    if any(marker in msg for marker in _STRUCTURE_MARKERS):
        return "structure_change"
    return "other"
