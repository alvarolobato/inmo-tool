"""Generate ``DECISIONS.md`` from the per-decision files' frontmatter.

Issue #352. ``DECISIONS.md`` used to be hand-maintained: every PR that recorded
a decision appended a row to the single shared index, so any two in-flight PRs
conflicted on that file and landing N PRs cost ~N sequential rebases. The
decision-ID allocator (#349 / D-077) fixed *ID* uniqueness but not the
*file-level append conflict*.

The fix: make the index a pure projection of the per-decision records. Each
``docs/decisions/D-NNN-<slug>.md`` file carries, in its YAML frontmatter, the
binding-rule one-liner (``rule:``) and the group it belongs to (``group:``).
This module renders the grouped tables from those files. A new decision now
only ADDS its own ``D-NNN-*.md`` file (unique filename — no cross-PR line
collision) and regenerates; ``DECISIONS.md`` is never hand-edited.

A file participates in the index iff its frontmatter carries BOTH a non-empty
``group`` and a non-empty ``rule``. Retired decisions (which drop those fields
and keep only a ``## STATUS: retired`` marker in the body) are excluded
automatically — same effect as the old "remove its row from DECISIONS.md".

Ordering
--------
* Groups are ordered by the smallest ``order`` among their members (ties broken
  by the smallest decision id), so the group a decision lands in follows its
  records rather than a hand-maintained list in code.
* Rows within a group are ordered by (``order``, id).
* ``order`` is OPTIONAL. The migration (#352) stamped an explicit ``order`` on
  every pre-existing record to reproduce the hand-curated sequence byte-for-
  byte. A NEW record can simply omit it: order-less records sort *after* all
  explicitly-ordered ones, by id — i.e. a new decision appends to the end of
  its group with no coordination needed. Set ``order`` only to force a specific
  position.

The companion drift guard (``scripts/tests/test_decisions_index_fresh.py``,
mirroring the ``knowledge.ts`` guard) regenerates and asserts
``git diff --exit-code DECISIONS.md`` so a stale checked-in index fails CI.
"""

from __future__ import annotations

import re
from pathlib import Path

import yaml

REPO_ROOT = Path(__file__).resolve().parents[1]
DECISIONS_DIR = REPO_ROOT / "docs" / "decisions"
INDEX_PATH = REPO_ROOT / "DECISIONS.md"

# Sentinel: records without an explicit ``order`` sort after every ordered one.
UNORDERED = float("inf")

# The fixed prose at the top of the index. Everything below it is generated.
# Kept here (not in a data file) so the generator is the single source of the
# rendered document, mirroring how ``build-knowledge.ts`` embeds its shell.
PREAMBLE = """# DECISIONS.md — Decision index

> **Purpose.** One-line binding rules so agents don't re-evaluate settled decisions. Full rationale, alternatives, and incident context live in `docs/decisions/D-NN-<slug>.md` — read those when you need the *why*.
>
> **This file is generated.** Do not hand-edit it. To record a decision, add a `docs/decisions/D-NNN-<slug>.md` file (pick the id with `scripts/next-decision-id.py`) carrying `rule:` and `group:` in its frontmatter, then run `python3 scripts/build-decisions-index.py`. See [AGENTS.md § Recording decisions](AGENTS.md#recording-decisions).
>
> Entries are kept terse on purpose. The one-liner lives in each record's `rule:` frontmatter; expand the reasoning in the per-decision file, never here.
>
> **On the `archive/` directory**: this repo was bootstrapped from powershop-analytics, a 4D/PowerShop retail-analytics project with no relevance to inmo-tool's actual domain (real-estate investment sourcing). Its decision history (`docs/decisions/archive/D-0XX-*.md`) is kept for git archaeology — some of those decisions' *reasoning* still applies here and has been re-recorded fresh below (at new IDs, re-read rather than copied verbatim) — but none of the archived files themselves are active for this project."""

_FILENAME_RE = re.compile(r"^(D-(\d+))-[A-Za-z0-9-]+\.md$")
# A `|` inside a `rule:` value ends the GFM table cell it is rendered into, so
# everything after it silently vanishes from the index every session loads.
# D-152 shipped that way: its rule read "(`"all"` default | non-empty ...)" and
# the rendered row lost the enforcement point, the D-055 intersection and the
# precedence clause — while the drift guard stayed green, because the file WAS
# what the generator produced. The convention (D-079) is to escape it as `\|`;
# this matches any `|` not already escaped.
_UNESCAPED_PIPE_RE = re.compile(r"(?<!\\)\|")
_ID_NUM_RE = re.compile(r"^D-(\d+)$")


