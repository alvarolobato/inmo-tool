"""Unit tests for the decision-id allocator (issues #203 / #229).

Covers the pure allocation logic, the ``gh``-backed open-PR scan (mocked), and
the graceful offline fallback — no network is touched here.
"""

import sys
from pathlib import Path

SCRIPTS_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SCRIPTS_DIR))

import decision_ids as di


# --------------------------------------------------------------------------- #
# Pure id helpers
# --------------------------------------------------------------------------- #
def test_id_num_and_format():
    assert di.id_num("D-073-below-market.md") == 73
    assert di.id_num("D-007-foo.md") == 7
    assert di.id_num("README.md") is None
    assert di.id_num("D-abc-foo.md") is None
    assert di.format_id(73) == "D-073"
    assert di.format_id(7) == "D-007"


def test_parse_ids_ignores_non_matching():
    names = ["D-001-a.md", "D-010-b.md", "notes.md", "D-010-dup.md", "archive"]
    assert di.parse_ids(names) == {1, 10}


def test_next_free_id_is_max_plus_one_not_gap_fill():
    # Convention is max+1 (never reuse retired gaps), so a hole at 31 stays a hole.
    assert di.next_free_id({1, 2, 30, 32}) == 33
    assert di.next_free_id({68}, {72, 76}) == 77
    assert di.next_free_id(set()) == 1
    assert di.next_free_id(set(), start=5) == 5


def test_local_decision_ids_reads_dir(tmp_path):
    d = tmp_path / "decisions"
    d.mkdir()
    (d / "D-001-a.md").write_text("x")
    (d / "D-042-b.md").write_text("x")
    (d / "DECISIONS-note.md").write_text("x")  # not a D-NNN file
    sub = d / "archive"
    sub.mkdir()
    (sub / "D-999-old.md").write_text(
        "x"
    )  # archive not globbed by glob('D-*.md') top-level
    assert di.local_decision_ids(d) == {1, 42}


def test_local_decision_ids_missing_dir(tmp_path):
    assert di.local_decision_ids(tmp_path / "nope") == set()


# --------------------------------------------------------------------------- #
# open_pr_decision_ids — gh mocked
# --------------------------------------------------------------------------- #
def _fake_gh(pr_list_json, branch_contents):
    """Build a fake _run_gh returning canned pr-list + per-branch contents."""

    def fake(args, timeout=30):
        if args[:2] == ["pr", "list"]:
            return pr_list_json
        if args and args[0] == "repo":
            return "alvarolobato/inmo-tool\n"
        if args and args[0] == "api":
            ref = args[1].split("ref=")[-1]
            if ref not in branch_contents:
                raise di.GhUnavailable(f"404 no decisions on {ref}")
            return "\n".join(branch_contents[ref]) + "\n"
        raise AssertionError(f"unexpected gh args: {args}")

    return fake


def test_open_pr_decision_ids_happy_path(monkeypatch):
    pr_list = (
        '[{"number": 348, "headRefName": "feat/x"},'
        ' {"number": 347, "headRefName": "feat/y"}]'
    )
    contents = {
        "feat/x": ["D-073-a.md", "D-076-b.md", "notes.md"],
        "feat/y": ["D-071-c.md", "D-072-d.md"],
    }
    monkeypatch.setattr(di, "_run_gh", _fake_gh(pr_list, contents))
    result = di.open_pr_decision_ids()
    assert result == {
        348: ("feat/x", {73, 76}),
        347: ("feat/y", {71, 72}),
    }


def test_open_pr_decision_ids_excludes_own_branch(monkeypatch):
    pr_list = (
        '[{"number": 1, "headRefName": "mine"}, {"number": 2, "headRefName": "other"}]'
    )
    contents = {"mine": ["D-050-a.md"], "other": ["D-051-b.md"]}
    monkeypatch.setattr(di, "_run_gh", _fake_gh(pr_list, contents))
    result = di.open_pr_decision_ids(exclude_branch="mine")
    assert 1 not in result
    assert result == {2: ("other", {51})}


def test_open_pr_decision_ids_branch_without_decisions_dir(monkeypatch):
    # A branch whose docs/decisions 404s is recorded with an empty claim set,
    # not dropped and not fatal.
    pr_list = '[{"number": 5, "headRefName": "bare"}]'
    monkeypatch.setattr(di, "_run_gh", _fake_gh(pr_list, {}))
    result = di.open_pr_decision_ids()
    assert result == {5: ("bare", set())}


def test_open_pr_decision_ids_offline_returns_none(monkeypatch):
    def boom(args, timeout=30):
        raise di.GhUnavailable("gh CLI not found on PATH")

    monkeypatch.setattr(di, "_run_gh", boom)
    assert di.open_pr_decision_ids() is None


def test_open_pr_decision_ids_bad_json_returns_none(monkeypatch):
    monkeypatch.setattr(di, "_run_gh", lambda args, timeout=30: "not json")
    assert di.open_pr_decision_ids() is None


# --------------------------------------------------------------------------- #
# CLI end-to-end (allocator picks max+1 across local + PR claims)
# --------------------------------------------------------------------------- #
def test_cli_allocates_across_prs(monkeypatch, tmp_path, capsys):
    import importlib.util

    d = tmp_path / "decisions"
    d.mkdir()
    (d / "D-068-x.md").write_text("x")
    monkeypatch.setattr(di, "DECISIONS_DIR", d)

    pr_list = '[{"number": 9, "headRefName": "b"}]'
    monkeypatch.setattr(
        di, "_run_gh", _fake_gh(pr_list, {"b": ["D-073-a.md", "D-076-b.md"]})
    )

    spec = importlib.util.spec_from_file_location(
        "next_decision_id", SCRIPTS_DIR / "next-decision-id.py"
    )
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    # The CLI imports helpers by name from decision_ids; patch those bindings too.
    monkeypatch.setattr(mod, "open_pr_decision_ids", di.open_pr_decision_ids)
    monkeypatch.setattr(mod, "local_decision_ids", lambda: di.local_decision_ids(d))

    rc = mod.main([])
    assert rc == 0
    out = capsys.readouterr().out.strip()
    assert out == "D-077"


def test_cli_offline_still_prints_local_id(monkeypatch, tmp_path, capsys):
    import importlib.util

    d = tmp_path / "decisions"
    d.mkdir()
    (d / "D-068-x.md").write_text("x")

    monkeypatch.setattr(
        di,
        "_run_gh",
        lambda *a, **k: (_ for _ in ()).throw(di.GhUnavailable("offline")),
    )

    spec = importlib.util.spec_from_file_location(
        "next_decision_id2", SCRIPTS_DIR / "next-decision-id.py"
    )
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    monkeypatch.setattr(mod, "open_pr_decision_ids", di.open_pr_decision_ids)
    monkeypatch.setattr(mod, "local_decision_ids", lambda: di.local_decision_ids(d))

    rc = mod.main([])
    assert rc == 0
    captured = capsys.readouterr()
    assert captured.out.strip() == "D-069"
    assert "could not reach GitHub" in captured.err
