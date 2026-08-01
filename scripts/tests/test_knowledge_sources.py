"""Tests for docs/knowledge-sources.yml (EC-5).

Verifies the manifest is valid YAML with 12 entries and all paths resolve.
"""

import pathlib

import yaml

REPO_ROOT = pathlib.Path(__file__).parent.parent.parent
MANIFEST = REPO_ROOT / "docs" / "knowledge-sources.yml"


def _load() -> dict:
    with open(MANIFEST, encoding="utf-8") as f:
        return yaml.safe_load(f)


def test_manifest_is_valid_yaml():
    data = _load()
    assert isinstance(data, dict)
    assert "sources" in data


def test_manifest_has_12_sources():
    data = _load()
    assert len(data["sources"]) == 12, (
        f"Expected 12 sources, got {len(data['sources'])}"
    )


def test_all_paths_exist():
    data = _load()
    missing = []
    for entry in data["sources"]:
        p = REPO_ROOT / entry["path"]
        if not p.is_file():
            missing.append(entry["path"])
    assert not missing, f"Missing source files: {missing}"


def test_all_slices_unique():
    data = _load()
    slices = [entry["slice"] for entry in data["sources"]]
    assert len(slices) == len(set(slices)), (
        f"Duplicate slice names: {[s for s in slices if slices.count(s) > 1]}"
    )


def test_data_decisions_included():
    data = _load()
    paths = [entry["path"] for entry in data["sources"]]
    assert "docs/data-decisions.md" in paths, (
        "data-decisions.md must be in the manifest"
    )


def test_all_required_slices_present():
    required = {
        "data-decisions",
        "etl-sync-strategy",
        "architecture-sales",
        "architecture-wholesale",
        "architecture-stock",
        "architecture-purchasing",
        "architecture-products",
        "architecture-customers",
        "architecture-stores",
        "4d-sql-dialect",
        "data-access",
        "sql-pairs",
    }
    data = _load()
    actual = {entry["slice"] for entry in data["sources"]}
    assert actual == required, (
        f"Slice mismatch: missing={required - actual}, extra={actual - required}"
    )
