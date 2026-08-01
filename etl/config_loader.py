"""Unified configuration loader for the PowerShop Analytics ETL service.

Precedence (highest to lowest):
  1. Real environment variables (set before Python starts)
  2. config.yaml at CONFIG_FILE env var or ~/.config/powershop-analytics/config.yaml
  3. Hardcoded defaults from config/schema.yaml

The loader reads config/schema.yaml once (from the repo root, mounted at /app
in Docker) and merges env + file + defaults into a typed dict.

Public API:
  load_config(schema_path, config_path) -> dict[str, ConfigValue]
  write_config(path, values)            — atomic write, chmod 0600
  import_env(path)                      — copy env-sourced keys to file
  get_effective_config()                — convenience: load with default paths
"""

from __future__ import annotations

import os
import stat
import tempfile
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Literal

import yaml

# ---------------------------------------------------------------------------
# Type definitions
# ---------------------------------------------------------------------------

ConfigSource = Literal["env", "file", "default"]


@dataclass
class ConfigValue:
    value: Any
    source: ConfigSource
    sensitive: bool
    key: str
    env: str
    section: str
    description: str
    requires_restart: list[str]
    type: str
    default: Any


# ---------------------------------------------------------------------------
# Default paths
# ---------------------------------------------------------------------------

_REPO_ROOT = Path(__file__).parent.parent
_SCHEMA_PATH = _REPO_ROOT / "config" / "schema.yaml"
_CONFIG_DIR = Path.home() / ".config" / "powershop-analytics"
_DEFAULT_CONFIG_PATH = _CONFIG_DIR / "config.yaml"


def _default_config_path() -> Path:
    env_override = os.environ.get("CONFIG_FILE", "").strip()
    if env_override:
        return Path(env_override)
    return _DEFAULT_CONFIG_PATH


# ---------------------------------------------------------------------------
# Schema loading
# ---------------------------------------------------------------------------


def load_schema(schema_path: Path | None = None) -> list[dict[str, Any]]:
    """Load and return the list of schema entries from schema.yaml."""
    path = schema_path or _SCHEMA_PATH
    if not path.is_file():
        raise FileNotFoundError(f"Config schema not found: {path}")
    with path.open("r", encoding="utf-8") as fh:
        data = yaml.safe_load(fh)
    if not isinstance(data, list):
        raise ValueError(f"Config schema must be a YAML list, got {type(data)}")
    return data


# ---------------------------------------------------------------------------
# Config file loading
# ---------------------------------------------------------------------------


def _load_file(config_path: Path) -> dict[str, Any]:
    """Load key→value pairs from config.yaml. Returns {} if file absent."""
    if not config_path.is_file():
        return {}
    with config_path.open("r", encoding="utf-8") as fh:
        data = yaml.safe_load(fh)
    if data is None:
        return {}
    if not isinstance(data, dict):
        raise ValueError(
            f"config.yaml must be a YAML mapping, got {type(data).__name__}"
        )
    return data  # type: ignore[return-value]


# ---------------------------------------------------------------------------
# Type coercion
# ---------------------------------------------------------------------------


def _coerce(
    value: Any,
    schema_type: str,
    *,
    key: str = "",
    enum_values: list[str] | None = None,
) -> Any:
    """Coerce *value* to the type declared in the schema entry.

    For ``type: enum``, raises ValueError if the coerced value is not in
    *enum_values* (when provided).
    """
    if value is None:
        return None
    if schema_type == "int":
        try:
            return int(value)
        except (TypeError, ValueError) as exc:
            raise ValueError(
                f"Config key {key!r}: expected int, got {value!r}"
            ) from exc
    if schema_type == "bool":
        if isinstance(value, bool):
            return value
        return str(value).strip().lower() in ("1", "true", "yes", "on")
    if schema_type == "enum":
        coerced = str(value).strip()
        if enum_values and coerced not in enum_values:
            raise ValueError(
                f"Config key {key!r}: value {coerced!r} is not one of {enum_values}"
            )
        return coerced
    # string and anything else: keep as str
    return str(value) if value is not None else None


# ---------------------------------------------------------------------------
# Main loader
# ---------------------------------------------------------------------------


