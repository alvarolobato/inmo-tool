---
id: D-024
title: Surface Claude CLI API failures and expand AGENTIC_RUNNER error detail
date: 2026-04-26
---

# D-024: Surface Claude CLI API failures and expand AGENTIC_RUNNER error detail

*Decided: 2026-04-26*

**Context**: Issue #419. `DASHBOARD_LLM_PROVIDER=cli` flows surfaced as `LLM_CLI_EXIT: claude agentic step: CLI exited with code 1` with empty stderr — useless for debugging. Root cause was an **expired Claude OAuth access token whose refresh was blocked by Cloudflare**: the CLI returns the upstream `401 Invalid authentication credentials` on **stdout** as `{"is_error":true,"api_error_status":401,"result":"…"}` while exiting non-zero with empty stderr. The runner only inspected `stderr`, so the meaningful failure was thrown away.
**Decision**:
- `assertCliSuccess` now parses the stdout JSON envelope when exit ≠ 0 and lifts auth/API errors into `LLM_CLI_AUTH` / `LLM_CLI_API_ERROR` with the inner `api_error_status` and message attached. The exit-0 envelope path in `claudeCliAgenticStep` does the same (some upstream errors are reported with `is_error:true` *and* exit 0).
- `CliRunnerError` carries the full diagnostic: sanitized stdout/stderr tails, the spawned argv, phase, duration, and innerErrorCode.
- The agentic runner translates `CliRunnerError` and other failures into `AgenticRunnerError` with an `AgenticRunnerErrorDiagnostic` (provider/driver/model, phase, durationMs, toolRoundsUsed, lastToolCall, limitsAtFailure, cli sub-object).
- API routes (`generate`/`modify`/`analyze`) attach the diagnostic to the `formatApiError(...)` response and persist a row in the new `llm_errors` table for offline triage.
- All free-form strings pass through `lib/llm-provider/sanitize.ts`, which redacts Bearer/Authorization, `sk-…`, `sk-ant-…`, JWTs, postgres DSNs, basic-auth `:pass@`, refresh/access-token JSON values, and the live values of every `sensitive: true` key from `config/schema.yaml`. `sanitize()` is idempotent and unit-tested.
- Frontend: new `AgenticErrorDetails` component renders the diagnostic in five labelled sections (Causa, Contexto, CLI, Tool en curso, Límites) with a "Copiar como JSON" button. Used by both `ChatSidebar` and `ErrorDisplay`.
- Docker entrypoint (`dashboard/docker-entrypoint.sh`) now logs a clear warning + remediation hint (`claude /login`) when the access token is already expired at startup or when the OAuth refresh endpoint returns a Cloudflare 403.
**Alternatives rejected**: (a) catching this only in the UI as a generic "auth error" message — loses the inner status code and the tool-loop context, (b) putting full sanitized stdout on the error message string — would have been quietly truncated and breaks structured telemetry, (c) auto-refreshing tokens server-side on demand — Cloudflare blocks the OAuth endpoint, refresh must happen on the host.
**Rationale**: The dashboard already has the rich error context server-side; the issue was that we threw it away before the API response was assembled. Centralizing the diagnostic shape in `AgenticErrorDiagnostic` lets every flow (current and future) opt-in by passing the same payload.
**See**: `dashboard/lib/llm-provider/sanitize.ts`, `dashboard/lib/llm-provider/cli/{errors,process,claude-code}.ts`, `dashboard/lib/llm-tools/{runner,diagnostic,logging}.ts`, `dashboard/components/AgenticErrorDetails.tsx`, `etl/schema/init.sql` (`llm_errors`), `dashboard/docker-entrypoint.sh`.
