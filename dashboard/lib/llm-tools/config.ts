/**
 * Agentic tool-calling limits (Dashboard App).
 * Env overrides match issue #384 / ops runbooks.
 */

function readInt(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (raw === undefined || raw === "") return fallback;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function readBool(name: string, defaultTrue: boolean): boolean {
  const raw = process.env[name]?.trim()?.toLowerCase();
  if (raw === undefined || raw === "") return defaultTrue;
  if (raw === "true" || raw === "1" || raw === "yes") return true;
  if (raw === "false" || raw === "0" || raw === "no") return false;
  return defaultTrue;
}

export function isAgenticToolsEnabled(): boolean {
  return readBool("DASHBOARD_AGENTIC_TOOLS_ENABLED", true);
}

export function getAgenticConfig() {
  return {
    // Dashboard generation often needs several explore→SQL rounds; defaults are conservative caps.
    maxToolRounds: readInt("DASHBOARD_AGENTIC_MAX_TOOL_ROUNDS", 8),
    maxToolCalls: readInt("DASHBOARD_AGENTIC_MAX_TOOL_CALLS", 24),
    toolTimeoutMs: readInt("DASHBOARD_AGENTIC_TOOL_TIMEOUT_MS", 15_000),
    maxRows: readInt("DASHBOARD_AGENTIC_MAX_ROWS", 200),
    maxColumns: readInt("DASHBOARD_AGENTIC_MAX_COLUMNS", 30),
    maxResultChars: readInt("DASHBOARD_AGENTIC_MAX_RESULT_CHARS", 20_000),
  };
}
