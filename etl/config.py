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


def _get_min_restart_sweep_interval_seconds() -> int:
    """Restart-burst guard threshold, in seconds (issue #172).

    Same env-first-then-loader precedence as the other ETL knobs above.
    900 (15 min) is a fraction of the hourly `_RUN_INTERVAL_SECONDS`
    schedule — long enough to absorb a real crash-loop (container restarts
    every few seconds to a few minutes), short enough that a genuine
    "the container was actually down for a while" restart still sweeps
    immediately almost all the time. 0 disables the guard outright.
    """
    value: object | None = os.environ.get("ETL_MIN_RESTART_SWEEP_INTERVAL_SECONDS")
    if value is None or (isinstance(value, str) and not value.strip()):
        value = _loader_get("etl.min_restart_sweep_interval_seconds", default=None)
    if value is None:
        value = "900"
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        return 900
    # A negative threshold has no sane meaning; 0 is the deliberate
    # "disable the guard" value and must be preserved, not coerced away.
    return parsed if parsed >= 0 else 900


def cimenta2_detail_endpoint() -> str:
    """Aura `getRecord` endpoint the Cimenta2 connector fetches detail from (D-035).

    Empty string (the default) is deliberate and public-safe: with no endpoint
    configured the connector stays discovery-only and makes no network request
    beyond `discover()`'s sitemap sweep. The endpoint value is **never**
    committed to this public repo — it is injected via the
    `CIMENTA2_DETAIL_ENDPOINT` env var / `cimenta2.detail_endpoint` config key,
    so a clone without the secret cannot fetch detail. See D-035.

    Read as a standalone accessor rather than a `Config` field because the
    connector must read it without constructing `Config` (which requires a
    PostgreSQL DSN it has no business needing).
    """
    value = _loader_get("cimenta2.detail_endpoint", default=None)
    if value is None:
        # Loader structurally unavailable (stripped test/CI env) — read env directly.
        value = os.environ.get("CIMENTA2_DETAIL_ENDPOINT")
    return str(value).strip() if value else ""


def cimenta2_include_internal() -> bool:
    """Whether the Cimenta2 connector stores bank-internal commercial fields.

    Default False. When True the connector keeps the acquisition-cost and
    appraisal fields in `listing.raw_extra`; owner-contact fields are never
    stored regardless of this flag (D-035). Standalone accessor for the same
    reason as `cimenta2_detail_endpoint`.
    """
    value = _loader_get("cimenta2.include_internal", default=None)
    if value is None:
        raw = os.environ.get("CIMENTA2_INCLUDE_INTERNAL")
        return raw is not None and raw.strip().lower() in ("1", "true", "yes", "on")
    return bool(value)


def _get_dedup_max_runtime_seconds() -> int:
    """Bounded lifetime of a dedup pass, in seconds (D-036).

    Same env-first-then-loader precedence as the other ETL knobs above. A
    dedup_runs row still 'running' past this age with no active run is treated
    as a dead orphan (crashed container, OOM, SIGKILL) and reconciled to
    'failed'. 7200 (2h) is comfortable headroom over the ~84 min a pass takes
    today, and far below the 9-19h orphaned rows seen live. Must be positive —
    a non-positive value would declare every run orphaned the instant it
    starts, so it is coerced back to the default.
    """
    value: object | None = os.environ.get("ETL_DEDUP_MAX_RUNTIME_SECONDS")
    if value is None or (isinstance(value, str) and not value.strip()):
        value = _loader_get("etl.dedup_max_runtime_seconds", default=None)
    if value is None:
        value = "7200"
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        return 7200
    return parsed if parsed > 0 else 7200


