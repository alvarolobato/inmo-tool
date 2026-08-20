// @vitest-environment node
/**
 * Unit tests for the Estado board's pure status derivation (issue #638).
 *
 * The two named exit-criteria cases (EC-2/EC-3) are the load-bearing ones —
 * everything here is designed so each assertion can actually fail: e.g.
 * revert the `pastDoubleWindow` branch and "soft-blocked starved source" goes
 * green; revert the capture "never red from time alone" branch and a merely-
 * awaiting-capture source starts reading atascado/fallando.
 */
import { describe, it, expect } from "vitest";
import {
  deriveSourceStatus,
  worstOfStatuses,
  compareSourceRows,
  type SourceHealthDerivationInput,
} from "../source-health";

const NOW = new Date("2026-08-21T12:00:00Z").getTime();

function crawlInput(
  overrides: Partial<SourceHealthDerivationInput> = {},
): SourceHealthDerivationInput {
  return {
    kind: "crawl",
    freshnessIntervalHours: 24,
    lastActivityAt: new Date(NOW - 2 * 60 * 60 * 1000).toISOString(), // 2h ago
    nowMs: NOW,
    latestRunStatus: "ok",
    latestRunFailureClassification: null,
    captureFailed7d: 0,
    captureTotal7d: 0,
    heartbeatStale: false,
    ...overrides,
  };
}

function captureInput(
  overrides: Partial<SourceHealthDerivationInput> = {},
): SourceHealthDerivationInput {
  return {
    kind: "capture",
    freshnessIntervalHours: 24,
    lastActivityAt: new Date(NOW - 2 * 60 * 60 * 1000).toISOString(),
    nowMs: NOW,
    latestRunStatus: null,
    latestRunFailureClassification: null,
    captureFailed7d: 0,
    captureTotal7d: 0,
    heartbeatStale: false,
    ...overrides,
  };
}

describe("deriveSourceStatus — crawl sources", () => {
  it("EC-2: soft-blocked starved source is atascado, not green", () => {
    // fotocasa's real shape: latest run status='ok' with a soft_block
    // notice, but no listing activity for well over 2x the 24h window.
    const result = deriveSourceStatus(
      crawlInput({
        freshnessIntervalHours: 24,
        lastActivityAt: new Date(NOW - 40 * 60 * 60 * 1000).toISOString(), // 40h ago
        latestRunStatus: "ok",
        latestRunFailureClassification: "soft_block",
      }),
    );
    expect(result.status).toBe("atascado");
    expect(result.reason).toBe("soft_block_stale");
  });

  it("a soft-block inside the window (not yet due) stays fresco", () => {
    const result = deriveSourceStatus(
      crawlInput({
        lastActivityAt: new Date(NOW - 2 * 60 * 60 * 1000).toISOString(),
        latestRunStatus: "ok",
        latestRunFailureClassification: "soft_block",
      }),
    );
    expect(result.status).toBe("fresco");
  });

  it("past 2x the window with no classification is atascado", () => {
    const result = deriveSourceStatus(
      crawlInput({
        freshnessIntervalHours: 10,
        lastActivityAt: new Date(NOW - 25 * 60 * 60 * 1000).toISOString(), // 25h ago, >2x10h
      }),
    );
    expect(result.status).toBe("atascado");
    expect(result.reason).toBe("stale_2x_window");
  });

  it("due but under 2x the window, no error, is pendiente", () => {
    const result = deriveSourceStatus(
      crawlInput({
        freshnessIntervalHours: 10,
        lastActivityAt: new Date(NOW - 15 * 60 * 60 * 1000).toISOString(), // 15h, due, <20h
      }),
    );
    expect(result.status).toBe("pendiente");
  });

  it("a classified fatal failure is fallando regardless of data freshness", () => {
    const result = deriveSourceStatus(
      crawlInput({
        lastActivityAt: new Date(NOW - 30 * 60 * 1000).toISOString(), // 30 min ago
        latestRunStatus: "failed",
      }),
    );
    expect(result.status).toBe("fallando");
    expect(result.reason).toBe("run_failed");
  });

  it("circuit_open is fallando", () => {
    const result = deriveSourceStatus(crawlInput({ latestRunStatus: "circuit_open" }));
    expect(result.status).toBe("fallando");
    expect(result.reason).toBe("circuit_open");
  });

  it("never having ingested anything is due (never silently fresco)", () => {
    const result = deriveSourceStatus(crawlInput({ lastActivityAt: null }));
    expect(result.status).not.toBe("fresco");
    expect(result.ageHours).toBeNull();
  });
});

