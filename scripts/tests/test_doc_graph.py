"""
Doc-graph orphan detection test.

Walks the @-import and markdown-link graph starting from CLAUDE.md and every
.claude-contexts/*.md file, then asserts that every .md under docs/ (excluding
docs/decisions/D-*.md, which are intentionally on-demand) is reachable.

Run: pytest scripts/tests/test_doc_graph.py
"""

import re
from collections import deque
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
DOCS_DIR = REPO_ROOT / "docs"
CLAUDE_CONTEXTS_DIR = REPO_ROOT / ".claude-contexts"


def _all_docs() -> set[Path]:
    """All .md files under docs/ that must be reachable."""
    result = set()
    for p in DOCS_DIR.rglob("*.md"):
        # Skip on-demand decision files (intentionally excluded)
        if p.parent.name == "decisions" and p.name.startswith("D-"):
            continue
        result.add(p.resolve())
    return result


def _collect_links(md_path: Path) -> list[Path]:
    """
    Return all files/directories reachable from a single markdown file via:
    - @<path>  (Claude Code context import)
    - [text](url)  (standard markdown link, local files only)
    Fragment (#...) and external http(s) links are ignored.
    """
    try:
        text = md_path.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return []

    targets = []
    base = md_path.parent

    # @<path> imports (e.g. @AGENTS.md, @docs/skills/skills.md)
    for raw in re.findall(r"^@([^\s#\n]+)", text, re.MULTILINE):
        target = (base / raw).resolve()
        targets.append(target)

    # [text](url) markdown links — local paths only (no http://, no mailto:)
    for raw in re.findall(r"\[[^\]]*\]\(([^)]+)\)", text):
        # Strip fragment and query string
        raw = re.split(r"[#?]", raw)[0].strip()
        if not raw or raw.startswith("http") or raw.startswith("mailto"):
            continue
        target = (base / raw).resolve()
        targets.append(target)

    return targets


def _expand_path(p: Path) -> list[Path]:
    """
    If p is a directory, expand to all .md files in it (recursively).
    If p is a file, return [p].
    If p doesn't exist, return [].
    """
    if p.is_dir():
        return [f.resolve() for f in p.rglob("*.md")]
    if p.is_file():
        return [p.resolve()]
    return []


def _build_reachable_set(entry_points: list[Path]) -> set[Path]:
    """BFS from entry points, following @-imports and markdown links."""
    reachable: set[Path] = set()
    queue: deque[Path] = deque()

    for ep in entry_points:
        for p in _expand_path(ep):
            if p not in reachable:
                reachable.add(p)
                queue.append(p)

    while queue:
        current = queue.popleft()
        for link_target in _collect_links(current):
            for p in _expand_path(link_target):
                if p not in reachable:
                    reachable.add(p)
                    queue.append(p)

    return reachable


def test_no_orphan_docs() -> None:
    """
    Every .md under docs/ (excluding docs/decisions/D-*.md) must be reachable
    from CLAUDE.md or one of the .claude-contexts/*.md role files.
    """
    entry_points: list[Path] = [REPO_ROOT / "CLAUDE.md"]
    if CLAUDE_CONTEXTS_DIR.is_dir():
        entry_points.extend(CLAUDE_CONTEXTS_DIR.glob("*.md"))

    reachable = _build_reachable_set(entry_points)

    all_docs = _all_docs()
    orphans = sorted(p.relative_to(REPO_ROOT) for p in all_docs if p not in reachable)

    assert not orphans, (
        f"The following {len(orphans)} doc(s) are not reachable from the "
        f"AGENTS-import + skills-link graph. Add a link from a skill file or "
        f"docs/skills/skills.md:\n" + "\n".join(f"  - {p}" for p in orphans)
    )
