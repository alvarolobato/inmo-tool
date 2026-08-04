"""
Decision-record integrity checks.

Issue #203: six decision records landed on three colliding IDs (D-008, D-009,
D-010 each claimed twice) because parallel agents each branched from a `main`
where their chosen "next free ID" was, at that moment, genuinely free. Git
cannot see the collision — the two files differ only in their filename slug,
so they merge with no conflict marker. Nothing in the test suite read the
decision index, so it shipped silently; a human happened to notice two D-010s
while reviewing an unrelated merge.

This module is the detector. It asserts, from the files on disk, that:

1. No two `docs/decisions/D-*.md` files claim the same ID (by filename).
2. Every file's YAML frontmatter `id:` matches its filename's ID.
3. Every `docs/decisions/D-NNN-*.md` link in `DECISIONS.md` resolves to a
   real file.
4. Every `docs/decisions/(archive/)?D-NNN-*.md`-shaped path referenced
   anywhere else in the repo (docs, code comments, SQL, shell scripts —
   excluding `docs/decisions/archive/` itself, which is frozen source-project
   history per AGENTS.md and not rewritten) resolves to a real file.
   Renumbering a decision (as #205, #209, #213 all did, immediately after
   this issue was filed) silently strips out from under any reference that
   quoted the old filename — this caught five such cases the first time it
   ran, all pre-existing on `main`.

Run: pytest scripts/tests/test_decision_ids.py -v
"""

import re
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
DECISIONS_DIR = REPO_ROOT / "docs" / "decisions"
DECISIONS_INDEX = REPO_ROOT / "DECISIONS.md"

# Matches the ID + slug out of a decision filename, e.g.
# "D-014-comparable-rent-estimator.md" -> id="D-014", slug="comparable-rent-estimator"
FILENAME_RE = re.compile(r"^(D-\d+)-([A-Za-z0-9-]+)\.md$")

# Matches the frontmatter `id:` line inside a decision file.
FRONTMATTER_ID_RE = re.compile(r"^id:\s*(D-\d+)\s*$", re.MULTILINE)

# Matches any path-shaped reference to a decision file, active or archived,
# found anywhere in the repo (docs, code comments, SQL, shell). Deliberately
# permissive about the path prefix (`docs/decisions/...` vs a relative
# `../decisions/...` or `decisions/...` from inside docs/) since real
# references in this repo use all three forms.
DECISION_REF_RE = re.compile(
    r"([\w./-]*decisions/(?:archive/)?D-\d+-[A-Za-z0-9-]+\.md)"
)

# File types worth scanning for stray decision-file references.
REFERENCING_EXTS = {".py", ".ts", ".tsx", ".md", ".sql", ".sh", ".yml", ".yaml"}

# Directories never worth walking into.
SKIP_DIR_NAMES = {
    "node_modules",
    ".git",
    ".next",
    "dist",
    "build",
    "__pycache__",
    ".venv",
}


def _active_decision_files() -> list[Path]:
    """All D-*.md files directly under docs/decisions/ (not the archive/ subdir)."""
    return sorted(p for p in DECISIONS_DIR.glob("D-*.md") if p.is_file())


def test_no_duplicate_decision_ids() -> None:
    """
    Two files claiming the same D-NNN id (e.g. D-010-foo.md and D-010-bar.md)
    is exactly the #203 failure mode: git merges both cleanly since they're
    different filenames, and nothing else notices.
    """
    by_id: dict[str, list[str]] = {}
    for f in _active_decision_files():
        m = FILENAME_RE.match(f.name)
        assert m, (
            f"{f.relative_to(REPO_ROOT)} doesn't match the D-NNN-<slug>.md "
            f"naming convention."
        )
        by_id.setdefault(m.group(1), []).append(f.name)

    duplicates = {k: v for k, v in by_id.items() if len(v) > 1}
    assert not duplicates, (
        "Two or more decision records claim the same ID — pick a free one "
        "for all but one and renumber:\n"
        + "\n".join(f"  {k}: {v}" for k, v in sorted(duplicates.items()))
    )


