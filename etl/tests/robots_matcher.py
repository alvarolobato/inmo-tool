"""A robots.txt matcher for tests, written against the documented spec.

Deliberately NOT `protego` (the library Scrapy uses). During issue #65's
spike, protego 0.5.0 reported the Fotocasa connector's own
already-working, demonstrably-200-serving URL as *disallowed*. Root cause:
its `_quote_pattern()` runs `urllib.parse.urlparse()` over the raw pattern
text, which silently swallows a literal `?` when nothing but `$` follows it
— so a rule like `/*/l?$` is parsed as `/*/l$` and then matches paths it
should not. Trusting it would have meant either "fixing" a non-bug in the
connector or dismissing the library's verdict by feel; neither is a sound
basis for a compliance assertion.

Implements the spec at
https://developers.google.com/search/docs/crawling-indexing/robots/robots_txt:
  - `*` matches any sequence of characters
  - a trailing `$` anchors to end-of-path
  - everything else, including `?` and `&`, is literal
  - the longest matching pattern wins; ties go to Allow
"""

from __future__ import annotations

import re
from urllib.parse import urlsplit


def _pattern_to_regex(pattern: str) -> re.Pattern[str]:
    end_anchor = pattern.endswith("$")
    body = pattern[:-1] if end_anchor else pattern
    parts = body.split("*")
    regex = "".join(re.escape(p) + ".*" for p in parts[:-1]) + re.escape(parts[-1])
    if end_anchor:
        regex += "$"
    return re.compile("^" + regex)


def load_star_block_rules(robots_txt: str) -> list[tuple[str, str]]:
    """Parse the `User-agent: *` block's allow/disallow rules, in order.

    Only the `*` block matters here: this connector identifies itself with a
    descriptive UA that matches no named block, so `*` is the block that
    governs it.
    """
    rules: list[tuple[str, str]] = []
    in_star_block = False
    for raw_line in robots_txt.splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or ":" not in line:
            continue
        field, _, value = line.partition(":")
        field = field.strip().lower()
        value = value.strip()
        if field == "user-agent":
            in_star_block = value == "*"
        elif field in ("disallow", "allow") and in_star_block:
            rules.append((field, value))
    return rules


def is_allowed(rules: list[tuple[str, str]], url: str) -> tuple[bool, str]:
    """Return (allowed, reason). Reason names the winning rule, for test output."""
    parts = urlsplit(url)
    target = parts.path or "/"
    if parts.query:
        target += "?" + parts.query
    best: tuple[int, str, str] | None = None
    for field, pattern in rules:
        if not pattern:
            # "Disallow:" with an empty value means allow-everything.
            continue
        if _pattern_to_regex(pattern).match(target):
            length = len(pattern)
            if (
                best is None
                or length > best[0]
                or (length == best[0] and field == "allow")
            ):
                best = (length, field, pattern)
    if best is None:
        return True, "no matching rule (default allow)"
    return best[1] == "allow", f"{best[1]} {best[2]!r} (len={best[0]})"
