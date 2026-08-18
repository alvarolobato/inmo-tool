/**
 * Subscription quota awareness — the "stop at 80%" cap.
 *
 * ## Why this can exist at all
 *
 * The Claude CLI will tell you your Max-plan consumption, for free:
 *
 *     claude -p "/usage" --output-format json
 *     → "Current session: 11% used · resets Aug 18 at 5am (Europe/Madrid)
 *        Current week (all models): 12% used · resets Aug 21 at 12pm ...
 *        Current week (Fable): 8% used · resets ..."
 *
 * Measured: `total_cost_usd: 0`, 0 input/output tokens, `num_turns: 0`, ~2.6s.
 * It is a metadata command, not a model call, so polling it costs nothing
 * against the very quota it reports.
 *
 * This is the number the owner actually cares about. Under a Max subscription
 * the CLI's `total_cost_usd` is a NOTIONAL list price (D-102), so a dollar cap
 * halts work on imaginary spend; percentage-of-quota is the real currency.
 *
 * ## Two constraints that shape the design
 *
 * 1. **The lean/safety flags break it.** `--disable-slash-commands` (D-103)
 *    makes it answer "/usage isn't available in this environment." The probe
 *    must therefore be its own invocation, deliberately WITHOUT those flags —
 *    which is safe because the probe sends no untrusted content and asks for
 *    no generation.
 *
 * 2. **Only credential-file auth sees it.** Verified by running the host's
 *    newer CLI with the container's `CLAUDE_CODE_OAUTH_TOKEN`: it returns a
 *    local session-cost summary, not the quota view. The subscription view
 *    appears only under the interactive OAuth credentials
 *    (`~/.claude/.credentials.json`). So a container authenticating with the
 *    long-lived setup-token CANNOT read quota, and the reading has to come
 *    from wherever those credentials live — see `readQuotaFromCli` and the
 *    ingest endpoint that lets a host-side poller push it in.
 *
 * ## Semantics of the cap
 *
 * The reading is PER ACCOUNT: it includes the owner's own Claude Code
 * sessions, not just the dashboard's calls. For a cap whose job is to stop the
 * dashboard eating a shared quota, that is the correct denominator — the
 * dashboard should back off when the account is near its limit, whoever spent
 * it.
 *
 * Unknown is not zero. A missing, stale or unparseable reading does NOT block
 * calls (that would let a dead poller take the product down) and does NOT
 * count as 0% (that would let it spend freely while blind). It is surfaced as
 * unknown, and the token/cost budget in `llm-usage.ts` remains the backstop.
 */

/** One parsed window from the CLI's `/usage` output. */
export interface QuotaWindow {
  /** 0–100, as the CLI reports it. */
  pctUsed: number;
  /** Raw reset text, e.g. "Aug 21 at 12pm (Europe/Madrid)". Display only. */
  resetsAt: string | null;
}

export interface QuotaSnapshot {
  /** Rolling ~5h session window. */
  session: QuotaWindow | null;
  /** 7-day window across all models. */
  week: QuotaWindow | null;
  /** 7-day window for the top-tier model, when the plan reports one. */
  weekTopModel: QuotaWindow | null;
  /** When this reading was taken (ISO). */
  readAt: string;
}

/**
 * Parse the CLI's `/usage` prose into structured windows.
 *
 * Deliberately tolerant: the output is human-facing prose that can be
 * reworded, so anything unrecognised yields `null` for that window rather
 * than an exception. A `null` everywhere means "we could not read it", which
 * the caller treats as unknown — never as 0%.
 *
 * The bracketed model name in "Current week (Fable)" varies with the plan, so
 * it is matched structurally ("Current week (<something not 'all models'>)")
 * rather than by name.
 */
export function parseUsageOutput(text: string): QuotaSnapshot {
  const read = (re: RegExp): QuotaWindow | null => {
    const m = re.exec(text);
    if (!m) return null;
    const pct = Number(m[1]);
    if (!Number.isFinite(pct) || pct < 0 || pct > 100) return null;
    return { pctUsed: pct, resetsAt: (m[2] ?? "").trim() || null };
  };

  return {
    session: read(/Current session:\s*(\d+)%\s*used(?:\s*[·.-]\s*resets\s*([^\n]+))?/i),
    week: read(/Current week \(all models\):\s*(\d+)%\s*used(?:\s*[·.-]\s*resets\s*([^\n]+))?/i),
    weekTopModel: read(
      /Current week \((?!all models)[^)]+\):\s*(\d+)%\s*used(?:\s*[·.-]\s*resets\s*([^\n]+))?/i,
    ),
    readAt: new Date().toISOString(),
  };
}

/** True when the snapshot carries no usable window at all. */
export function isQuotaUnknown(s: QuotaSnapshot | null): boolean {
  return !s || (!s.session && !s.week && !s.weekTopModel);
}

/**
 * The highest window percentage in a snapshot — what a single threshold is
 * compared against, so the cap trips on whichever limit is closest to being
 * hit rather than only on the weekly one.
 */
export function peakPctUsed(s: QuotaSnapshot | null): number | null {
  if (!s) return null;
  const vals = [s.session, s.week, s.weekTopModel]
    .filter((w): w is QuotaWindow => w !== null)
    .map((w) => w.pctUsed);
  return vals.length ? Math.max(...vals) : null;
}

export type QuotaVerdict =
  | { allowed: true; reason: "under_threshold" | "unknown" | "disabled"; pctUsed: number | null }
  | { allowed: false; reason: "threshold_reached"; pctUsed: number; window: string; threshold: number };

/**
 * Decide whether an LLM call may proceed.
 *
 * `thresholdPct` of 0 disables the cap. A stale reading (older than
 * `maxAgeSeconds`) is treated as unknown, not as permission to spend blind —
 * but it still allows the call, because a dead poller must not take the
 * product down. The distinction is surfaced through `reason` so the UI can
 * say "cap not enforced: no recent reading" instead of implying it is active.
 */
export function evaluateQuota(
  snapshot: QuotaSnapshot | null,
  thresholdPct: number,
  maxAgeSeconds: number,
  now: Date = new Date(),
): QuotaVerdict {
  if (!thresholdPct || thresholdPct <= 0) {
    return { allowed: true, reason: "disabled", pctUsed: peakPctUsed(snapshot) };
  }
  if (isQuotaUnknown(snapshot)) return { allowed: true, reason: "unknown", pctUsed: null };

  const ageMs = now.getTime() - new Date(snapshot!.readAt).getTime();
  if (!Number.isFinite(ageMs) || ageMs > maxAgeSeconds * 1000) {
    return { allowed: true, reason: "unknown", pctUsed: peakPctUsed(snapshot) };
  }

  const windows: Array<[string, QuotaWindow | null]> = [
    ["session", snapshot!.session],
    ["week", snapshot!.week],
    ["week_top_model", snapshot!.weekTopModel],
  ];
  for (const [name, w] of windows) {
    if (w && w.pctUsed >= thresholdPct) {
      return {
        allowed: false,
        reason: "threshold_reached",
        pctUsed: w.pctUsed,
        window: name,
        threshold: thresholdPct,
      };
    }
  }
  return { allowed: true, reason: "under_threshold", pctUsed: peakPctUsed(snapshot) };
}