def load_config(
    schema_path: Path | None = None,
    config_path: Path | None = None,
) -> dict[str, ConfigValue]:
    """Load configuration applying env > file > default precedence.

    Returns a dict keyed by schema ``key`` (e.g. ``"fourd.host"``).
    """
    schema = load_schema(schema_path)
    cfg_path = config_path or _default_config_path()
    file_data = _load_file(cfg_path)

    result: dict[str, ConfigValue] = {}
    for entry in schema:
        key: str = entry["key"]
        env_name: str = entry["env"]
        schema_type: str = entry.get("type", "string")
        sensitive: bool = bool(entry.get("sensitive", False))
        default: Any = entry.get("default")
        section: str = entry.get("section", "")
        description: str = entry.get("description", "")
        requires_restart: list[str] = entry.get("requires_restart", [])

        env_raw = os.environ.get(env_name)
        file_raw = file_data.get(key)

        if env_raw is not None and env_raw != "":
            source: ConfigSource = "env"
            raw = env_raw
        elif file_raw is not None:
            source = "file"
            raw = file_raw
        elif default is not None:
            source = "default"
            raw = default
        else:
            # Not set anywhere — store None with source="default"
            source = "default"
            raw = None

        enum_values: list[str] | None = entry.get("enum_values")
        result[key] = ConfigValue(
            value=_coerce(raw, schema_type, key=key, enum_values=enum_values),
            source=source,
            sensitive=sensitive,
            key=key,
            env=env_name,
            section=section,
            description=description,
            requires_restart=requires_restart,
            type=schema_type,
            default=default,
        )

    return result


# ---------------------------------------------------------------------------
# Write / import helpers
# ---------------------------------------------------------------------------


def write_config(
    path: Path,
    values: dict[str, Any],
    *,
    comment: str | None = None,
) -> None:
    """Write *values* to *path* atomically with chmod 0600.

    *values* maps schema keys (e.g. ``"fourd.host"``) to their new values.
    The file is written as a YAML mapping of those keys.

    Existing keys not present in *values* are preserved if the file already
    exists (merge semantics). Pass all keys to do a full rewrite.
    """
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)

    # Load existing file to preserve keys not being updated
    existing: dict[str, Any] = {}
    if path.is_file():
        existing = _load_file(path)

    merged = {**existing, **values}

    timestamp = time.strftime("%Y-%m-%dT%H:%M:%S")
    header = f"# PowerShop Analytics — config.yaml\n# Last updated: {timestamp}\n"
    if comment:
        header += f"# {comment}\n"
    header += "# Precedence: env vars > this file > hardcoded defaults.\n"
    header += "# Secrets in this file — keep permissions 0600; never commit.\n\n"

    body = yaml.dump(
        merged, default_flow_style=False, allow_unicode=True, sort_keys=True
    )
    content = header + body

    # Atomic write: write to temp file next to target, then rename
    fd, tmp_path = tempfile.mkstemp(dir=path.parent, prefix=".config_tmp_")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            fh.write(content)
        os.chmod(tmp_path, stat.S_IRUSR | stat.S_IWUSR)  # 0600
        os.replace(tmp_path, path)
    except Exception:
        try:
            os.unlink(tmp_path)
        except OSError:
            pass
        raise


def import_env(
    path: Path,
    schema_path: Path | None = None,
) -> list[str]:
    """Copy all env-sourced keys to the config file.

    Returns the list of keys that were imported.
    """
    config = load_config(schema_path=schema_path, config_path=path)
    to_import = {
        key: cv.value
        for key, cv in config.items()
        if cv.source == "env" and cv.value is not None
    }
    if to_import:
        write_config(
            path,
            to_import,
            comment="imported from environment variables",
        )
    return list(to_import.keys())


# ---------------------------------------------------------------------------
# Bootstrap: write defaults on first start
# ---------------------------------------------------------------------------


def bootstrap_config_if_missing(
    config_path: Path | None = None,
    schema_path: Path | None = None,
) -> bool:
    """If config.yaml does not exist, create it from env + defaults.

    Returns True if the file was created, False if it already existed.
    """
    cfg_path = config_path or _default_config_path()
    if cfg_path.is_file():
        return False

    config = load_config(schema_path=schema_path, config_path=cfg_path)
    # Write all keys that have a value (env or default)
    values = {key: cv.value for key, cv in config.items() if cv.value is not None}
    write_config(
        cfg_path,
        values,
        comment="auto-generated on first start",
    )
    return True


# ---------------------------------------------------------------------------
# Convenience: get_effective_config with default paths
# ---------------------------------------------------------------------------


def get_effective_config(
    schema_path: Path | None = None,
    config_path: Path | None = None,
) -> dict[str, ConfigValue]:
    """Load config using default paths (CONFIG_FILE env → ~/.config/…/config.yaml)."""
    return load_config(
        schema_path=schema_path,
        config_path=config_path or _default_config_path(),
    )