def test_frontmatter_id_matches_filename() -> None:
    """
    Every decision file must declare `id: D-NNN` in its YAML frontmatter, and
    it must agree with the ID in the filename. A mismatch (or a missing
    frontmatter block) means the file's own header can't be trusted to
    identify it — exactly the kind of thing a renumbering pass silently
    breaks if it edits the filename but not the frontmatter, or vice versa.
    """
    mismatches = []
    for f in _active_decision_files():
        filename_id = FILENAME_RE.match(f.name).group(1)
        text = f.read_text(encoding="utf-8")
        m = FRONTMATTER_ID_RE.search(text)
        if m is None:
            mismatches.append(f"{f.name}: no `id:` field in frontmatter")
        elif m.group(1) != filename_id:
            mismatches.append(
                f"{f.name}: frontmatter says {m.group(1)}, filename says {filename_id}"
            )

    assert not mismatches, "Frontmatter/filename ID mismatches:\n" + "\n".join(
        f"  {m}" for m in mismatches
    )


def test_decisions_index_links_resolve() -> None:
    """
    Every docs/decisions/... link in DECISIONS.md must point at a file that
    actually exists. A dangling link (left behind by a rename, or a copy-paste
    of a row for a decision that got renumbered) is invisible until a reader
    clicks it.
    """
    text = DECISIONS_INDEX.read_text(encoding="utf-8")
    links = re.findall(r"\]\((docs/decisions/[^)]+)\)", text)
    assert links, "Expected at least one docs/decisions/ link in DECISIONS.md"

    broken = [link for link in links if not (REPO_ROOT / link).is_file()]
    assert not broken, "DECISIONS.md links to file(s) that don't exist:\n" + "\n".join(
        f"  {b}" for b in broken
    )


def test_no_stale_decision_cross_references() -> None:
    """
    Cross-reference check (issue #203, "worth adding" section). Renumbering a
    decision — which has now happened three times in one day (#205, #209,
    #213) — silently orphans every comment, doc, or SQL file that quoted the
    old filename. `docs/decisions/archive/` is excluded as a *source* of
    references (it's the source project's frozen decision history, ported
    verbatim and not rewritten — see AGENTS.md's bootstrap note; its internal
    cross-references reflect the archived project's own numbering, not this
    one), but a reference *to* an archived file (`decisions/archive/D-NNN-...`)
    from anywhere else in this repo must still resolve.

    The first run of this check found five pre-existing stale references on
    `main` (a not-yet-renumbered filename in etl/schema/init.sql, two
    "D-019" mentions that should have followed the Milanuncios photo-CDN
    decision to its new D-020, and two comments pointing at a bare
    docs/decisions/D-025-... path that only exists under docs/decisions/archive/).
    All five were fixed alongside landing this test.
    """
    violations = []
    for path in REPO_ROOT.rglob("*"):
        if not path.is_file():
            continue
        if any(part in SKIP_DIR_NAMES for part in path.parts):
            continue
        if path.suffix not in REFERENCING_EXTS:
            continue
        try:
            rel = path.relative_to(REPO_ROOT)
        except ValueError:
            continue
        if "docs/decisions/archive" in rel.as_posix():
            continue  # frozen archaeology, not rewritten — see docstring above

        try:
            text = path.read_text(encoding="utf-8", errors="replace")
        except OSError:
            continue

        for m in DECISION_REF_RE.finditer(text):
            raw = m.group(1)
            # A reference can be written relative to the referencing file's
            # own directory (e.g. "../decisions/D-020-....md" from docs/skills/)
            # or relative to the repo root (e.g. "docs/decisions/D-020-....md").
            candidates = [
                (path.parent / raw).resolve(),
                (REPO_ROOT / raw).resolve(),
            ]
            if not any(c.is_file() for c in candidates):
                line_no = text.count("\n", 0, m.start()) + 1
                violations.append(f"{rel}:{line_no}: {raw}")

    assert not violations, (
        "Reference(s) to a docs/decisions/D-NNN-*.md file that no longer "
        "exists under that name (likely left behind by a renumbering pass):\n"
        + "\n".join(f"  {v}" for v in sorted(violations))
    )
