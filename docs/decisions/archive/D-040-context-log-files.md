---
id: D-040
title: Conversation context logs live in files on a volume, not Postgres
date: 2026-05-30
---

# D-040: Conversation context logs live in files on a volume, not Postgres

*Decided: 2026-05-30*

**Context**: Every conversation turn captures a "context log" — an exact copy of
what is sent to the LLM (full system prompt, tool catalog, full prior history,
the user message). This was stored in Postgres as a heavy `context` row in
`turn_events.payload`, re-emitted and replayed on every reconnect. The payload is
large (the knowledge bundle alone is tens of KB) and was duplicated per turn,
bloating `turn_events` and every SSE replay — even though the UI shows it only
when the user expands "Contexto original". Everything needed to *rebuild* the
conversation (messages, turns, events) is small and already in Postgres; only the
context log is heavy and rarely read.

**Decision**: The context log is written to a file on the dashboard's data volume,
one folder per conversation and one file per turn:

```
<DASHBOARD_CONTEXT_DIR>/<conversationId>/<turnId>.json
```

Postgres stores only a pointer: `conversation_turns.context_file` (relative path).
At turn time, `makeSystemPromptReadyHandler` (turn-background.ts) writes the file
via `dashboard/lib/conversation-context-store.ts`, records the pointer, and emits a
lightweight `context_ref` turn event (`{ turnId, file, model, provider, flow }`) —
**no** heavy `context` event is stored. The UI renders the panel collapsed from the
ref and lazy-loads the file via `GET /api/conversations/:id/context/:turnId` only
when expanded. The endpoint resolves the pointer scoped to the conversation and
reads the file (path-traversal guarded).

`DASHBOARD_CONTEXT_DIR=/app/data/conversations` is a bind mount to
`./data/dashboard/conversations` (D-002). Writes are best-effort — a read-only or
unwritable volume must never break a turn; the conversation still works, only the
context log is skipped.

The old in-DB `context` path is removed outright (no dual path); pre-existing
conversations lose their expandable context panel — acceptable for a single
deployment (see AGENTS.md "backwards compatibility — default is to break it").

**Alternatives rejected**:
- *Keep it in Postgres, just widen/trim the payload* — still duplicates a large
  blob per turn in the DB and every SSE replay; quadratic growth on long chats.
- *Named volume for the files* — violates D-002 (bind mounts only).
- *One file per LLM API call* — agentic turns make several calls; a per-call layout
  multiplies files and complicates the DB mapping for no user-visible benefit. The
  unit the user cares about is the turn (one user message → one reply).

**Rationale**: Keeps Postgres lean and SSE replay cheap, while still preserving the
full, untruncated "exact copy of what we sent" as an auditable artifact. Lazy load
means the heavy bytes only move when someone actually inspects a turn.

**See**: `dashboard/lib/conversation-context-store.ts`,
`dashboard/lib/turn-background.ts`,
`dashboard/app/api/conversations/[id]/context/[turnId]/route.ts`,
`dashboard/components/InitialContextPanel.tsx`, `etl/schema/init.sql`
(`conversation_turns.context_file`), `docker-compose.yml` (dashboard volume),
D-002 (bind mounts), D-036 (llm-context centralization).
