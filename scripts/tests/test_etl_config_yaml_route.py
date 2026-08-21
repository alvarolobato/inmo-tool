"""Guard for D-151: the `config.yaml` route is the ONLY route for `etl.*`
operational tunables, so the plumbing that carries it must be pinned.

`etl.*` tunables are not passed to the `etl` container as environment
variables — its `environment:` block is a deliberate bootstrap-only
allowlist (DSN, config paths, admin key, otel wiring). Everything else
reaches the container through exactly one path:

    /admin/config  →  dashboard writes  ${INMO_TOOL_CONFIG_DIR}/config.yaml
                      (host dir mounted :rw into the dashboard container)
                   →  same host dir mounted :ro into the etl container at
                      /config, with CONFIG_FILE pinning the loader to it
                   →  etl reads it on next restart

That path is load-bearing for every `etl.*` key and is held together
purely by two compose lines per service, with nothing else asserting them.
Delete the `/config` mount or drop `CONFIG_FILE`, and the etl container
silently falls back to `~/.config/inmo-tool/config.yaml` *inside* the
container — a path that does not exist — so every tunable silently reverts
to its schema default, with every other test still green.

This replaces an earlier, narrower test that pinned a single env var into
the `etl.environment` allowlist. That got the direction backwards: adding
`etl.*` tunables to the env allowlist creates a SECOND source of truth that
the admin UI cannot see (the UI renders its "env var active" warning from
the *dashboard* container's view of the value, so an etl-only env var makes
the UI silently wrong and makes turning a key OFF a no-op). See D-151.

Run: pytest scripts/tests/test_etl_config_yaml_route.py -v
"""

from __future__ import annotations

from pathlib import Path

import pytest
import yaml

REPO_ROOT = Path(__file__).resolve().parents[2]

COMPOSE_FILES = ["docker-compose.yml", "docker-compose.prod.yml"]

# The host directory the admin UI writes config.yaml into, and where both
# containers mount it. Must stay identical on both services or the write
# and the read stop pointing at the same file.
CONFIG_DIR_SOURCE = "${INMO_TOOL_CONFIG_DIR:-${HOME}/.config/inmo-tool}"
CONFIG_MOUNT_TARGET = "/config"
CONFIG_FILE_PATH = "/config/config.yaml"
SCHEMA_MOUNT_TARGET = "/app/config/schema.yaml"


def _service(compose_name: str, service: str) -> dict:
    path = REPO_ROOT / compose_name
    with path.open("r", encoding="utf-8") as fh:
        data = yaml.safe_load(fh)
    return data["services"][service]


def _config_mount(service: dict) -> tuple[str, str] | None:
    """Return (source, mode) of the bind mount landing on /config, if any."""
    for entry in service.get("volumes") or []:
        if not isinstance(entry, str):
            continue
        parts = entry.split(":")
        # "<source>:<target>[:<mode>]" — but the source itself contains ":-"
        # from the ${VAR:-default} interpolation, so split from the right.
        if len(parts) >= 2 and parts[-1] in ("ro", "rw"):
            target, mode = parts[-2], parts[-1]
            source = ":".join(parts[:-2])
        else:
            target, mode = parts[-1], "rw"
            source = ":".join(parts[:-1])
        if target == CONFIG_MOUNT_TARGET:
            return source, mode
    return None


@pytest.mark.parametrize("compose_name", COMPOSE_FILES)
def test_etl_reads_config_yaml_from_the_shared_mount(compose_name: str):
    """etl must mount the shared config dir read-only and be pinned to it."""
    etl = _service(compose_name, "etl")

    mount = _config_mount(etl)
    assert mount is not None, (
        f"{compose_name}: the etl service has no bind mount at "
        f"{CONFIG_MOUNT_TARGET}. config.yaml is the ONLY route for etl.* "
        "tunables (D-151) — without this mount every one of them silently "
        "falls back to its schema default."
    )
    source, mode = mount
    assert source == CONFIG_DIR_SOURCE, (
        f"{compose_name}: etl mounts {source!r} at {CONFIG_MOUNT_TARGET}, "
        f"expected {CONFIG_DIR_SOURCE!r} — it must be the same host directory "
        "the dashboard writes config.yaml into, or the admin UI edits never "
        "reach etl (D-151)."
    )
    assert mode == "ro", (
        f"{compose_name}: etl mounts the config dir {mode!r}; it must be "
        "'ro' — only the dashboard writes config.yaml."
    )

    env = etl.get("environment") or {}
    assert env.get("CONFIG_FILE") == CONFIG_FILE_PATH, (
        f"{compose_name}: etl's CONFIG_FILE is {env.get('CONFIG_FILE')!r}, "
        f"expected {CONFIG_FILE_PATH!r}. Without it the loader falls back to "
        "~/.config/inmo-tool/config.yaml INSIDE the container, which does not "
        "exist, and every etl.* tunable silently reverts to its default."
    )
    assert env.get("CONFIG_SCHEMA_PATH") == SCHEMA_MOUNT_TARGET, (
        f"{compose_name}: etl's CONFIG_SCHEMA_PATH is "
        f"{env.get('CONFIG_SCHEMA_PATH')!r}, expected {SCHEMA_MOUNT_TARGET!r} "
        "— the loader needs the schema to resolve any key at all."
    )


@pytest.mark.parametrize("compose_name", COMPOSE_FILES)
def test_dashboard_writes_config_yaml_to_the_same_mount(compose_name: str):
    """The admin UI's write half of the same route."""
    dashboard = _service(compose_name, "dashboard")

    mount = _config_mount(dashboard)
    assert mount is not None, (
        f"{compose_name}: the dashboard service has no bind mount at "
        f"{CONFIG_MOUNT_TARGET} — /admin/config would have nowhere to persist "
        "config.yaml (D-151)."
    )
    source, mode = mount
    assert source == CONFIG_DIR_SOURCE, (
        f"{compose_name}: dashboard mounts {source!r} at "
        f"{CONFIG_MOUNT_TARGET}, expected {CONFIG_DIR_SOURCE!r} — it must be "
        "the same host directory etl reads from (D-151)."
    )
    assert mode == "rw", (
        f"{compose_name}: dashboard mounts the config dir {mode!r}; it must "
        "be 'rw' — /admin/config writes config.yaml there."
    )

    env = dashboard.get("environment") or {}
    assert env.get("CONFIG_FILE") == CONFIG_FILE_PATH, (
        f"{compose_name}: dashboard's CONFIG_FILE is "
        f"{env.get('CONFIG_FILE')!r}, expected {CONFIG_FILE_PATH!r} — the "
        "admin UI must read and write the same file etl reads."
    )


def test_both_compose_files_agree_on_the_config_mount():
    """Local and prod must not drift — a fix verified locally must hold in prod."""
    seen = {}
    for compose_name in COMPOSE_FILES:
        for service in ("etl", "dashboard"):
            seen[(compose_name, service)] = _config_mount(
                _service(compose_name, service)
            )

    for service, expected_mode in (("etl", "ro"), ("dashboard", "rw")):
        local = seen[("docker-compose.yml", service)]
        prod = seen[("docker-compose.prod.yml", service)]
        assert local == prod == (CONFIG_DIR_SOURCE, expected_mode), (
            f"{service}: config mount differs between compose files "
            f"(local={local}, prod={prod}) — a config.yaml route verified "
            "locally would not be the one running in production (D-151)."
        )
