# Skill: Dashboard App Development

**Use when**: Building, modifying, or debugging the AI dashboard generator (Next.js + Tremor).

## Project Structure

```
dashboard/
├── app/                     # Next.js App Router
│   ├── layout.tsx           # Root layout (sidebar, nav)
│   ├── page.tsx             # Home: dashboard list
│   ├── dashboard/
│   │   ├── [id]/page.tsx    # Dashboard view + chat sidebar
│   │   └── new/page.tsx     # Create new dashboard
│   └── api/
│       ├── dashboard/
│       │   ├── generate/route.ts   # POST: prompt → LLM → spec
│       │   ├── modify/route.ts     # POST: spec + prompt → LLM → updated spec
│       │   ├── [id]/route.ts       # GET: load, POST: save
│       │   └── route.ts            # GET: list all dashboards
│       └── query/route.ts          # POST: SQL → PG → data
├── components/
│   ├── widgets/             # Widget renderers (KpiRow, BarChart, Table, etc.)
│   ├── DashboardRenderer.tsx # Takes spec JSON, renders all widgets
│   ├── ChatSidebar.tsx      # Chat interface for dashboard modification
│   └── DashboardList.tsx    # Dashboard listing page
├── lib/
│   ├── llm.ts              # Dashboard LLM orchestration (single-shot + agentic)
│   ├── llm-provider/       # OpenRouter vs CLI adapters, safe CLI spawn, registry
│   ├── llm-tools/          # Agentic runner, tool catalog, SQL/dashboard handlers
│   ├── db.ts               # PostgreSQL client (pg)
│   ├── prompts.ts          # System prompts with knowledge context
│   ├── schema.ts           # Dashboard spec TypeScript types
│   └── knowledge.ts        # SQL pairs + instructions as LLM context
├── Dockerfile
├── package.json
└── tailwind.config.ts
```

## LLM Call Architecture

All LLM calls go through `dashboard/lib/llm-context/assemble.ts` via `assembleRequest(flow, vars, conversationId, userMessage, opts)`. This is the **only** file allowed to import `llmComplete` or `runAgenticChat` — CI enforces this via `dashboard/scripts/check-llm-context.sh`. See [docs/skills/llm-context.md](llm-context.md) for the full API reference and [D-036](../decisions/D-036-llm-context-centralization.md) for the rationale.

`lib/llm.ts` is now a thin wrapper: each exported function calls `assembleRequest` then returns `result.text`. No prompt assembly happens in `llm.ts`.

## Key Patterns

### Dashboard Spec Generation
The LLM receives: system prompt (schema + knowledge + widget types) + user prompt.
It returns: a JSON spec with `title`, `description`, `widgets[]`.
Each widget has: `type`, `title`, `sql`, and type-specific config (x/y for charts, format for KPIs).

### Agentic tools (generate / modify / analyze)
When `DASHBOARD_AGENTIC_TOOLS_ENABLED=true` (default), `assembleRequest` in `lib/llm-context/assemble.ts` routes those three flows through `lib/llm-tools/runner.ts`. With **`DASHBOARD_LLM_PROVIDER=openrouter`** (default), rounds use native OpenRouter function calling. With **`DASHBOARD_LLM_PROVIDER=cli`**, rounds use the Claude Code JSON step protocol (see D-019). The model can list/describe `ps_*` tables, validate or run read-only SQL, and inspect saved dashboards before the final JSON or markdown answer. Hard limits and telemetry are documented in [docs/dashboard-agentic-tools.md](../dashboard-agentic-tools.md).

### Dashboard Modification
User sends: current spec JSON + modification prompt.
LLM returns: updated spec JSON (preserving existing widgets, adding/modifying as requested).
Frontend diffs and re-renders only changed widgets.

### SQL Execution
Each widget's SQL is executed independently against PostgreSQL.
Results are cached (in-memory or Redis) with a TTL.
Errors in one widget don't break the dashboard — show error badge on that widget.

### Widget Components
Each widget type maps to a Tremor component:
- `kpi_row` → `Card` + `Metric` in a grid
- `bar_chart` → `BarChart`
- `line_chart` → `LineChart`
- `table` → `Table` with sortable columns
- `donut_chart` → `DonutChart`

## LLM System Prompt Structure

```
You are a dashboard generator for a Spanish retail/wholesale business.
You generate JSON dashboard specifications.

## Available Widget Types
[list of widget types with JSON format]

## Database Schema
[ps_* table names, key columns, descriptions]

## Business Rules
[40+ instructions from wren-push-metadata.py]

## Example SQL Patterns
[52+ SQL pairs]

## Rules
- All SQL must be valid PostgreSQL against ps_* tables
- Use column aliases in Spanish for display
- Always use total_si (sin IVA) for revenue
- Include Referencia (ccrefejofacm) not codigo for article display
- fecha_creacion for date filtering (never fecha_documento)
- Store 99 = almacén central, exclude from retail analytics
```

