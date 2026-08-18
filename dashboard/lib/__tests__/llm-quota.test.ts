/**
 * Subscription-quota parsing and the stop-at-N% decision (D-106).
 *
 * The fixture below is REAL output captured from
 * `claude -p "/usage" --output-format json` on a Max account, not invented —
 * including the "·" separator and the trailing contributing-factors prose the
 * parser has to ignore.
 */
import { describe, it, expect } from "vitest";
import {
  parseUsageOutput,
  evaluateQuota,
  isQuotaUnknown,
  peakPctUsed,
  type QuotaSnapshot,
} from "../llm-quota";

const REAL_OUTPUT = `You are currently using your subscription to power your Claude Code usage

Current session: 11% used · resets Aug 18 at 4:59am (Europe/Madrid)
Current week (all models): 12% used · resets Aug 21 at 12pm (Europe/Madrid)
Current week (Fable): 8% used · resets Aug 21 at 12pm (Europe/Madrid)

What's contributing to your limits usage?
Approximate, based on local sessions on this machine.

Last 24h · 1212 requests · 14 sessions
  100% of your usage came from subagent-heavy sessions
  93% of your usage was at >150k context`;

describe("parseUsageOutput", () => {
  it("extracts all three windows from real CLI output", () => {
    const s = parseUsageOutput(REAL_OUTPUT);
    expect(s.session?.pctUsed).toBe(11);
    expect(s.week?.pctUsed).toBe(12);
    expect(s.weekTopModel?.pctUsed).toBe(8);
    expect(s.session?.resetsAt).toContain("Aug 18");
  });

  it("does not mistake the contributing-factors percentages for windows", () => {
    // "100% of your usage came from..." must not become a quota window.
    const s = parseUsageOutput(REAL_OUTPUT);
    expect(peakPctUsed(s)).toBe(12);
  });

  it("matches the top-model window structurally, not by model name", () => {
    // The bracketed name varies with the plan; "(Opus)" must work as well.
    const s = parseUsageOutput("Current week (Opus): 42% used · resets tomorrow");
    expect(s.weekTopModel?.pctUsed).toBe(42);
    expect(s.week).toBeNull();
  });

  it("returns an unknown snapshot for the container's session-cost output", () => {
    // What a CLAUDE_CODE_OAUTH_TOKEN-authenticated CLI answers instead.
    const s = parseUsageOutput(
      "Total cost: $0.0000\nTotal duration (API): 0s\nUsage: 0 input, 0 output",
    );
    expect(isQuotaUnknown(s)).toBe(true);
  });

  it("degrades to unknown on junk rather than throwing", () => {
    expect(isQuotaUnknown(parseUsageOutput(""))).toBe(true);
    expect(isQuotaUnknown(parseUsageOutput("<html>login required</html>"))).toBe(true);
  });

  it("rejects an out-of-range percentage", () => {
    expect(parseUsageOutput("Current session: 420% used").session).toBeNull();
  });
});

describe("evaluateQuota", () => {
  const fresh = (over: Partial<QuotaSnapshot> = {}): QuotaSnapshot => ({
    session: { pctUsed: 10, resetsAt: null },
    week: { pctUsed: 20, resetsAt: null },
    weekTopModel: null,
    readAt: new Date().toISOString(),
    ...over,
  });

  it("allows when every window is under the threshold", () => {
    const v = evaluateQuota(fresh(), 80, 1800);
    expect(v.allowed).toBe(true);
    expect(v.reason).toBe("under_threshold");
  });

  it("blocks on whichever window crosses first — session, not just weekly", () => {
    // The session window is the one that bites first in practice; a cap that
    // only watched the weekly number would let a burst blow through it.
    const v = evaluateQuota(fresh({ session: { pctUsed: 85, resetsAt: null } }), 80, 1800);
    expect(v.allowed).toBe(false);
    if (!v.allowed) {
      expect(v.window).toBe("session");
      expect(v.pctUsed).toBe(85);
    }
  });

  it("blocks exactly AT the threshold, not just above it", () => {
    expect(evaluateQuota(fresh({ week: { pctUsed: 80, resetsAt: null } }), 80, 1800).allowed)
      .toBe(false);
  });

  it("is disabled at threshold 0 — the default", () => {
    const v = evaluateQuota(fresh({ week: { pctUsed: 99, resetsAt: null } }), 0, 1800);
    expect(v.allowed).toBe(true);
    expect(v.reason).toBe("disabled");
  });

  it("treats a stale reading as unknown: allows, but says the cap is not enforced", () => {
    // A dead poller must not take the product down...
    const old = fresh({ readAt: new Date(Date.now() - 3600_000).toISOString() });
    const v = evaluateQuota(old, 80, 1800);
    expect(v.allowed).toBe(true);
    expect(v.reason).toBe("unknown");
  });

  it("treats a missing reading as unknown, never as 0% used", () => {
    // ...and equally must not be read as "plenty of headroom".
    const v = evaluateQuota(null, 80, 1800);
    expect(v.allowed).toBe(true);
    expect(v.reason).toBe("unknown");
    expect(v.pctUsed).toBeNull();
  });

  it("still blocks on a stale-but-valid reading once it is refreshed", () => {
    const v = evaluateQuota(
      fresh({ week: { pctUsed: 95, resetsAt: null }, readAt: new Date().toISOString() }),
      80,
      1800,
    );
    expect(v.allowed).toBe(false);
  });
});
