/**
 * Dashboard LLM configuration — reads from the central config loader (getSystemConfig),
 * which applies env > config.yaml > schema defaults.
 */

import { getSystemConfig, resetConfigCache } from "@/lib/system-config/loader";
import { parseOpenRouterModelValue } from "./openrouter-selection";
import type {
  DashboardCliDriverId,
  DashboardLlmConfig,
  DashboardLlmFlow,
  DashboardLlmProviderId,
} from "./types";

const DEFAULT_MODEL = "anthropic/claude-sonnet-4";

function normalizeProvider(raw: string | null | undefined): DashboardLlmProviderId {
  // Default is `cli` (config/schema.yaml). The CLI provider uses host claude
  // via the launchd-managed credentials snapshot — see issue #440 / D-025.
  const v = (raw ?? "cli").trim().toLowerCase();
  if (v === "" || v === "cli") return "cli";
  if (v === "openrouter") return "openrouter";
  if (v === "e2e-stub") return "e2e-stub";
  // `mock` drives the FULL pipeline (assembleRequest → runner → real tool
  // dispatch → persistence) with a scripted adapter — for e2e LLM-integration
  // tests. `e2e-stub` short-circuits before any LLM code; `mock` does not.
  if (v === "mock") return "mock";
  throw new Error(
    `Invalid DASHBOARD_LLM_PROVIDER="${raw ?? ""}". Use "cli" or "openrouter" (or "e2e-stub"/"mock" for CI only).`,
  );
}

function normalizeDriver(raw: string | null | undefined): DashboardCliDriverId {
  const v = (raw ?? "claude_code").trim().toLowerCase();
  if (v === "claude_code") return "claude_code";
  throw new Error(
    `Invalid DASHBOARD_LLM_CLI_DRIVER="${raw ?? ""}". Supported values: claude_code`,
  );
}

function parseExtraArgs(raw: string | null | undefined): string[] {
  if (!raw || String(raw).trim() === "") return [];
  // Split on whitespace; callers must not pass shell syntax — document in .env.example.
  return String(raw).trim().split(/\s+/).filter(Boolean);
}

function parsePositiveInt(raw: string | number | boolean | null | undefined, fallback: number): number {
  if (raw === null || raw === undefined || String(raw).trim() === "") return fallback;
  const n = typeof raw === "number" ? raw : parseInt(String(raw), 10);
  if (Number.isNaN(n) || n <= 0) return fallback;
  return n;
}

let _cached: DashboardLlmConfig | null = null;

/** Reset memoized config (tests and after config writes).
 *
 * Also clears the system-config cache so that subsequent calls to
 * loadDashboardLlmConfig() re-read from process.env (important for tests
 * that use vi.stubEnv to vary configuration).
 */
export function resetDashboardLlmConfigCache(): void {
  _cached = null;
  _legacyEnvWarned = false;
  resetConfigCache();
}

/**
 * Load dashboard LLM configuration from the central config loader.
 *
 * Precedence (inherited from getSystemConfig): env > config.yaml > schema defaults.
 *
 * Model resolution:
 * - OpenRouter: per-flow override (llm_model_openrouter_<flow>)
 *               → dashboard.llm_model_openrouter
 *               → DASHBOARD_LLM_MODEL env var (deprecated)
 *               → hard-coded default
 * - CLI: dashboard.llm_model_cli
 *               → DASHBOARD_LLM_MODEL env var (deprecated, only when value
 *                 is in native Claude format — has no slash)
 *               → hard-coded default
 *
 * `dashboard.llm_model` was removed from the schema in favour of explicit
 * per-provider keys. The env var `DASHBOARD_LLM_MODEL` is still read once
 * as a transition fallback so existing deployments don't break, with a
 * one-time deprecation warning. New configs should set
 * `dashboard.llm_model_openrouter` and/or `dashboard.llm_model_cli`.
 */
function readStr(cfg: ReturnType<typeof getSystemConfig>, key: string): string {
  const v = cfg[key]?.value;
  return v !== null && v !== undefined ? String(v).trim() : "";
}

let _legacyEnvWarned = false;
function readLegacyEnvFallback(): string {
  const raw = (process.env.DASHBOARD_LLM_MODEL ?? "").trim();
  if (raw && !_legacyEnvWarned) {
    _legacyEnvWarned = true;
    console.warn(
      "[dashboard/llm] DASHBOARD_LLM_MODEL is deprecated; set " +
        "DASHBOARD_LLM_MODEL_OPENROUTER and/or DASHBOARD_LLM_MODEL_CLI " +
        "explicitly. Falling back to the legacy env var for now.",
    );
  }
  return raw;
}

