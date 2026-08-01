/**
 * Dashboard LLM transport types (OpenRouter HTTP vs local CLI agents).
 */

export type DashboardLlmProviderId = "openrouter" | "cli" | "e2e-stub" | "mock";

/** First-class CLI driver; add new ids when wiring another binary. */
export type DashboardCliDriverId = "claude_code";

/** Logical "flow" of a dashboard LLM call, used to pick a per-flow model
 *  override on the OpenRouter provider. CLI doesn't differentiate (the
 *  flat-rate Claude subscription makes per-flow tuning pointless). */
export type DashboardLlmFlow = "generate" | "modify" | "analyze" | "weekly";

export interface DashboardLlmConfig {
  provider: DashboardLlmProviderId;
  /** Model id for OpenRouter chat completions (default fallback when no
   *  per-flow override is set). */
  openrouterModel: string;
  /** Per-flow OpenRouter model overrides. Empty string = no override
   *  (falls back to `openrouterModel`). Keyed by `DashboardLlmFlow`. */
  openrouterModelByFlow: Record<DashboardLlmFlow, string>;
  /** Model id / flag value for the active CLI driver (driver-specific). */
  cliModel: string;
  cliDriver: DashboardCliDriverId;
  /** argv[0] — must be a single path or binary name, no shell metacharacters. */
  cliBin: string;
  /** Extra CLI arguments inserted after argv[0], before driver-specific flags. */
  cliExtraArgs: string[];
  cliTimeoutMs: number;
  /** Max captured stdout/stderr per CLI invocation (bytes). */
  cliMaxCaptureBytes: number;
}

export interface LlmUsageProviderMeta {
  provider: DashboardLlmProviderId;
  driver: DashboardCliDriverId | null;
}