describe("deriveSourceStatus — capture sources (owner's #636-addendum safety constraint)", () => {
  it("EC-3: recent activity, zero connector_run_results, is fresco", () => {
    const result = deriveSourceStatus(
      captureInput({ lastActivityAt: new Date(NOW - 3 * 60 * 60 * 1000).toISOString() }),
    );
    expect(result.status).toBe("fresco");
  });

  it("past its window with no error signal is pendiente — NEVER red from time alone", () => {
    // idealista-shaped: owner hasn't captured in a week; nothing has failed.
    const result = deriveSourceStatus(
      captureInput({
        freshnessIntervalHours: 24,
        lastActivityAt: new Date(NOW - 7 * 24 * 60 * 60 * 1000).toISOString(), // 7 days
      }),
    );
    expect(result.status).toBe("pendiente");
    expect(result.reason).toBe("pendiente_de_captura");
  });

  it("even far past the window (e.g. 60 days) stays pendiente absent an error signal", () => {
    const result = deriveSourceStatus(
      captureInput({
        freshnessIntervalHours: 24,
        lastActivityAt: new Date(NOW - 60 * 24 * 60 * 60 * 1000).toISOString(),
      }),
    );
    expect(result.status).toBe("pendiente");
  });

  it("a 50% recent capture failure rate is fallando", () => {
    const result = deriveSourceStatus(
      captureInput({ captureFailed7d: 2, captureTotal7d: 4 }),
    );
    expect(result.status).toBe("fallando");
    expect(result.captureFailureRate7d).toBe(0.5);
  });

  it("some but under-50% recent capture failures is atascado, not fallando", () => {
    const result = deriveSourceStatus(
      captureInput({ captureFailed7d: 1, captureTotal7d: 4 }),
    );
    expect(result.status).toBe("atascado");
    expect(result.reason).toBe("capture_partial_failures");
  });

  it("a due source with a long-stale heartbeat is atascado", () => {
    const result = deriveSourceStatus(
      captureInput({
        freshnessIntervalHours: 24,
        lastActivityAt: new Date(NOW - 48 * 60 * 60 * 1000).toISOString(),
        heartbeatStale: true,
      }),
    );
    expect(result.status).toBe("atascado");
    expect(result.reason).toBe("heartbeat_stale");
  });

  it("a stale heartbeat while still inside the window stays fresco", () => {
    const result = deriveSourceStatus(
      captureInput({
        lastActivityAt: new Date(NOW - 2 * 60 * 60 * 1000).toISOString(),
        heartbeatStale: true,
      }),
    );
    expect(result.status).toBe("fresco");
  });
});

describe("worstOfStatuses", () => {
  it("returns null for an empty list — nothing in scope, never silently fresco", () => {
    expect(worstOfStatuses([])).toBeNull();
  });

  it("picks the worst status present", () => {
    expect(worstOfStatuses(["fresco", "pendiente", "fresco"])).toBe("pendiente");
    expect(worstOfStatuses(["fresco", "atascado", "fallando"])).toBe("fallando");
  });
});

describe("compareSourceRows", () => {
  it("ranks problems ahead of fresco regardless of age", () => {
    const rows = [
      { source: "a", status: "fresco" as const, ageHours: 1000 },
      { source: "b", status: "fallando" as const, ageHours: 1 },
    ];
    const sorted = [...rows].sort(compareSourceRows);
    expect(sorted.map((r) => r.source)).toEqual(["b", "a"]);
  });

  it("within the same status, older activity sorts first", () => {
    const rows = [
      { source: "a", status: "pendiente" as const, ageHours: 10 },
      { source: "b", status: "pendiente" as const, ageHours: 50 },
    ];
    const sorted = [...rows].sort(compareSourceRows);
    expect(sorted.map((r) => r.source)).toEqual(["b", "a"]);
  });

  it("falls back to source name for a stable order", () => {
    const rows = [
      { source: "zeta", status: "fresco" as const, ageHours: 1 },
      { source: "alfa", status: "fresco" as const, ageHours: 1 },
    ];
    const sorted = [...rows].sort(compareSourceRows);
    expect(sorted.map((r) => r.source)).toEqual(["alfa", "zeta"]);
  });
});
