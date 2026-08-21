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


def test_unescaped_pipe_in_rule_is_rejected(tmp_path: Path) -> None:
    """A literal `|` in a rule would truncate its rendered table cell.

    Regression for D-152, which shipped with `(\\"all\\" default | non-empty ...)`
    in its `rule:`. GFM read the extra pipe as a third cell in a 2-column
    table and dropped everything after it, so the index every session loads
    lost the enforcement point, the D-055 intersection and the precedence
    clause. The drift guard could not catch it: the checked-in file WAS what
    the generator produced. So the generator itself has to refuse.
    """
    import pytest

    _write(
        tmp_path,
        "D-001-a.md",
        "id: D-001\ngroup: G\nrule: 'a | b'\norder: 1",
    )
    with pytest.raises(ValueError, match="unescaped"):
        di.collect_records(tmp_path)


def test_escaped_pipe_in_rule_is_accepted_and_renders_one_row(tmp_path: Path) -> None:
    """`\\|` is the supported way to put a pipe in a rule (the D-079 convention).

    Note it only parses inside a SINGLE-quoted YAML scalar — a double-quoted
    one treats `\\|` as an unknown escape and raises. That is the trap the
    first attempt at fixing D-152 fell into.
    """
    _write(
        tmp_path,
        "D-001-a.md",
        "id: D-001\ngroup: G\nrule: 'a \\| b'\norder: 1",
    )
    records = di.collect_records(tmp_path)
    assert records[0]["rule"] == "a \\| b"
    text = di.render(records)
    row = next(ln for ln in text.split("\n") if ln.startswith("| [D-001]"))
    assert row.endswith("| a \\| b |")
    # Exactly 2 cells: 3 unescaped delimiters (leading, separator, trailing).
    assert len(di._UNESCAPED_PIPE_RE.findall(row)) == 3


def test_every_real_record_renders_exactly_two_cells() -> None:
    """Repo-wide: no checked-in decision record may truncate its own row.

    The cell-count assertion lives in `render()`, so this just exercises the
    real corpus through it — a new record with a stray pipe fails here even if
    someone regenerates the index (which would keep the drift guard green).
    """
    text = di.generate()
    rows = [ln for ln in text.split("\n") if ln.startswith("| [D-")]
    assert rows, "generator produced no rows"
    for row in rows:
        assert len(di._UNESCAPED_PIPE_RE.findall(row)) == 3, (
            f"row does not render as exactly 2 cells: {row!r}"
        )