def _get_manual_trigger_max_runtime_seconds() -> int:
    """Bounded lifetime of an ad-hoc manual trigger run, in seconds (D-068).

    Same env-first-then-loader precedence as the other ETL knobs above. An
    `etl_manual_trigger` row flipped to status='running' whose `picked_up_at`
    is older than this age with no active run is treated as a dead orphan (the
    process was SIGKILLed / the container restarted between claiming the row
    and marking it done) and reconciled to 'failed'. A manual trigger runs a
    full `run_all_connectors` sweep — which itself includes a dedup pass — so
    the default (7200s / 2h) sits comfortably above the longest realistic
    sweep+dedup runtime, matching D-036's dedup threshold, and is what keeps
    the reconciler from ever failing a run still doing real work on the
    single-worker deployment. Must be positive — a non-positive value would
    declare every run orphaned the instant it starts, so it is coerced back to
    the default.
    """
    value: object | None = os.environ.get("ETL_MANUAL_TRIGGER_MAX_RUNTIME_SECONDS")
    if value is None or (isinstance(value, str) and not value.strip()):
        value = _loader_get("etl.manual_trigger_max_runtime_seconds", default=None)
    if value is None:
        value = "7200"
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        return 7200
    return parsed if parsed > 0 else 7200


def _get_materialize_reconciler_interval_seconds() -> int:
    """Poll cadence (seconds) of the profile-materialize staleness reconciler
    (issue #285, D-046).

    Same env-first-then-loader precedence as the other ETL knobs above. The
    reconciler is a sweep-independent backstop that re-materializes active
    profiles whose data has gone stale because a best-effort
    `notify_materialize_all` was missed/failed on an ingest path. 120s (2 min)
    is a cheap default — the check is a single aggregate query and only fires
    when a notify was genuinely skipped — that bounds how long a stranded
    profile stays stale. Must be positive; a non-positive value would busy-loop
    the poll thread, so it is coerced back to the default.
    """
    value: object | None = os.environ.get("ETL_MATERIALIZE_RECONCILER_INTERVAL_SECONDS")
    if value is None or (isinstance(value, str) and not value.strip()):
        value = _loader_get("etl.materialize_reconciler_interval_seconds", default=None)
    if value is None:
        value = "120"
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        return 120
    return parsed if parsed > 0 else 120


def _get_default_freshness_interval_hours() -> int:
    """Default freshness cadence (hours) for a connector with no override
    (issue #295, D-050).

    Same env-first-then-loader precedence as the other ETL knobs above. A
    connector only STARTS a refresh cycle when its data is older than this
    interval; a cycle already in progress continues regardless. 24h matches the
    dashboard's FRESHNESS_STALE_THRESHOLD_HOURS default (#241). Must be positive
    — a non-positive interval would make every connector perpetually "due", so
    it is coerced back to the default.
    """
    value: object | None = os.environ.get("ETL_DEFAULT_FRESHNESS_INTERVAL_HOURS")
    if value is None or (isinstance(value, str) and not value.strip()):
        value = _loader_get("etl.default_freshness_interval_hours", default=None)
    if value is None:
        value = "24"
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        return 24
    return parsed if parsed > 0 else 24


def _get_freshness_cycle_stuck_after_hours() -> int:
    """Age (hours) past which an in-progress refresh cycle is flagged 'stuck'
    for observability (issue #295, D-050).

    Purely a visibility threshold — a stuck cycle logs a WARNING and reads as
    "still refreshing, taking unusually long", but is NEVER force-completed.
    Same env-first-then-loader precedence as the other ETL knobs above. Must be
    positive; a non-positive value would flag every cycle stuck the instant it
    starts, so it is coerced back to the default (168h = 7 days).
    """
    value: object | None = os.environ.get("ETL_FRESHNESS_CYCLE_STUCK_AFTER_HOURS")
    if value is None or (isinstance(value, str) and not value.strip()):
        value = _loader_get("etl.freshness_cycle_stuck_after_hours", default=None)
    if value is None:
        value = "168"
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        return 168
    return parsed if parsed > 0 else 168


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
    min_restart_sweep_interval_seconds: int = field(
        default_factory=_get_min_restart_sweep_interval_seconds
    )
    dedup_max_runtime_seconds: int = field(
        default_factory=_get_dedup_max_runtime_seconds
    )
    manual_trigger_max_runtime_seconds: int = field(
        default_factory=_get_manual_trigger_max_runtime_seconds
    )
    materialize_reconciler_interval_seconds: int = field(
        default_factory=_get_materialize_reconciler_interval_seconds
    )
    default_freshness_interval_hours: int = field(
        default_factory=_get_default_freshness_interval_hours
    )
    freshness_cycle_stuck_after_hours: int = field(
        default_factory=_get_freshness_cycle_stuck_after_hours
    )

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