def parse_frontmatter(text: str) -> dict:
    """Return the YAML frontmatter block of a decision file as a dict.

    Returns ``{}`` when there is no leading ``---`` fenced block or it doesn't
    parse to a mapping.
    """
    if not text.startswith("---"):
        return {}
    parts = text.split("---", 2)
    if len(parts) < 3:
        return {}
    try:
        data = yaml.safe_load(parts[1])
    except yaml.YAMLError as exc:
        # Do NOT swallow this. A record whose frontmatter fails to parse used to
        # be dropped from the index in silence, and the drift guard could not
        # catch it: the generator's output stays self-consistent with its own
        # omission, so `--check` says "up to date" while a binding rule is
        # missing from the file every session loads. That is exactly how D-043,
        # D-105, D-106 and D-107 went missing — each `rule:` began with a
        # backtick, which a YAML plain scalar may not do (reserved indicator).
        raise ValueError(
            f"Unparseable YAML frontmatter: {exc}. "
            "Quote the `rule:` value: a YAML plain scalar may not start with a "
            "reserved indicator (` @ % & * ! | > { } [ ] , # ? : -) nor contain "
            "a colon followed by a space."
        ) from exc
    return data if isinstance(data, dict) else {}


def _id_num(decision_id: str) -> int:
    m = _ID_NUM_RE.match(decision_id or "")
    return int(m.group(1)) if m else 0


def load_record(path: Path) -> dict | None:
    """Build an index record from a decision file, or ``None`` to exclude it.

    A file is included iff its frontmatter has a non-empty ``group`` and a
    non-empty ``rule``. The filename supplies the link target and (as a
    fallback / cross-check) the id.
    """
    m = _FILENAME_RE.match(path.name)
    if not m:
        return None
    fm = parse_frontmatter(path.read_text(encoding="utf-8"))

    group = fm.get("group")
    rule = fm.get("rule")
    if not isinstance(group, str) or not group.strip():
        return None
    if not isinstance(rule, str) or not rule.strip():
        return None
    if _UNESCAPED_PIPE_RE.search(rule):
        # Loud, not silent: an unescaped pipe truncates the rendered row and
        # the drift guard cannot see it (the index still matches generator
        # output). Raising here fails both the build and `--check`.
        raise ValueError(
            f"{path.name}: `rule:` contains an unescaped '|', which would end "
            "its DECISIONS.md table cell and silently drop everything after "
            "it. Escape it as '\\|' (see D-079) or reword to avoid the pipe. "
            "Note: '\\|' is only valid inside a SINGLE-quoted YAML scalar — "
            "in a double-quoted one it is an unknown escape and fails to "
            "parse."
        )

    decision_id = fm.get("id") if isinstance(fm.get("id"), str) else m.group(1)
    order = fm.get("order")
    order_val: float
    if isinstance(order, bool) or not isinstance(order, (int, float)):
        order_val = UNORDERED
    else:
        order_val = float(order)

    return {
        "id": decision_id,
        "id_num": _id_num(decision_id),
        "filename": path.name,
        "group": group.strip(),
        "rule": rule.strip(),
        "order": order_val,
    }


def collect_records(decisions_dir: Path = DECISIONS_DIR) -> list[dict]:
    """All included records, unsorted."""
    records = []
    for path in sorted(decisions_dir.glob("D-*.md")):
        if not path.is_file():
            continue
        rec = load_record(path)
        if rec is not None:
            records.append(rec)
    return records


def _grouped(records: list[dict]) -> list[tuple[str, list[dict]]]:
    """Group records and order both the groups and the rows within them."""
    groups: dict[str, list[dict]] = {}
    for rec in records:
        groups.setdefault(rec["group"], []).append(rec)

    def row_key(rec: dict) -> tuple[float, int]:
        return (rec["order"], rec["id_num"])

    def group_key(item: tuple[str, list[dict]]) -> tuple[float, int, str]:
        name, recs = item
        return (
            min(r["order"] for r in recs),
            min(r["id_num"] for r in recs),
            name,
        )

    ordered = []
    for name, recs in sorted(groups.items(), key=group_key):
        ordered.append((name, sorted(recs, key=row_key)))
    return ordered


def render(records: list[dict]) -> str:
    """Render the full ``DECISIONS.md`` text (preamble + grouped tables)."""
    sections = []
    for name, recs in _grouped(records):
        lines = [f"## {name}", "", "| ID | Binding rule |", "|----|--------------|"]
        for rec in recs:
            link = f"docs/decisions/{rec['filename']}"
            row = f"| [{rec['id']}]({link}) | {rec['rule']} |"
            # Defence in depth behind load_record's `rule:` check: assert the
            # row GFM will actually parse has exactly the 2 cells this table
            # declares, whatever the pipe came from (rule, id or filename).
            # 2 cells == 3 unescaped delimiters: leading, separator, trailing.
            n_delims = len(_UNESCAPED_PIPE_RE.findall(row))
            if n_delims != 3:
                raise ValueError(
                    f"{rec['filename']}: renders a {n_delims - 1}-cell table "
                    f"row, expected 2 (| ID | Binding rule |). An unescaped "
                    f"'|' would make GFM drop the trailing cells. Row: {row!r}"
                )
            lines.append(row)
        sections.append("\n".join(lines))
    return PREAMBLE + "\n\n" + "\n\n".join(sections) + "\n"


def generate(decisions_dir: Path = DECISIONS_DIR) -> str:
    return render(collect_records(decisions_dir))


def write_index(index_path: Path = INDEX_PATH) -> str:
    text = generate()
    index_path.write_text(text, encoding="utf-8")
    return text