## Global filters (template dashboards)

Pre-built dashboards declare their `spec.filters: GlobalFilter[]` from
shared sets in `dashboard/lib/template-global-filters.ts`:

| Set | Covers | Filters |
|-----|--------|---------|
| `templateGlobalFiltersRetail` | ventas, general | tienda, familia, temporada, marca, sexo, departamento |
| `templateGlobalFiltersMayorista` | mayorista | cliente_mayorista, familia, temporada, marca |
| `templateGlobalFiltersStock` | stock | tienda (stock-scoped), familia, temporada, marca |
| `templateGlobalFiltersCompras` | compras | proveedor_compras |

Rules when writing widget SQL for these templates:

1. **Stick to the documented alias**: the `bind_expr` of each filter is
   anchored to an alias (`v`, `lv`, `p`, `fm`, `f`, `lf`, `co`, `s`, …).
   Widget SQL that wants to apply the filter must use the same alias.
2. **Only reference filter tokens (`__gf_<id>__`) that the template declares**
   — the `template-global-filters.test.ts` suite enforces this. Tokens with
   no active selection compile to `TRUE`; there's no cost to including them
   in a widget that already joins the right table.
3. **Inactive filters must produce valid SQL** — our compile step guarantees
   `TRUE` substitution for unset/empty selections. All tests assert that
   every template compiles with an empty `GlobalFilterValues`.
4. **Add new filters via the catalog, not ad-hoc**: edit
   `template-global-filters.ts`, add/expand a set, wire widgets to use the
   new token. Re-run `npm run test` — the compilation + orphan-token tests
   will tell you if a widget references a filter that isn't in the set.

Users interact with these filters through `FilterCombobox` (Headless UI
Combobox multi/single select with client-side search, chips, and "Limpiar").

## Testing

- Unit tests: widget components render correct Tremor elements
- Integration tests: API routes return valid specs
- SQL validation: run EXPLAIN on all generated SQL
- E2E: Playwright test for full generate → view → modify flow

## Prompt caching

### OpenRouter (Anthropic backend) — implemented

The dashboard LLM sends every system prompt in two blocks with Anthropic's
`cache_control: { type: "ephemeral" }` extension forwarded by OpenRouter:

```json
[
  { "type": "text", "text": "<stable block>", "cache_control": { "type": "ephemeral" } },
  { "type": "text", "text": "<volatile block>" }
]
```

**Stable block** (`buildStableKnowledgePart()` in `prompts.ts`): widget-type
reference, output format, SQL rules, schema, relationships, business
instructions, SQL example pairs.  This block is identical across all requests
for the same deployment.

**Volatile block**: current dashboard spec (for `modify` flow); absent for
`generate` (whole prompt is stable).

Cache tokens appear in the OpenRouter usage response as
`cache_creation_input_tokens` and `cache_read_input_tokens`. The app stores
them in `llm_usage` and applies Anthropic's pricing:

| Token type | Rate |
|---|---|
| Normal input (`prompt_tokens`) | $3.00 / 1 M |
| Cache write (`cache_creation_input_tokens`) | $3.75 / 1 M (25 % premium) |
| Cache read (`cache_read_input_tokens`) | $0.30 / 1 M (90 % discount) |
| Output (`completion_tokens`) | $15.00 / 1 M |

The **Admin → Uso LLM** page shows a "Caché hits" column per provider
(formula: `cache_read / (prompt + cache_read) × 100 %`).

### CLI path (Claude Code `claude -p`) — not feasible

