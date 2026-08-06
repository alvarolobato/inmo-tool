"""Drift guard: the checked-in ``DECISIONS.md`` must equal the generated one.

Mirrors the ``knowledge.ts`` guard (a stale committed artifact fails CI). Issue
#352 makes ``DECISIONS.md`` a pure projection of the per-decision frontmatter;
this asserts the projection on disk is fresh. If it fails, run:

    python3 scripts/build-decisions-index.py

CI equivalent: ``python3 scripts/build-decisions-index.py && git diff --exit-code DECISIONS.md``.
"""

import sys
from pathlib import Path

SCRIPTS_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SCRIPTS_DIR))

from decisions_index import INDEX_PATH, generate


def test_decisions_index_is_fresh() -> None:
    generated = generate()
    current = INDEX_PATH.read_text(encoding="utf-8")
    assert current == generated, (
        "DECISIONS.md is out of date with the per-decision frontmatter. "
        "Regenerate it: python3 scripts/build-decisions-index.py"
    )


def test_every_index_row_links_to_a_real_file() -> None:
    """A generated link must resolve — a slug typo in frontmatter/filename fails."""
    import re

    text = generate()
    links = re.findall(r"\]\((docs/decisions/[^)]+)\)", text)
    assert links, "generator produced no rows"
    broken = [ln for ln in links if not (INDEX_PATH.parent / ln).is_file()]
    assert not broken, f"generated links to missing files: {broken}"
