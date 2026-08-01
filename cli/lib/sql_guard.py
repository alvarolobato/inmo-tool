"""Read-only guard for ad-hoc SQL sent to the production 4D ERP.

Single source of truth for the `ps sql query` safety check (AGENTS.md
"Read-only policy", issue #832). The previous guard was a `startswith`
keyword check, trivially bypassed by a leading comment (`/* x */ DELETE …`),
a line comment, or a second statement chained after a SELECT.

Strategy: scan the statement once, blanking string literals and removing
comments (so neither can hide or fake syntax), then enforce an ALLOWLIST —
exactly one statement, and it must start with SELECT. Allowlisting is the
only safe shape for this check: the 4D server is vendor-managed production
and we only ever read from it (decision D-001).
"""

from __future__ import annotations


def _normalize(sql: str) -> str | None:
    """Blank string literals and strip comments, preserving structure.

    Returns the normalized text, or None when a string literal or block
    comment is left unterminated (malformed input — reject upstream).

    Handles:
      - single-quoted strings with '' escapes (SQL standard, 4D included)
      - double-quoted identifiers
      - `--` line comments
      - `/* … */` block comments (non-nested, per SQL standard)
    """
    out: list[str] = []
    i = 0
    n = len(sql)
    while i < n:
        ch = sql[i]
        nxt = sql[i + 1] if i + 1 < n else ""
        if ch == "'":
            # String literal: skip to closing quote, honouring '' escapes.
            i += 1
            while i < n:
                if sql[i] == "'" and (i + 1 < n and sql[i + 1] == "'"):
                    i += 2
                    continue
                if sql[i] == "'":
                    break
                i += 1
            else:
                return None  # unterminated string
            out.append("''")  # keep a placeholder so token boundaries survive
            i += 1
        elif ch == '"':
            # Quoted identifier: skip to closing quote, honouring "" escapes
            # (standard SQL embeds a literal " in an identifier as "").
            i += 1
            while i < n:
                if sql[i] == '"' and (i + 1 < n and sql[i + 1] == '"'):
                    i += 2
                    continue
                if sql[i] == '"':
                    break
                i += 1
            else:
                return None  # unterminated identifier
            out.append('""')
            i += 1
        elif ch == "-" and nxt == "-":
            # Line comment: drop to end of line.
            end = sql.find("\n", i)
            if end == -1:
                break
            out.append(" ")
            i = end + 1
        elif ch == "/" and nxt == "*":
            # Block comment: drop to closing */.
            end = sql.find("*/", i + 2)
            if end == -1:
                return None  # unterminated block comment
            out.append(" ")
            i = end + 2
        else:
            out.append(ch)
            i += 1
    return "".join(out)


def validate_readonly_sql(sql: str) -> str | None:
    """Return an error message when *sql* is not a single read-only SELECT.

    Returns None when the statement is acceptable.
    """
    if not isinstance(sql, str) or not sql.strip():
        return "Empty SQL statement."

    normalized = _normalize(sql)
    if normalized is None:
        return "Malformed SQL: unterminated string literal or comment."

    stripped = normalized.strip()
    # A single trailing semicolon is tolerated; any other semicolon means a
    # second statement is being chained.
    body = stripped[:-1] if stripped.endswith(";") else stripped
    if ";" in body:
        return "Multiple SQL statements are not allowed (read-only mode)."

    tokens = body.split()
    if not tokens:
        return "Empty SQL statement."
    if tokens[0].lower() != "select":
        return (
            f"Only SELECT statements are allowed (read-only mode); "
            f"got {tokens[0].upper()!r}."
        )
    return None
