"""Regression guard for D-151 (issue #654): a schema key documented as
operator-settable via `.env` must actually be passed through to the
container that reads it.

`docker-compose.yml`/`docker-compose.prod.yml`'s `etl` service declares
`environment:` as an explicit allowlist, not a passthrough of the host's
`.env` — a variable set on the host but not named there never reaches the
container. D-150 (PR #670) documented `ETL_RETAIN_CAPTURE_HTML_FOR` as
settable that way, but the compose files never listed it, so the
instructions silently did nothing in production until this was caught and
fixed (D-151).

This is deliberately a NARROW pin, not a blanket "every env-backed
config/schema.yaml key must appear in the compose allowlist" check — D-151
found that would be actively wrong: most `etl.*` tunables are, by design,
config.yaml-only (set via the admin UI, which reads/writes the same
`${INMO_TOOL_CONFIG_DIR}` mount unconditionally, unaffected by this
allowlist). Only `ETL_RETAIN_CAPTURE_HTML_FOR` is pinned here because it is
the one key this project's own decision record explicitly documents as
`.env`-settable.

Run: pytest scripts/tests/test_etl_compose_env_passthrough.py -v
"""

from __future__ import annotations

from pathlib import Path

import yaml

REPO_ROOT = Path(__file__).resolve().parents[2]

# Every ETL_* env var that a decision record or AGENTS.md documents as an
# operator-settable `.env` value for the `etl` service. Add to this list
# only when you also add real operator-facing "set this env var" docs for
# the key — see the module docstring for why this isn't every schema key.
_DOCUMENTED_ETL_ENV_VARS = {
    "ETL_RETAIN_CAPTURE_HTML_FOR",  # D-150 / D-151, issue #654
}


def _etl_service_env_keys(compose_path: Path) -> set[str]:
    with compose_path.open("r", encoding="utf-8") as fh:
        data = yaml.safe_load(fh)
    etl_service = data["services"]["etl"]
    env = etl_service.get("environment") or {}
    if isinstance(env, list):
        # Compose also allows a "KEY=value" list form; normalize to keys.
        return {entry.split("=", 1)[0] for entry in env}
    return set(env.keys())


def test_documented_env_vars_reach_the_local_etl_container():
    keys = _etl_service_env_keys(REPO_ROOT / "docker-compose.yml")
    missing = _DOCUMENTED_ETL_ENV_VARS - keys
    assert not missing, (
        f"docker-compose.yml's etl service does not pass through: {sorted(missing)} "
        "— a documented `.env` var will silently never reach the container "
        "(D-151)"
    )


def test_documented_env_vars_reach_the_prod_etl_container():
    keys = _etl_service_env_keys(REPO_ROOT / "docker-compose.prod.yml")
    missing = _DOCUMENTED_ETL_ENV_VARS - keys
    assert not missing, (
        f"docker-compose.prod.yml's etl service does not pass through: {sorted(missing)} "
        "— a documented `.env` var will silently never reach the container "
        "(D-151)"
    )