**Investigation results (issue #510, May 2026):** Two approaches were tested
to determine whether the Claude CLI benefits from caching:

1. **`--system-prompt` flag** — the `claude -p` invocation uses stdin for the
   full prompt (to avoid OS `E2BIG` limits on large prompts). The
   `--output-format stream-json --verbose` output does **not** include a
   `usage` object with cache token fields. The binary provides no signal
   whether caching occurred.

2. **`--resume <session-id>`** — would require maintaining a session ID per
   conversation and plumbing it through the agentic runner. The CLI binary
   exposes no API to query whether the resumed session's context is cached
   on Anthropic's side, so even if implemented we could not verify cache hits.

**Conclusion**: CLI rows write `NULL` for `cache_creation_input_tokens` and
`cache_read_input_tokens` in `llm_usage`.  `NULL` means "not supported /
unknown", distinct from `0` which would mean "zero cache activity reported".
The admin page shows "N/A" for CLI cache hit rate.

Follow-up issue to revisit: if Anthropic adds cache token reporting to the
Claude CLI's JSON output format, the runner can be updated to parse and
persist them.

## Conversaciones libres (free-chat)

> **Status**: Design documentation. The components and endpoints in this section are planned for implementation in issue #616. File paths reference the planned targets; verify existence before using.

A "free conversation" is one created with `context_kind='global'` and `mode='chat'`. It is NOT tied to a specific dashboard. The user can ask data questions, inspect the schema, explore saved dashboards, and then request a new dashboard — all in one continuous thread.

### Creating a free conversation

```typescript
// POST /api/conversations
{ mode: 'chat', context_kind: 'global', first_user_prompt?: string }
// → { id, ... }  then navigate to /c/:id
```

The UI entry point is the **"+ Nueva conversación"** button on `/conversations` (`dashboard/app/conversations/page.tsx`), which opens `NewConversationDialog` (`dashboard/components/NewConversationDialog.tsx`).

### FREE_CHAT_TOOLS catalog (11 tools)

Defined in `dashboard/lib/llm-tools/catalog.ts` as the named export `FREE_CHAT_TOOLS`. These are the only tools exposed to the agentic runner when `conversation.mode === 'chat'` or `context_kind === 'global'`:

| Tool | Purpose |
|------|---------|
| `validate_query` | SQL syntax + policy check (no rows) |
| `execute_query` | Run a read-only SELECT, returns up to 200×30 cells |
| `explain_query` | EXPLAIN (FORMAT JSON) plan without executing |
| `list_ps_tables` | List all `ps_*` mirror tables |
| `describe_ps_table` | Column list + types for one `ps_*` table |
| `list_dashboards` | List saved dashboards (id, name, updated_at) |
| `get_dashboard_spec` | Load the JSON spec for a saved dashboard |
| `get_dashboard_queries` | All SQL strings embedded in a dashboard |
| `get_dashboard_widget_raw_values` | Execute one widget's SQL from a saved dashboard |
| `get_dashboard_all_widget_status` | Validate all SQL in a saved dashboard |
| `start_dashboard_generation` | Trigger dashboard creation and handoff |

Write tools (`apply_dashboard_modification`, `submit_dashboard_analysis`) are registered in `FULL_DASHBOARD_TOOLS` but **not** included in `FREE_CHAT_TOOLS`. This is intentional — see D-032.

### `start_dashboard_generation` tool

Input: `{ prompt: string, template?: string }`  
Output: `{ dashboard_id: number, redirect_url: string, summary: string }`

The handler (`dashboard/lib/llm-tools/handlers/start-dashboard-generation.ts`):
1. Calls the dashboard generation logic (same as `/api/dashboard/generate`)
2. Persists the new dashboard to the DB
3. Calls `POST /api/conversations/:id/handoff-to-dashboard` with `{ dashboard_id }`
4. Returns `{ dashboard_id, redirect_url: '/dashboard/:id?continue=:convId', summary }`

The LLM includes the `redirect_url` as a clickable link in its reply so the user can navigate to the new dashboard.

### `POST /api/conversations/:id/handoff-to-dashboard` endpoint

File: `dashboard/app/api/conversations/[id]/handoff-to-dashboard/route.ts`

Mutates the conversation row:
```sql
UPDATE conversations
SET mode = 'modify',
    context_kind = 'dashboard',
    context_ref  = :dashboard_id,
    context_url  = '/dashboard/:dashboard_id'
WHERE id = :convId
```

**What stays immutable**: `initial_context`, all `conversation_messages` rows. The existing thread remains as an audit trail.

**Error cases**: 404 if `dashboard_id` does not exist; 409 if the conversation is archived.

Helper: `migrateConversationToDashboard(convId, dashboardId)` in `dashboard/lib/conversations.ts`.

### `?continue=:convId` query param

When the user navigates to `/dashboard/:id?continue=:convId` (note: singular `/dashboard/`), `DashboardSurface` (`dashboard/components/surfaces/DashboardSurface.tsx`) reads the `continue` searchParam via `useSearchParams()` and passes it to `ChatSidebar` as `initialConversationId`. The sidebar:
1. Loads the conversation by ID (same as `?conversation=:id`)
2. Opens the **Modificar** tab by default
3. Disables the **Generar** tab (the conversation already has a dashboard)

The user sees the full prior message history from the free-chat, and new messages are appended to the same `conversations` row.

### System prompt and context assembly

Free-chat system prompt is assembled in `dashboard/lib/conversation-context.ts` by `buildFreeChatContext()`. It uses the same knowledge bundle as generate/modify (from `dashboard/lib/knowledge.ts`) plus a Spanish preámbulo explaining the available tools. The `initial_context` snapshot stored at conversation start includes:
- `system_prompt_stable`: the full assembled prompt
- `tools`: array of `{name, schema}` for all 11 `FREE_CHAT_TOOLS`
- `flow: 'chat'`
- `config`: agentic limits (`tool_rounds_max`, `tool_calls_max`, `tool_timeout_ms`)

Prior turns are loaded and capped via `buildHistory()` / `capHistory()` in `dashboard/lib/llm-context/history.ts` (older messages beyond `HISTORY_MAX_MESSAGES` are summarised into one synthetic assistant message).

## Dependencies

- next: 14+
- @tremor/react: latest
- pg: PostgreSQL client
- openai: OpenRouter-compatible SDK
- tailwindcss: styling
- zod: spec validation
