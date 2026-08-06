"""Unit tests for the DECISIONS.md generator (``scripts/decisions_index.py``).

These build synthetic ``docs/decisions/`` trees in ``tmp_path`` so the render
logic — frontmatter → table row, group ordering, within-group ordering,
retired/incomplete exclusion, order-less append — is tested in isolation from
the real repo (the freshness of which is covered by
``test_decisions_index_fresh.py``).
"""

import sys
from pathlib import Path

SCRIPTS_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SCRIPTS_DIR))

import decisions_index as di


def _write(dir_: Path, filename: str, frontmatter: str, body: str = "\nbody\n") -> None:
    dir_.mkdir(parents=True, exist_ok=True)
    (dir_ / filename).write_text(f"---\n{frontmatter}\n---{body}", encoding="utf-8")


def _fm(**fields) -> str:
    lines = []
    for k, v in fields.items():
        if isinstance(v, str):
            lines.append(f"{k}: {v!r}".replace("'", '"'))
        else:
            lines.append(f"{k}: {v}")
    return "\n".join(lines)


def test_single_record_renders_a_row(tmp_path: Path) -> None:
    _write(
        tmp_path,
        "D-001-alpha.md",
        _fm(id="D-001", group="Plumbing", rule="Do the thing.", order=1),
    )
    text = di.render(di.collect_records(tmp_path))
    assert "## Plumbing" in text
    # Build the expected link piecemeal so this test source doesn't itself
    # contain a literal decisions/D-NNN-slug.md path (test_decision_ids.py's
    # stale-cross-reference scanner would otherwise flag the synthetic file).
    link = "docs/" + "decisions/" + "D-001-alpha.md"
    assert f"| [D-001]({link}) | Do the thing. |" in text
    # Table header present exactly once for the one group.
    assert text.count("| ID | Binding rule |") == 1


def test_groups_ordered_by_min_order_not_alpha(tmp_path: Path) -> None:
    # "Zeta" has the smallest order so it must come before "Alpha".
    _write(tmp_path, "D-001-a.md", _fm(id="D-001", group="Alpha", rule="a", order=5))
    _write(tmp_path, "D-002-z.md", _fm(id="D-002", group="Zeta", rule="z", order=1))
    text = di.render(di.collect_records(tmp_path))
    assert text.index("## Zeta") < text.index("## Alpha")


def test_rows_within_group_ordered_by_order_then_id(tmp_path: Path) -> None:
    _write(
        tmp_path, "D-001-a.md", _fm(id="D-001", group="G", rule="first-id", order=20)
    )
    _write(
        tmp_path, "D-002-b.md", _fm(id="D-002", group="G", rule="low-order", order=10)
    )
    text = di.render(di.collect_records(tmp_path))
    # order 10 (D-002) must precede order 20 (D-001), despite id order.
    assert text.index("low-order") < text.index("first-id")


def test_orderless_records_append_after_ordered_by_id(tmp_path: Path) -> None:
    _write(tmp_path, "D-001-a.md", _fm(id="D-001", group="G", rule="explicit", order=1))
    # No `order` field: must sort AFTER the ordered one, and among themselves by id.
    _write(tmp_path, "D-050-b.md", _fm(id="D-050", group="G", rule="newer"))
    _write(tmp_path, "D-040-c.md", _fm(id="D-040", group="G", rule="older"))
    text = di.render(di.collect_records(tmp_path))
    assert text.index("explicit") < text.index("older") < text.index("newer")


def test_retired_record_excluded(tmp_path: Path) -> None:
    """A retired file keeps id/title but drops group+rule → not in the index."""
    _write(tmp_path, "D-001-live.md", _fm(id="D-001", group="G", rule="live", order=1))
    _write(
        tmp_path,
        "D-002-retired.md",
        _fm(id="D-002", title="old"),
        body="\n## STATUS: retired (2026-01-01) — superseded by D-001\n",
    )
    records = di.collect_records(tmp_path)
    ids = {r["id"] for r in records}
    assert ids == {"D-001"}
    assert "D-002" not in di.render(records)


def test_record_missing_rule_excluded(tmp_path: Path) -> None:
    _write(tmp_path, "D-001-a.md", _fm(id="D-001", group="G"))  # no rule
    _write(tmp_path, "D-002-b.md", _fm(id="D-002", rule="x"))  # no group
    assert di.collect_records(tmp_path) == []


def test_rule_with_special_chars_roundtrips(tmp_path: Path) -> None:
    """Backticks, quotes, colons, unicode in a rule survive frontmatter YAML."""
    import yaml

    rule = 'Gate on `x.type="flip"`; ARV = €/m² × m² — never a garbage number.'
    fm = yaml.safe_dump(
        {"id": "D-001", "group": "G", "rule": rule, "order": 1},
        default_flow_style=False,
        allow_unicode=True,
        width=10**9,
    ).rstrip("\n")
    _write(tmp_path, "D-001-a.md", fm)
    records = di.collect_records(tmp_path)
    assert len(records) == 1
    assert records[0]["rule"] == rule
    assert f"| {rule} |" in di.render(records)


def test_preamble_precedes_first_group(tmp_path: Path) -> None:
    _write(tmp_path, "D-001-a.md", _fm(id="D-001", group="G", rule="r", order=1))
    text = di.render(di.collect_records(tmp_path))
    assert text.startswith("# DECISIONS.md")
    assert text.index("# DECISIONS.md") < text.index("## G")
    assert text.endswith("\n")
