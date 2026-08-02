# Skill: LLM Context Module

**Use when**: Adding a new LLM flow, changing how prompts/history/tools are assembled, enforcing the llm-context boundary, or debugging why an LLM call behaves unexpectedly.

> **Status**: this describes the module and code as inherited from the source project (powershop-analytics) — the architecture (single `assembleRequest` entry point, CI-enforced import boundary) is exactly what issue #1 §14 identifies as reusable, and task 1.1 (#9) intentionally leaves this code untouched rather than rewriting it ahead of schedule. The **named flows table below is the old project's BI-dashboard flow catalog** (`generate`/`modify`/`analyze`/`suggest`/`gap`/`weekly`/`chat`/`summary`) and will be replaced by inmo-tool's own flows (`occupancy`/`condition`/`redflags`/`extract`/`chat`/`compare`) in task 4.1 (#24). Everything about *how* a flow is added/assembled below stays accurate until then.

## Location

```
dashboard/lib/llm-context/
├── index.ts          # Public API — import from here only
├── assemble.ts       # assembleRequest() — the single LLM entry point
├── system-prompt.ts  # buildSystemPrompt() dispatch + all prompt builders
├── history.ts        # buildHistory(), capHistory() (+ flattenStoredMessage)
├── tools.ts          # toolsForFlow() — per-flow tool catalog selector
├── types.ts          # FlowVars, shared types
└── formatters.ts     # formatSchema(), formatRelationships(), etc.
```

CI lint rule: `dashboard/scripts/check-llm-context.sh` — no file **outside** `llm-context/` may import `llmComplete` or `runAgenticChat` directly. This is enforced in the `dashboard-test` CI job.

## Public API (all from `@/lib/llm-context`)

### `assembleRequest(flow, vars, conversationId, userMessage, opts?): Promise<AssembleResult>`

The **only** entry point for all LLM calls in the dashboard. Internally:
1. Calls `buildSystemPrompt(flow, vars)` → `{ stable, volatile? }`
2. Calls `buildHistory(conversationId, opts)` → prior message array
3. Calls `toolsForFlow(flow)` → tool catalog for this flow
4. Loads provider config → model, openRouterProvider
5. Executes via `runAgenticChat` (when `DASHBOARD_AGENTIC_TOOLS_ENABLED=true`) or `llmComplete` (single-shot)
6. Returns `AssembleResult { text, usage, model }`

```typescript
import { assembleRequest } from "@/lib/llm-context";

const result = await assembleRequest(
  "generate",              // flow name
  {},                      // FlowVars — empty for generate
  null,                    // conversationId (null = no history)
  "Crea un dashboard de ventas",
  {
    requestId: "req_abc",
    endpoint: "generateDashboard",
    temperature: 0.2,
    maxOutputTokens: 8192,
  }
);
console.log(result.text);  // JSON spec string
```

### `FlowVars` — per-flow input variables

All fields are optional; each flow uses only the subset relevant to it:

| Field | Flow(s) | Purpose |
|-------|---------|---------|
| `currentSpec` | `modify` | Serialised JSON of the current dashboard spec |
| `agenticMode` | `modify` | When true, includes publish-tool workflow instructions |
| `serializedData` | `analyze`, `summary` | Formatted widget data from `serializeWidgetData()` |
| `action` | `analyze` | Preset analysis action (e.g. `"analyze"`, `"insights"`) |
| `dashboardId` | `analyze` | Dashboard ID for tool references |
| `role` | `suggest` | User role string (e.g. `"Director de ventas"`) |
| `existingDashboards` | `suggest`, `gap` | Array of `{title, description, widgetTitles?}` |
| `queryResults` | `weekly` | Formatted SQL query results for the weekly review |
| `reviewedWeekDescription` | `weekly` | Spanish description of the reviewed week |
| `generationMode` | `weekly` | `"initial"` \| `"refresh_data"` \| `"alternate_angle"` |

### `AssembleResult`

```typescript
interface AssembleResult {
  text: string;           // LLM output text
  usage: NormalizedUsage; // Token counts (prompt, completion, cache)
  model: string;          // Model identifier used
}
```

### `AssembleExecutionOpts`

```typescript
interface AssembleExecutionOpts {
  priorMessages?: HistoryMessage[];  // Pre-loaded history (skips DB load)
  ctx?: LlmAgenticContext;           // Mutable agentic context for side-channel results
  temperature?: number;              // Default: 0.2
  maxOutputTokens?: number;          // Default: 8192
  requestId?: string | null;
  endpoint?: string;
  onTextDelta?: (chars: number, totalChars: number) => void;
}
```

**ctx fields the run populates**, read by the caller **after** `assembleRequest()` returns:

| ctx field | Set by | Used by |
|-----------|--------|---------|
| `ctx.toolCalls` | the tool-loop runner | `turn-background.ts`, persisted on the assistant message |
| `ctx.llmProvider` | `assembleRequest` itself | Telemetry, `turn-background.ts` |
| `ctx.llmDriver` | `assembleRequest` itself | Telemetry |

> The write-back side-channel slots (`ctx.modifyResult`, `ctx.analyzeResult`,
> `ctx.reviewResult`) were removed in #24 along with the dashboard publish
> tools that set them. The real-estate flows return their JSON in the response
> text rather than staging it on `ctx`; nothing mutates `ctx` except the runner
> appending to `toolCalls`.

