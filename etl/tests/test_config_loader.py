"""Tests for etl.config_loader — precedence, file operations, bootstrap."""

from __future__ import annotations

import stat
from pathlib import Path

import pytest
import yaml

from etl.config_loader import (
    ConfigValue,
    bootstrap_config_if_missing,
    get_effective_config,
    import_env,
    load_config,
    load_schema,
    write_config,
)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _schema_path() -> Path:
    """Return the repo-root config/schema.yaml path."""
    return Path(__file__).parent.parent.parent / "config" / "schema.yaml"


def _write_yaml(path: Path, data: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as fh:
        yaml.dump(data, fh, default_flow_style=False)


# ---------------------------------------------------------------------------
# Schema loading
# ---------------------------------------------------------------------------


class TestLoadSchema:
    def test_schema_file_exists(self) -> None:
        schema = load_schema(_schema_path())
        assert len(schema) >= 40

    def test_schema_has_required_fields(self) -> None:
        schema = load_schema(_schema_path())
        for entry in schema:
            assert "key" in entry
            assert "env" in entry
            assert "type" in entry

    def test_schema_missing_file_raises(self, tmp_path: Path) -> None:
        with pytest.raises(FileNotFoundError):
            load_schema(tmp_path / "nonexistent.yaml")

    def test_schema_invalid_type_raises(self, tmp_path: Path) -> None:
        bad = tmp_path / "schema.yaml"
        bad.write_text("key: value\n", encoding="utf-8")
        with pytest.raises(ValueError, match="YAML list"):
            load_schema(bad)


# ---------------------------------------------------------------------------
# load_config precedence
# ---------------------------------------------------------------------------


class TestLoadConfigPrecedence:
    """env var > config.yaml > default."""

    def _minimal_schema(self, tmp_path: Path, default: str | None = "dflt") -> Path:
        """Create a minimal single-key schema file."""
        schema = [
            {
                "key": "test.key",
                "env": "TEST_CONFIG_KEY",
                "type": "string",
                "sensitive": False,
                "default": default,
                "section": "Test",
                "description": "A test key",
                "requires_restart": [],
            }
        ]
        p = tmp_path / "schema.yaml"
        _write_yaml(p, schema)
        return p

    def test_env_wins_over_file_and_default(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        schema = self._minimal_schema(tmp_path)
        cfg = tmp_path / "config.yaml"
        _write_yaml(cfg, {"test.key": "from_file"})
        monkeypatch.setenv("TEST_CONFIG_KEY", "from_env")

        config = load_config(schema_path=schema, config_path=cfg)
        cv = config["test.key"]
        assert cv.value == "from_env"
        assert cv.source == "env"

    def test_file_wins_over_default_when_no_env(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        schema = self._minimal_schema(tmp_path)
        cfg = tmp_path / "config.yaml"
        _write_yaml(cfg, {"test.key": "from_file"})
        monkeypatch.delenv("TEST_CONFIG_KEY", raising=False)

        config = load_config(schema_path=schema, config_path=cfg)
        cv = config["test.key"]
        assert cv.value == "from_file"
        assert cv.source == "file"

    def test_default_used_when_no_env_no_file(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        schema = self._minimal_schema(tmp_path)
        cfg = tmp_path / "missing_config.yaml"
        monkeypatch.delenv("TEST_CONFIG_KEY", raising=False)

        config = load_config(schema_path=schema, config_path=cfg)
        cv = config["test.key"]
        assert cv.value == "dflt"
        assert cv.source == "default"

    def test_none_when_no_value_anywhere(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        schema = self._minimal_schema(tmp_path, default=None)
        monkeypatch.delenv("TEST_CONFIG_KEY", raising=False)
        config = load_config(schema_path=schema, config_path=tmp_path / "missing.yaml")
        cv = config["test.key"]
        assert cv.value is None
        assert cv.source == "default"

    def test_int_coercion(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        schema_data = [
            {
                "key": "int.key",
                "env": "TEST_INT_KEY",
                "type": "int",
                "sensitive": False,
                "default": 42,
                "section": "Test",
                "description": "",
                "requires_restart": [],
            }
        ]
        schema = tmp_path / "schema.yaml"
        _write_yaml(schema, schema_data)
        monkeypatch.setenv("TEST_INT_KEY", "99")

        config = load_config(schema_path=schema, config_path=tmp_path / "c.yaml")
        assert config["int.key"].value == 99
        assert isinstance(config["int.key"].value, int)

    def test_bool_coercion_true(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        schema_data = [
            {
                "key": "bool.key",
                "env": "TEST_BOOL_KEY",
                "type": "bool",
                "sensitive": False,
                "default": False,
                "section": "Test",
                "description": "",
                "requires_restart": [],
            }
        ]
        schema = tmp_path / "schema.yaml"
        _write_yaml(schema, schema_data)
        for truthy in ("true", "True", "TRUE", "1", "yes", "on"):
            monkeypatch.setenv("TEST_BOOL_KEY", truthy)
            config = load_config(schema_path=schema, config_path=tmp_path / "c.yaml")
            assert config["bool.key"].value is True, f"Expected True for {truthy!r}"

    def test_empty_env_falls_through_to_file(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        schema = self._minimal_schema(tmp_path)
        cfg = tmp_path / "config.yaml"
        _write_yaml(cfg, {"test.key": "from_file"})
        monkeypatch.setenv("TEST_CONFIG_KEY", "")

        config = load_config(schema_path=schema, config_path=cfg)
        # Empty string env var is treated as "not set"
        assert config["test.key"].source == "file"

    def test_missing_config_file_returns_defaults(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        schema = self._minimal_schema(tmp_path)
        monkeypatch.delenv("TEST_CONFIG_KEY", raising=False)
        config = load_config(schema_path=schema, config_path=tmp_path / "absent.yaml")
        assert config["test.key"].source == "default"
        assert config["test.key"].value == "dflt"

    def test_corrupt_config_file_raises(self, tmp_path: Path) -> None:
        schema = self._minimal_schema(tmp_path)
        cfg = tmp_path / "config.yaml"
        cfg.write_text("- item1\n- item2\n", encoding="utf-8")  # list, not mapping
        with pytest.raises(ValueError, match="mapping"):
            load_config(schema_path=schema, config_path=cfg)


# ---------------------------------------------------------------------------
# write_config
# ---------------------------------------------------------------------------


class TestWriteConfig:
    def _minimal_schema(self, tmp_path: Path) -> Path:
        schema = [
            {
                "key": "test.key",
                "env": "TEST_CONFIG_KEY",
                "type": "string",
                "sensitive": False,
                "default": "dflt",
                "section": "Test",
                "description": "",
                "requires_restart": [],
            }
        ]
        p = tmp_path / "schema.yaml"
        _write_yaml(p, schema)
        return p

    def test_write_creates_file_with_0600(self, tmp_path: Path) -> None:
        cfg = tmp_path / "config.yaml"
        write_config(cfg, {"test.key": "hello"})
        assert cfg.is_file()
        mode = stat.S_IMODE(cfg.stat().st_mode)
        assert mode == 0o600

    def test_write_is_readable(self, tmp_path: Path) -> None:
        cfg = tmp_path / "config.yaml"
        write_config(cfg, {"a.key": "value1", "b.key": 123})
        data = yaml.safe_load(cfg.read_text(encoding="utf-8"))
        assert data["a.key"] == "value1"
        assert data["b.key"] == 123

    def test_write_merges_with_existing(self, tmp_path: Path) -> None:
        cfg = tmp_path / "config.yaml"
        write_config(cfg, {"existing.key": "old"})
        write_config(cfg, {"new.key": "new_value"})
        data = yaml.safe_load(cfg.read_text(encoding="utf-8"))
        assert data["existing.key"] == "old"
        assert data["new.key"] == "new_value"

    def test_write_overwrites_existing_key(self, tmp_path: Path) -> None:
        cfg = tmp_path / "config.yaml"
        write_config(cfg, {"k": "old"})
        write_config(cfg, {"k": "new"})
        data = yaml.safe_load(cfg.read_text(encoding="utf-8"))
        assert data["k"] == "new"

    def test_write_creates_parent_directories(self, tmp_path: Path) -> None:
        cfg = tmp_path / "deep" / "nested" / "config.yaml"
        write_config(cfg, {"k": "v"})
        assert cfg.is_file()

    def test_permissions_are_0600_on_update(self, tmp_path: Path) -> None:
        cfg = tmp_path / "config.yaml"
        write_config(cfg, {"k": "v1"})
        write_config(cfg, {"k": "v2"})
        mode = stat.S_IMODE(cfg.stat().st_mode)
        assert mode == 0o600


# ---------------------------------------------------------------------------
# import_env
# ---------------------------------------------------------------------------


class TestImportEnv:
    def _schema_with_two_keys(self, tmp_path: Path) -> Path:
        schema = [
            {
                "key": "key.a",
                "env": "TEST_KEY_A",
                "type": "string",
                "sensitive": False,
                "default": "default_a",
                "section": "Test",
                "description": "",
                "requires_restart": [],
            },
            {
                "key": "key.b",
                "env": "TEST_KEY_B",
                "type": "string",
                "sensitive": False,
                "default": None,
                "section": "Test",
                "description": "",
                "requires_restart": [],
            },
        ]
        p = tmp_path / "schema.yaml"
        _write_yaml(p, schema)
        return p

    def test_imports_env_keys(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        schema = self._schema_with_two_keys(tmp_path)
        cfg = tmp_path / "config.yaml"
        monkeypatch.setenv("TEST_KEY_A", "from_env_a")
        monkeypatch.delenv("TEST_KEY_B", raising=False)

        imported = import_env(path=cfg, schema_path=schema)
        assert "key.a" in imported

        data = yaml.safe_load(cfg.read_text(encoding="utf-8"))
        assert data["key.a"] == "from_env_a"

    def test_does_not_import_default_only_keys(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        schema = self._schema_with_two_keys(tmp_path)
        cfg = tmp_path / "config.yaml"
        monkeypatch.delenv("TEST_KEY_A", raising=False)
        monkeypatch.delenv("TEST_KEY_B", raising=False)

        imported = import_env(path=cfg, schema_path=schema)
        # key.a has a default but source is "default", not "env"
        assert "key.a" not in imported
        assert "key.b" not in imported


# ---------------------------------------------------------------------------
# bootstrap_config_if_missing
# ---------------------------------------------------------------------------


class TestBootstrapConfigIfMissing:
    def _minimal_schema(self, tmp_path: Path) -> Path:
        schema = [
            {
                "key": "boot.key",
                "env": "TEST_BOOT_KEY",
                "type": "string",
                "sensitive": False,
                "default": "boot_default",
                "section": "Test",
                "description": "",
                "requires_restart": [],
            }
        ]
        p = tmp_path / "schema.yaml"
        _write_yaml(p, schema)
        return p

    def test_creates_file_if_absent(self, tmp_path: Path) -> None:
        schema = self._minimal_schema(tmp_path)
        cfg = tmp_path / "config.yaml"
        created = bootstrap_config_if_missing(config_path=cfg, schema_path=schema)
        assert created is True
        assert cfg.is_file()

    def test_noop_if_file_exists(self, tmp_path: Path) -> None:
        schema = self._minimal_schema(tmp_path)
        cfg = tmp_path / "config.yaml"
        write_config(cfg, {"existing": "value"})
        created = bootstrap_config_if_missing(config_path=cfg, schema_path=schema)
        assert created is False
        # File should still have the original content
        data = yaml.safe_load(cfg.read_text(encoding="utf-8"))
        assert data["existing"] == "value"

    def test_bootstrapped_file_has_0600(self, tmp_path: Path) -> None:
        schema = self._minimal_schema(tmp_path)
        cfg = tmp_path / "config.yaml"
        bootstrap_config_if_missing(config_path=cfg, schema_path=schema)
        mode = stat.S_IMODE(cfg.stat().st_mode)
        assert mode == 0o600

    def test_bootstrapped_file_contains_defaults(self, tmp_path: Path) -> None:
        schema = self._minimal_schema(tmp_path)
        cfg = tmp_path / "config.yaml"
        bootstrap_config_if_missing(config_path=cfg, schema_path=schema)
        data = yaml.safe_load(cfg.read_text(encoding="utf-8"))
        assert data.get("boot.key") == "boot_default"

    def test_bootstrapped_file_contains_env_values(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        schema = self._minimal_schema(tmp_path)
        cfg = tmp_path / "config.yaml"
        monkeypatch.setenv("TEST_BOOT_KEY", "from_env")
        bootstrap_config_if_missing(config_path=cfg, schema_path=schema)
        data = yaml.safe_load(cfg.read_text(encoding="utf-8"))
        assert data.get("boot.key") == "from_env"


# ---------------------------------------------------------------------------
# Real schema smoke test
# ---------------------------------------------------------------------------


class TestRealSchema:
    def test_real_schema_loads_all_keys(
        self, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
    ) -> None:
        """Smoke test with real schema.yaml against a missing config file."""
        monkeypatch.delenv("CONFIG_FILE", raising=False)
        # Use a non-existent path under tmp_path to guarantee the file is absent
        missing = tmp_path / "does_not_exist.yaml"
        config = load_config(
            schema_path=_schema_path(),
            config_path=missing,
        )
        assert len(config) >= 40
        # Every value is a ConfigValue
        for cv in config.values():
            assert isinstance(cv, ConfigValue)
            assert cv.source in ("env", "file", "default")


# ---------------------------------------------------------------------------
# get_effective_config convenience function
# ---------------------------------------------------------------------------


class TestGetEffectiveConfig:
    def test_returns_config_dict(
        self, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
    ) -> None:
        """get_effective_config with explicit config_path returns a non-empty dict."""
        monkeypatch.setenv("CONFIG_FILE", str(tmp_path / "missing.yaml"))
        cfg = get_effective_config(
            schema_path=_schema_path(),
            config_path=tmp_path / "missing.yaml",
        )
        assert isinstance(cfg, dict)
        assert len(cfg) >= 40
        for cv in cfg.values():
            assert isinstance(cv, ConfigValue)
