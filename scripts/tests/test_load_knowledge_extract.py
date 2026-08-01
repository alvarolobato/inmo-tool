"""Tests for .github/actions/load-knowledge/extract.py.

Verifies that:
1. load_slice_map reads from docs/knowledge-sources.yml correctly.
2. Running extract.py with a fixed INPUT_SLICES produces output byte-identical
   to the golden file generated before the manifest refactor (EC-6).
"""

import importlib.util
import os
import pathlib
import subprocess
import sys
import types

REPO_ROOT = pathlib.Path(__file__).parent.parent.parent
EXTRACT_PY = REPO_ROOT / ".github" / "actions" / "load-knowledge" / "extract.py"
MANIFEST = REPO_ROOT / "docs" / "knowledge-sources.yml"
GOLDEN_FILE = pathlib.Path(__file__).parent / "fixtures" / "extract_golden.txt"

# Slices used to generate the golden file — must not change.
GOLDEN_SLICES = "data-decisions,etl-sync-strategy,architecture-sales,4d-sql-dialect"


# ── Load the module without executing __main__ ───────────────────────────────


def _load_extract() -> types.ModuleType:
    spec = importlib.util.spec_from_file_location("extract", EXTRACT_PY)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)  # type: ignore[union-attr]
    return mod


extract = _load_extract()


# ── load_slice_map ────────────────────────────────────────────────────────────


def test_load_slice_map_has_12_entries():
    slice_map = extract.load_slice_map(str(REPO_ROOT))
    assert len(slice_map) == 12, f"Expected 12 slices, got {len(slice_map)}"


def test_load_slice_map_keys_match_manifest():
    import yaml

    data = yaml.safe_load(MANIFEST.read_text(encoding="utf-8"))
    expected_slices = {entry["slice"] for entry in data["sources"]}
    slice_map = extract.load_slice_map(str(REPO_ROOT))
    assert set(slice_map.keys()) == expected_slices


def test_load_slice_map_paths_exist():
    slice_map = extract.load_slice_map(str(REPO_ROOT))
    missing = [path for path in slice_map.values() if not (REPO_ROOT / path).is_file()]
    assert not missing, f"Paths not found: {missing}"


def test_load_slice_map_includes_data_decisions():
    slice_map = extract.load_slice_map(str(REPO_ROOT))
    assert "data-decisions" in slice_map
    assert slice_map["data-decisions"] == "docs/data-decisions.md"


# ── byte-identical golden test (EC-6) ────────────────────────────────────────


def test_extract_byte_identical_to_golden(tmp_path):
    """Output for GOLDEN_SLICES must be byte-identical to the pre-refactor golden file."""
    output_file = tmp_path / "github_output.txt"
    env = os.environ.copy()
    env["GITHUB_WORKSPACE"] = str(REPO_ROOT)
    env["INPUT_SLICES"] = GOLDEN_SLICES
    env["GITHUB_OUTPUT"] = str(output_file)

    result = subprocess.run(
        [sys.executable, str(EXTRACT_PY)],
        env=env,
        capture_output=True,
        text=True,
    )
    assert result.returncode == 0, f"extract.py failed: {result.stderr}"

    raw = output_file.read_text(encoding="utf-8")
    # Strip the heredoc envelope: remove "bundle<<KNOWLEDGE_EOF\n" and "KNOWLEDGE_EOF\n"
    lines = raw.splitlines(keepends=True)
    bundle_lines = [
        line
        for line in lines
        if line not in ("bundle<<KNOWLEDGE_EOF\n", "KNOWLEDGE_EOF\n")
    ]
    actual_bundle = "".join(bundle_lines)

    golden = GOLDEN_FILE.read_text(encoding="utf-8")
    assert actual_bundle == golden, (
        "extract.py output differs from golden — manifest refactor changed behavior"
    )
