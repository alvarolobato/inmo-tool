---
id: D-023
title: Central config.yaml + admin UI for all system settings
date: 2026-04-24
---

# D-023: Central config.yaml + admin UI for all system settings

*Decided: 2026-04-24*

**Context**: Issue #397 — all configuration lived in `.env` / environment variables with no UI to view or change it. Secrets and non-secrets were mixed. Adding D-019's LLM provider field made clear a unified config layer was needed.
**Decision**:
- Introduce `~/.config/powershop-analytics/config.yaml` as a single source of non-secret + secret configuration, managed by the admin UI.
- **Precedence**: `env var > config.yaml > hardcoded default`. Fully backward-compatible: systems with only env vars keep working unchanged.
- **Schema**: `config/schema.yaml` is the single source of truth for all 40 keys (name, env mapping, type, sensitivity, defaults, restart requirements, components).
- **Loaders**: `etl/config_loader.py` (Python/PyYAML) and `dashboard/lib/system-config/loader.ts` (TypeScript/yaml) implement identical precedence logic. In-process cache with explicit invalidation (`resetConfigCache()`) on PUT.
- **Bootstrap**: On first start, if `config.yaml` is absent, it is auto-created from current env + schema defaults (`bootstrapConfigIfMissing()`). Atomic write (temp + rename) + `chmod 0600`.
- **Admin API**: `GET /api/admin/config` (sections + source/sensitivity metadata, secrets masked); `PUT /api/admin/config` (partial update, writes to file); `POST /api/admin/config/import-env` (bulk copy from env to file); `GET /api/admin/config/reveal?key=…` (admin-auth real value reveal + audit log).
- **UI**: `/admin/config` — all sections, source badges (`env` / `file` / `default`), `SecretField` with eye-toggle + copy, per-key "Save to file" for env-sourced keys, global "Import all", restart-required banners.
- **`ADMIN_API_KEY`** is explicitly excluded from UI editing (read-only guard in PUT handler).
- **Docker**: `${HOME}/.config/powershop-analytics` mounted at `/config` — read-only for ETL, read-write for Dashboard. `CONFIG_FILE=/config/config.yaml` env var in both services.
- **Scope**: The new loaders are consumed by the admin API, bootstrap path, and Dashboard LLM runtime (`dashboard/lib/llm-provider/config.ts`, `openrouter.ts`, `llm-usage.ts` now call `getSystemConfig()` so config.yaml values take effect at runtime). ETL `etl/config.py` still reads env vars directly for backward compatibility; file-precedence for the ETL scheduler is a follow-on task.
**Alternatives rejected**: Splitting config into separate files per component (defeated the "single source" goal); database-stored config (adds bootstrap coupling).
**Rationale**: Gives operators a GUI to inspect and change settings without SSH; env vars remain authoritative for Docker/CI; secrets stay in the same directory, never committed.
**See**: `config/schema.yaml`, `etl/config_loader.py`, `dashboard/lib/system-config/loader.ts`, `dashboard/app/admin/config/`, `dashboard/app/api/admin/config/`, `docker-compose.yml`.
