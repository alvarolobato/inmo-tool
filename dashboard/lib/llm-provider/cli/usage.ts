/**
 * Token/cost accounting for the Claude Code CLI provider.
 *
 * ## Why this exists
 *
 * Before this module the CLI path reported **nothing**: `llmComplete` logged a
 * hard-coded `EMPTY_USAGE` for every `cli` call and `logUsage` wrote
 * `estimated_cost_usd = 0` for every `llm_provider = 'cli'` row. Every panel
 * built on `llm_usage` therefore showed zero tokens and zero spend for the
 * DEFAULT provider — the owner could not see what was being spent, let alone
 * why it was high.
 *
 * The CLI does report usage; we were throwing it away. `claude -p
 * --output-format json` returns a single envelope, and `--output-format
 * stream-json` ends with an equivalent `{"type":"result", ...}` line. Both
 * carry:
 *
 *   {
 *     "result": "<assistant text>",
 *     "total_cost_usd": 0.0176284,
 *     "usage": {
 *       "input_tokens": 9,
 *       "output_tokens": 36,
 *       "cache_creation_input_tokens": 7521,
 *       "cache_read_input_tokens": 18134
 *     },
 *     "modelUsage": { "<model id>": { "costUSD": ..., ... } }
 *   }
 *
 * `total_cost_usd` is the CLI's own list-price computation for the call, so a
 * `cli` row can carry a REAL cost rather than an estimate derived from a rate
 * table we would otherwise have to keep in sync by hand.
 *
 * ## Token semantics (matches the OpenRouter normalisation in `llm-usage.ts`)
 *
 * Anthropic reports `input_tokens` EXCLUSIVE of cache tokens — cache-creation
 * and cache-read are separate counters, each billed at its own rate. That is
 * the same normalisation `logUsage` already documents for OpenRouter, so the
 * mapping is direct: `prompt_tokens = input_tokens`, cache counters passed
 * through verbatim, and **`total_tokens = prompt + completion`**.
 *
 * `total_tokens` deliberately EXCLUDES the cache counters, matching what
 * OpenRouter puts in the same column. An earlier version summed all four so
 * the panel would show "real volume moved" — but `/admin/usage` sums that
 * column across providers, so a CLI row reporting 25,700 next to an OpenRouter
 * row reporting 45 made the total meaningless, and `prompt + completion !=
 * total` on one provider only. Cache volume has its own two columns; anything
 * that wants the full picture adds them up explicitly.
 *
 * ## What `cost_usd` covers (wider than the token counts)
 *
 * `total_cost_usd` is the cost of everything the CLI did for the invocation,
 * while the top-level `usage` block describes the MAIN turn only. A probe of
 * one lean call showed `modelUsage` carrying two entries — the main turn plus
 * a small un-attributed auxiliary call — with `total_cost_usd` covering both.
 * So the cost figure is the more complete of the two, and deriving €/token
 * from a single CLI row will not reconcile. That is a property of the CLI, not
 * of this parser; `CLI_LEAN_ARGS` does not remove the auxiliary call.
 *
 * ## `CLI_LEAN_ARGS` — the harness-overhead fix
 *
 * `claude -p` is an agent harness, not a bare completion endpoint. Invoked
 * with defaults it prepends its own Claude Code system prompt, the full
 * built-in tool catalog, discovered CLAUDE.md files, MCP server definitions
 * and user/project settings to EVERY call. Measured on this machine with the
 * identical trivial task (`reply with exactly: OK`, haiku-4.5):
 *
 *   default flags:  25,664 input tokens  →  $0.017628
 *   CLI_LEAN_ARGS:     167 input tokens  →  $0.001011   (17.4x cheaper)
 *
 * None of that harness context is useful to us: the dashboard supplies its own
 * system prompt, and the agentic protocol has the SERVER execute our tools
 * (the model only emits a JSON envelope naming them — see `claude-code.ts`),
 * so Claude's built-in tools are never called. `CLI_LEAN_ARGS` strips the lot.
 *
 * `--system-prompt` is applied per call site rather than being part of this
 * constant, and carries the caller's small PROTOCOL SHIM — its job is to
 * displace the harness prompt, not to deliver the dashboard's domain system
 * prompt (which still travels in stdin). See `claude-code.ts`'s `leanArgs`.
 *
 * Gated by `dashboard.llm_cli_lean_mode` (default true) so a regression can be
 * turned off in config without a redeploy.
 */

/**
 * Flags that strip the Claude Code harness context from a non-interactive run.
 *
 * - `--tools ""`             built-in tool catalog (Bash/Edit/Read/…) — unused
 *                            by both CLI flows, and the largest single chunk.
 * - `--disable-slash-commands`  skill definitions.
 * - `--strict-mcp-config`    ignore ambient MCP servers (we pass none).
 * - `--setting-sources ""`   ignore user/project/local settings files.
 *
 * Deliberately NOT included: `--bare`, which forces `ANTHROPIC_API_KEY` auth
 * and never reads the OAuth credentials file the launchd sync maintains
 * (D-025) — it would break auth outright.
 */
export const CLI_LEAN_ARGS: readonly string[] = [
  "--tools",
  "",
  "--disable-slash-commands",
  "--strict-mcp-config",
  "--setting-sources",
  "",
];

/** Normalised usage for one CLI invocation. `null` fields = not reported. */
export interface CliReportedUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  cache_creation_input_tokens: number | null;
  cache_read_input_tokens: number | null;
  /** The CLI's own list-price cost for this call (`total_cost_usd`). */
  cost_usd: number | null;
}

function readNonNegativeInt(v: unknown): number | null {
  if (typeof v !== "number" || !Number.isFinite(v) || v < 0) return null;
  return Math.round(v);
}

/**
 * Extract usage from a `--output-format json` envelope or a `stream-json`
 * `{"type":"result"}` line (identical shape for these fields).
 *
 * Defensive by design: an older binary, a shape change, or an error envelope
 * yields `null` rather than throwing — telemetry must never be able to fail a
 * user-facing LLM call. `null` is logged as "unreported", not as zero spend.
 */
export function parseCliReportedUsage(envelope: unknown): CliReportedUsage | null {
  if (!envelope || typeof envelope !== "object" || Array.isArray(envelope)) return null;
  const o = envelope as Record<string, unknown>;

  const rawUsage = o.usage;
  const cost =
    typeof o.total_cost_usd === "number" && Number.isFinite(o.total_cost_usd) && o.total_cost_usd >= 0
      ? o.total_cost_usd
      : null;

  if (!rawUsage || typeof rawUsage !== "object" || Array.isArray(rawUsage)) {
    // Cost without a token breakdown is still worth recording.
    if (cost === null) return null;
    return {
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0,
      cache_creation_input_tokens: null,
      cache_read_input_tokens: null,
      cost_usd: cost,
    };
  }

  const u = rawUsage as Record<string, unknown>;
  const input = readNonNegativeInt(u.input_tokens) ?? 0;
  const output = readNonNegativeInt(u.output_tokens) ?? 0;
  const cacheCreation = readNonNegativeInt(u.cache_creation_input_tokens);
  const cacheRead = readNonNegativeInt(u.cache_read_input_tokens);

  return {
    prompt_tokens: input,
    completion_tokens: output,
    // Excludes the cache counters on purpose — same column semantics as the
    // OpenRouter path. See the module doc.
    total_tokens: input + output,
    cache_creation_input_tokens: cacheCreation,
    cache_read_input_tokens: cacheRead,
    cost_usd: cost,
  };
}