export function loadDashboardLlmConfig(): DashboardLlmConfig {
  if (_cached) return _cached;

  const cfg = getSystemConfig();

  const providerRaw = cfg["dashboard.llm_provider"]?.value;
  const provider = normalizeProvider(providerRaw !== null ? String(providerRaw ?? "") : undefined);

  const legacyEnv = readLegacyEnvFallback();
  // The legacy env value can be either an OpenRouter id ("vendor/name") or
  // a native Claude id ("claude-sonnet-4-6"). Apply it only to the
  // matching provider so a stale OpenRouter value doesn't leak into the
  // CLI driver as an unknown `--model` flag.
  const legacyForOpenRouter = legacyEnv.includes("/") ? legacyEnv : "";
  const legacyForCli = legacyEnv && !legacyEnv.includes("/") ? legacyEnv : "";

  const openrouterModel =
    readStr(cfg, "dashboard.llm_model_openrouter") || legacyForOpenRouter || DEFAULT_MODEL;

  // Per-flow OpenRouter overrides. Empty string means "no override" — the
  // resolver will fall back to openrouterModel.
  const openrouterModelByFlow: Record<DashboardLlmFlow, string> = {
    generate: readStr(cfg, "dashboard.llm_model_openrouter_generate"),
    modify: readStr(cfg, "dashboard.llm_model_openrouter_modify"),
    analyze: readStr(cfg, "dashboard.llm_model_openrouter_analyze"),
    weekly: readStr(cfg, "dashboard.llm_model_openrouter_weekly"),
  };

  const cliModel =
    readStr(cfg, "dashboard.llm_model_cli") || legacyForCli || "claude-sonnet-4-6";

  const cliDriverRaw = cfg["dashboard.llm_cli_driver"]?.value;
  const cliDriver: DashboardCliDriverId =
    provider === "cli"
      ? normalizeDriver(cliDriverRaw !== null && cliDriverRaw !== undefined ? String(cliDriverRaw) : undefined)
      : "claude_code";

  const cliBinRaw =
    (cfg["dashboard.llm_cli_bin"]?.value !== null && cfg["dashboard.llm_cli_bin"]?.value !== undefined
      ? String(cfg["dashboard.llm_cli_bin"].value).trim()
      : "") || "claude";
  if (/[\r\n]/.test(cliBinRaw)) {
    throw new Error("DASHBOARD_LLM_CLI_BIN must not contain newline characters.");
  }
  const cliBin = cliBinRaw;

  const extraArgsRawValue = provider === "cli" ? cfg["dashboard.llm_cli_extra_args"]?.value : null;
  const extraArgsRaw =
    extraArgsRawValue !== null && extraArgsRawValue !== undefined
      ? String(extraArgsRawValue)
      : undefined;
  const cliExtraArgs = parseExtraArgs(extraArgsRaw);

  const timeoutRaw = provider === "cli" ? cfg["dashboard.llm_cli_timeout_ms"]?.value : undefined;
  const cliTimeoutMs = parsePositiveInt(timeoutRaw, 120_000);

  const captureRaw = provider === "cli" ? cfg["dashboard.llm_cli_max_capture_bytes"]?.value : undefined;
  const cliMaxCaptureBytes = parsePositiveInt(captureRaw, 8_000_000);

  _cached = {
    provider,
    openrouterModel,
    openrouterModelByFlow,
    cliModel,
    cliDriver,
    cliBin,
    cliExtraArgs,
    cliTimeoutMs,
    cliMaxCaptureBytes,
  };
  return _cached;
}

/**
 * Raw stored OpenRouter model value (may include `\t{...}` provider routing).
 */
function resolveOpenRouterStoredModel(cfg: DashboardLlmConfig, flow?: DashboardLlmFlow): string {
  if (flow) {
    const override = cfg.openrouterModelByFlow[flow];
    if (override) return override;
  }
  return cfg.openrouterModel;
}

/**
 * Effective model id for the configured provider (API `model` parameter).
 *
 * For OpenRouter, optional `\t`-suffixed provider JSON is stripped — see
 * `parseOpenRouterModelValue` / `openrouter-selection.ts`.
 *
 * When `flow` is supplied, a non-empty per-flow override wins over the
 * default `openrouterModel`. CLI doesn't differentiate by flow.
 */
export function getEffectiveDashboardModel(
  cfg: DashboardLlmConfig,
  flow?: DashboardLlmFlow,
): string {
  if (cfg.provider !== "openrouter") return cfg.cliModel;
  const raw = resolveOpenRouterStoredModel(cfg, flow);
  return parseOpenRouterModelValue(raw).modelId;
}

/**
 * OpenRouter `provider` routing object for the active model selection, if any.
 * Undefined means use OpenRouter's default multi-provider routing.
 */
export function getEffectiveOpenRouterProvider(
  cfg: DashboardLlmConfig,
  flow?: DashboardLlmFlow,
): Record<string, unknown> | undefined {
  if (cfg.provider !== "openrouter") return undefined;
  const raw = resolveOpenRouterStoredModel(cfg, flow);
  return parseOpenRouterModelValue(raw).provider;
}
