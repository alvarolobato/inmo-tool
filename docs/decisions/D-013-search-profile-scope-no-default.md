---
id: D-013
title: search_profile.scope has no DB-level default
date: 2026-08-03
group: Data / connectors
rule: '`search_profile.scope` has no DB-level default — an INSERT must supply an explicit, validated scope; a missing one fails loudly, not silently.'
order: 11
---

# D-013: search_profile.scope has no DB-level default

*Decided: 2026-08-03*

**Context**: Issue #113 (flagged during Opus's review of PR #110). `search_profile.scope` was declared `JSONB NOT NULL DEFAULT '{}'`. `'{}'` fails `ScopeSchema` (`geography` and `property_types` are both required, non-optional fields), so any row that ever relied on the column default — a manual SQL insert, a seed script, or a future migration that forgets to set it explicitly — landed in the table already broken. `toSearchProfileRowSafe` (`lib/db/profiles.ts`) then silently dropped that row from `listActiveProfiles()`: no error, no badge, nothing rendered anywhere. PR #110 made scoring automatic after every connector run, so the profile was silently skipped forever, indistinguishable from "the tool is broken."

**Decision**: Drop the column default (`ALTER TABLE search_profile ALTER COLUMN scope DROP DEFAULT`). Every real write path (`createProfile` in `lib/db/profiles.ts`) already supplies an explicit, `ScopeSchema`-validated value, so no code depends on the default ever firing. Without a default, an `INSERT` that forgets to supply `scope` fails immediately and loudly (`NOT NULL` violation) instead of silently persisting a row `toSearchProfileRowSafe` can only catch after the fact, on read.

**Alternatives rejected**: Replacing `'{}'` with a "schema-valid empty scope" — rejected because none exists: `property_types` requires at least one element, so there is no meaningful empty geography+type combination to default to that wouldn't itself be a fabrication (an arbitrary made-up default geography/type an operator never chose).

**Rationale**: A loud INSERT-time failure is strictly better than a quiet, permanent disappearance from the UI. This also pairs with #113's broader fix: `lib/db/profiles.ts` now exposes a discriminated `ProfileListEntry` shape (`{ok:true, profile}` / `{ok:false, id, name, issues}`) so any *existing* malformed row (from before this migration, or from a future bug) is still visible to callers that want to surface it, rather than being unconditionally filtered — see `docs/architecture/data-model.md` and the Perfiles overview query (issue #192).

**See**: Issue #113, issue #176 (Perfiles redesign design doc), `dashboard/lib/db/profiles.ts`, `etl/schema/init.sql`.
