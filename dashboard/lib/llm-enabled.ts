/**
 * The master LLM kill switch (`dashboard.llm_enabled`).
 *
 * ## Why a new switch when three already existed
 *
 * `dashboard.assessment_auto_enabled`, `notifications.digest_auto_enabled` and
 * `notifications.seguimiento_auto_enabled` each stop their OWN scheduled pass.
 * None of them stops:
 *
 *   - the chat / agentic flows,
 *   - a hand-clicked `POST /api/properties/[id]/assessments/*`,
 *   - the compare flow,
 *   - conversation-history summarisation (which fires on any long chat).
 *
 * So "turn the AI off" previously meant flipping three keys and still leaving
 * every interactive path able to spend. This switch is the one that means what
 * it says: with it false, the process makes ZERO model calls.
 *
 * ## Where it is enforced
 *
 * At the two seams every LLM call in the dashboard passes through (D-006):
 * `llmComplete` (single-shot) and `assembleRequest`'s agentic branch. Because
 * CI forbids importing `llmComplete`/`runAgenticChat` anywhere else, guarding
 * those two covers the whole surface by construction — there is no third path
 * to forget. The schedulers additionally refuse to start, so a disabled
 * install logs one line at boot instead of waking up every 15 minutes to
 * discover it is not allowed to work.
 *
 * Read fresh on each call (via the memoised system-config loader) rather than
 * captured at import time, so flipping it in `/admin/config` takes effect on
 * the next call for interactive paths — the schedulers still need the restart
 * the schema advertises, since they only read it at boot.
 */

import { getSystemConfig } from "@/lib/system-config/loader";
import { evaluateQuota } from "@/lib/llm-quota";
import { getLatestQuotaReading } from "@/lib/db/llm-quota";

/**
 * Raised instead of calling the model when `dashboard.llm_enabled` is false.
 *
 * `name` is set explicitly: callers match on it the same way the assessment
 * failure ledger's exemption does (D-104), to avoid import cycles.
 */
export class LlmDisabledError extends Error {
  constructor() {
    super(
      "La IA está desactivada (dashboard.llm_enabled = false). " +
        "Actívela en /admin/config para volver a permitir llamadas al modelo.",
    );
    this.name = "LlmDisabledError";
  }
}

/**
 * Is the LLM allowed to be called at all?
 *
 * Fails OPEN (returns true) when the config loader is unavailable — a build
 * context or a missing schema file must not silently disable the product. The
 * switch is for deliberate operator intent, not for degraded environments.
 */
export function isLlmEnabled(): boolean {
  let raw: unknown;
  try {
    raw = getSystemConfig()["dashboard.llm_enabled"]?.value;
  } catch {
    return true;
  }
  if (raw === null || raw === undefined || String(raw).trim() === "") return true;
  const v = String(raw).trim().toLowerCase();
  return !(v === "false" || v === "0" || v === "no");
}

/** Throw `LlmDisabledError` when the switch is off. Call before any model call. */
export function assertLlmEnabled(): void {
  if (!isLlmEnabled()) throw new LlmDisabledError();
}

/**
 * Raised when the account's subscription quota has reached the configured
 * stop threshold (`dashboard.llm_quota_stop_pct`). See D-106.
 *
 * Distinct from `LlmDisabledError`: the AI is switched ON, we are simply out
 * of headroom for now, and the window resets on its own.
 */
export class LlmQuotaExceededError extends Error {
  constructor(
    readonly pctUsed: number,
    readonly window: string,
    readonly threshold: number,
  ) {
    super(
      `Consumo de la suscripción al ${pctUsed}% en la ventana "${window}" ` +
        `(tope configurado: ${threshold}%). Las llamadas al LLM se reanudarán ` +
        `cuando la ventana se renueve o si sube dashboard.llm_quota_stop_pct.`,
    );
    this.name = "LlmQuotaExceededError";
  }
}

function readInt(key: string, fallback: number): number {
  try {
    const raw = getSystemConfig()[key]?.value;
    if (raw === null || raw === undefined || String(raw).trim() === "") return fallback;
    const n = Number(String(raw).trim());
    return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
  } catch {
    return fallback;
  }
}

/**
 * Throw when the subscription quota cap is reached.
 *
 * Async because the reading lives in Postgres (it is produced outside this
 * process — only credential-file auth can see the quota view). Cheap: one
 * indexed single-row read, and skipped entirely when the cap is disabled,
 * which is the default.
 *
 * Fails OPEN on any error, deliberately. A cap is a cost guard, not a
 * correctness gate: a DB blip must not stop the product from working. The
 * "unknown" state is surfaced rather than silently treated as 0%.
 */
export async function assertQuotaAvailable(): Promise<void> {
  const threshold = readInt("dashboard.llm_quota_stop_pct", 0);
  if (threshold <= 0) return; // disabled — no query at all

  const maxAge = readInt("dashboard.llm_quota_max_age_seconds", 1800);
  let snapshot = null;
  try {
    snapshot = await getLatestQuotaReading();
  } catch (err) {
    console.warn("[llm-quota] could not read the latest quota reading:", err);
    return; // fail open
  }

  const verdict = evaluateQuota(snapshot, threshold, maxAge);
  if (!verdict.allowed) {
    throw new LlmQuotaExceededError(verdict.pctUsed, verdict.window, verdict.threshold);
  }
}