### `buildSystemPrompt(flow, vars): { stable: string; volatile?: string }`

Returns the prompt split for a flow. Exported for testing and advanced usage. For production LLM calls, always use `assembleRequest` instead.

| Flow | stable | volatile |
|------|--------|----------|
| `generate` | Full schema + instructions + SQL pairs | — |
| `modify` | Schema + instructions | Current spec JSON |
| `analyze` | Schema + instructions | Serialized widget data |
| `suggest` | Minimal instructions | — |
| `gap` | Minimal instructions | — |
| `weekly` | Review query instructions + schema | Query results |
| `chat` | Free-chat instructions + full schema | — |
| `summary` | Suggestion context | — |

### `buildHistory(conversationId, opts?): Promise<HistoryMessage[]>`

Loads prior messages for a conversation from the DB and caps them via `capHistory()`. Returns `[]` when `conversationId` is `null` or the conversation has no messages. Pass `opts.priorMessages` to bypass the DB load (used in `turn-background.ts`) — the cap is applied either way.

### `capHistory(messages, maxMessages = HISTORY_MAX_MESSAGES): Promise<HistoryMessage[]>`

Bounds the history sent to the LLM. When over the cap, older messages are summarised (small LLM call, with a non-failing fallback) into one synthetic assistant message followed by the most recent messages. No-op when within the cap.

### `toolsForFlow(flow): ChatCompletionTool[]`

Returns the tool catalog slice for this flow:
- `chat` → `CHAT_TOOLS` (read-only inspection over the `LLM_VISIBLE_TABLES` allowlist)
- `occupancy` / `condition` / `redflags` / `extract` / `compare` → `[]`

The empty array is not merely an optimisation — it **is** the switch that routes
a flow to the single-shot `llmComplete` path instead of the tool loop. An
assessment flow must never acquire tools: it could then query other properties
mid-assessment, which is the cross-property bleed the single-shot design (and
the matching `buildHistory` short-circuit) exists to prevent.

## Named flows

| Flow | Caller | Mode | Description |
|------|--------|------|-------------|
| `generate` | `generateDashboard()` | agentic | Generate a new dashboard spec from a natural-language prompt |
| `modify` | `modifyDashboard()` | agentic | Update an existing dashboard spec |
| `analyze` | `analyzeDashboard()` | agentic | Analyze widget data and return narrative insights |
| `suggest` | `suggestDashboards()` | single-shot | Suggest 3–4 dashboards for a given role |
| `gap` | `analyzeGaps()` | single-shot | Identify coverage gaps in existing dashboards |
| `weekly` | `generateReview*()` | agentic (or single-shot) | Generate the weekly business review |
| `chat` | `runFreeChatTurn()` | agentic | Free-chat conversation with data-access tools |
| `summary` | `generateSuggestions()` | single-shot | Generate follow-up prompt suggestions after analysis |

## Adding a new flow

1. **Add a `FlowVars` field** in `dashboard/lib/llm-context/types.ts` if the flow needs new inputs.
2. **Add a case** in `buildSystemPrompt()` in `dashboard/lib/llm-context/system-prompt.ts`:
   ```typescript
   case "myflow": {
     const stable = buildMyFlowPrompt(vars);
     return { stable };
   }
   ```
3. **Add a case** in `toolsForFlow()` in `dashboard/lib/llm-context/tools.ts` if the flow needs tools.
4. **Call `assembleRequest("myflow", vars, ...)`** from the caller (e.g. `llm.ts` or an API route).
5. **Do NOT import `llmComplete` or `runAgenticChat` directly** — the CI lint will fail.

## CI enforcement

`dashboard/scripts/check-llm-context.sh` greps all `.ts` files outside `llm-context/` for direct imports of `llmComplete` or `runAgenticChat`. Run it locally:

```bash
bash dashboard/scripts/check-llm-context.sh
```

The `dashboard-test` CI job runs this check after `npm test`. A violation fails the job with a message like:

```
VIOLATION: dashboard/lib/some-file.ts imports llmComplete directly
```

## Testing patterns

When unit-testing a function that calls `assembleRequest`, mock `@/lib/llm-context` directly — do NOT try to mock the underlying `llmComplete` or `runAgenticChat` (Vitest's alias-path resolution does not guarantee the mock intercepts calls from inside `assemble.ts`):

```typescript
const mockAssembleRequest = vi.fn();

vi.mock("@/lib/llm-context", () => ({
  assembleRequest: (...a: unknown[]) => mockAssembleRequest(...a),
  buildFreeChatContext: () => ({ systemPrompt: { stable: "..." }, tools: [] }),
}));

// In beforeEach:
mockAssembleRequest.mockResolvedValue({ text: "response", usage: {}, model: "m" });

// To simulate the runner recording tool calls on ctx:
mockAssembleRequest.mockImplementation(async (_flow, _vars, _convId, _msg, opts) => {
  if (opts?.ctx) {
    opts.ctx.toolCalls = [
      { id: "c1", name: "list_tables", arguments: "{}", result: "{}", ok: true, ms: 3 },
    ];
  }
  return { text: "He consultado las tablas.", usage: {}, model: "m" };
});
```

See `dashboard/lib/__tests__/llm-attach-telemetry.test.ts` for a full example.
