"""ETL configuration — loaded via the central config loader (config_loader.py).

Precedence (env > config.yaml > schema defaults):
  1. Real environment variables (set before Python starts)
  2. config.yaml at CONFIG_FILE env var or ~/.config/inmo-tool/config.yaml
  3. Hardcoded defaults from config/schema.yaml

For backward-compatibility the module also loads .env files in the legacy order
so existing deployments that rely on python-dotenv keep working:
  1. .env in current directory (worktree symlink → centralized, or docker-compose)
  2. local/.env (repo-local override)
  3. ~/.config/inmo-tool/.env (centralized)

Real environment variables always win (override=False).
"""

import os
from dataclasses import dataclass, field
from pathlib import Path
from urllib.parse import quote

from dotenv import load_dotenv

# ---------------------------------------------------------------------------
# Legacy .env loading (backward-compat; real env vars always win)
# ---------------------------------------------------------------------------

_CONFIG_DIR = Path.home() / ".config" / "inmo-tool"
for _candidate in [
    Path(
        ".env"
    ),  # highest priority (worktree symlink → centralized, or docker-compose)
    Path("local/.env"),  # worktree-local override
    _CONFIG_DIR / ".env",  # centralized (lowest priority)
]:
    if _candidate.is_file():
        load_dotenv(_candidate, override=False)

# ---------------------------------------------------------------------------
# Central loader helpers
# ---------------------------------------------------------------------------


def _loader_get(key: str, default: str | int | None = None) -> str | int | None:
    """Retrieve *key* from the central config loader.

    Falls back to *default* only when the loader is structurally unavailable
    (import error or missing schema/config files).  Validation errors — corrupt
    config.yaml, invalid enum/int values — are re-raised so misconfiguration
    fails loudly rather than silently using unexpected defaults.
    """
    try:
        from etl.config_loader import get_effective_config

        cfg = get_effective_config()
        cv = cfg.get(key)
        if cv is not None and cv.value is not None:
            return cv.value  # type: ignore[return-value]
    except (ImportError, FileNotFoundError):
        # Loader module not importable or schema file absent — fall through to
        # os.environ / hardcoded default (e.g. stripped test/CI environment).
        pass
    return default


# ---------------------------------------------------------------------------
# Config value helpers
# ---------------------------------------------------------------------------


def _get_postgres_dsn() -> str:
    """Return the PostgreSQL DSN from the central loader or assembled from parts.

    Precedence:
    1. postgres.dsn (schema key) / POSTGRES_DSN — explicit full DSN.
    2. Assembled from postgres.user + postgres.db + optional postgres.password,
       postgres.host, postgres.port — matches variables in .env.example.

    Returns an empty string if neither form is set (validated in __post_init__).
    """
    # 1. Try full DSN from loader first
    dsn_value = _loader_get("postgres.dsn", default=None)
    if dsn_value:
        return str(dsn_value).strip()

    # 2. Try full DSN directly from env (in case loader isn't available)
    dsn = (os.environ.get("POSTGRES_DSN") or "").strip()
    if dsn:
        return dsn

    # 3. Assemble from parts via loader (falling back to env)
    def _get(loader_key: str, env_key: str, default: str = "") -> str:
        v = _loader_get(loader_key, default=None)
        if v is not None:
            return str(v)
        return os.environ.get(env_key, default)

    user = _get("postgres.user", "POSTGRES_USER")
    password = _get("postgres.password", "POSTGRES_PASSWORD")
    db = _get("postgres.db", "POSTGRES_DB")
    host = _get("postgres.host", "POSTGRES_HOST", "localhost")
    port = _get("postgres.port", "POSTGRES_PORT", "5432")

    if user and db:
        # Use quote(safe="") for URL userinfo component encoding.
        # quote_plus() is NOT used — it encodes spaces as '+', which is only
        # correct in query strings, not in URL authority sections.
        encoded_user = quote(user, safe="")
        if password:
            encoded_password = quote(password, safe="")
            return f"postgresql://{encoded_user}:{encoded_password}@{host}:{port}/{db}"
        return f"postgresql://{encoded_user}@{host}:{port}/{db}"

    return ""


def _get_dashboard_base_url() -> str:
    """Base URL of the dashboard as reachable from the ETL container (issue #94).

    Empty string disables the post-run materialize callback entirely — a
    supported configuration (e.g. running the ETL standalone with no
    dashboard container), not an error.

    The environment variable is checked *before* the config loader, and an
    explicitly-empty value is honoured rather than treated as "unset". The
    loader coerces empty to None and would fall through to the schema
    default, silently re-enabling a callback the operator deliberately
    turned off — caught by test_empty_base_url_disables_the_call.
    """
    if "ETL_DASHBOARD_BASE_URL" in os.environ:
        return os.environ["ETL_DASHBOARD_BASE_URL"].strip()
    value = _loader_get("etl.dashboard_base_url", default=None)
    if value is not None:
        return str(value).strip()
    return "http://dashboard:4000"


def _get_dashboard_callback_timeout_seconds() -> int:
    """Timeout for the post-run materialize callback (issue #94).

    Environment first, then the config loader — the same precedence as
    `_get_dashboard_base_url` above, so the two knobs for this callback behave
    consistently.
    """
    value: object | None = os.environ.get("ETL_DASHBOARD_CALLBACK_TIMEOUT_SECONDS")
    if value is None or (isinstance(value, str) and not value.strip()):
        value = _loader_get("etl.dashboard_callback_timeout_seconds", default=None)
    if value is None:
        value = "30"
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        return 30
    # A non-positive timeout would mean "fail instantly" in requests, which
    # is never what an operator means — treat it as "use the default".
    return parsed if parsed > 0 else 30


def _get_admin_api_key() -> str:
    """Shared admin key used to authenticate the dashboard callback (issue #94).

    Read from the environment only, never from config.yaml — mirrors the
    dashboard's own `adminApiKeyValid` reasoning: a key that is writable from
    the config UI could be replaced by an attacker with file-write access to
    lock out the real admin.
    """
    return (os.environ.get("ADMIN_API_KEY") or "").strip()


@dataclass
class Config:
    postgres_dsn: str = field(default_factory=_get_postgres_dsn)
    dashboard_base_url: str = field(default_factory=_get_dashboard_base_url)
    dashboard_callback_timeout_seconds: int = field(
        default_factory=_get_dashboard_callback_timeout_seconds
    )
    admin_api_key: str = field(default_factory=_get_admin_api_key)

    def __post_init__(self) -> None:
        self.postgres_dsn = self.postgres_dsn.strip()
        if not self.postgres_dsn:
            raise ValueError(
                "PostgreSQL DSN is required but could not be determined. "
                "Set POSTGRES_DSN to a full connection string (e.g. "
                "'postgresql://user:password@host:5432/dbname'), "
                "or set POSTGRES_USER + POSTGRES_DB "
                "(and optionally POSTGRES_PASSWORD for non-passwordless auth) "
                "matching the variables in .env.example."
            )
