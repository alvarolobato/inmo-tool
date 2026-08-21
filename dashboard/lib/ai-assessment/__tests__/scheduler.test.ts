/**
 * #308 — assessment scheduler, unit tests.
 *
 * The scheduler is thin by design (config-read + a guarded setInterval), so
 * these prove exactly that thin surface: config precedence (env > default),
 * the kill switch, start idempotency, and that a tick actually fires
 * `runAssessmentBatch`. The batch itself is mocked — its own logic is covered
 * by batch.test.ts.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const getSystemConfig = vi.fn<() => Record<string, { value: unknown }>>(() => ({}));
vi.mock("@/lib/system-config/loader", () => ({
  getSystemConfig: () => getSystemConfig(),
}));

const runAssessmentBatch = vi.fn(async (_opts?: { batchSize?: number }) => ({
  properties: 0,
  assessed: 0,
  skipped: 0,
  noListings: 0,
  errors: 0,
  stopped: null,
}));
vi.mock("../batch", () => ({
  runAssessmentBatch: (opts: { batchSize?: number }) => runAssessmentBatch(opts),
}));

import {
  loadSchedulerConfig,
  startAssessmentScheduler,
  stopAssessmentScheduler,
} from "../scheduler";

beforeEach(() => {
  getSystemConfig.mockReturnValue({});
  runAssessmentBatch.mockClear();
  vi.unstubAllEnvs();
});

afterEach(() => {
  stopAssessmentScheduler();
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe("loadSchedulerConfig", () => {
  it("returns defaults when nothing is configured", () => {
    expect(loadSchedulerConfig()).toEqual({
      enabled: true,
      batchSize: 8,
      intervalSeconds: 900,
      concurrency: 8,
      drainIntervalSeconds: 5,
    });
  });

  it("reads values from config.yaml (via the loader)", () => {
    getSystemConfig.mockReturnValue({
      "dashboard.assessment_auto_enabled": { value: false },
      "dashboard.assessment_batch_size": { value: 12 },
      "dashboard.assessment_interval_seconds": { value: 60 },
      "dashboard.assessment_concurrency": { value: 6 },
      "dashboard.assessment_drain_interval_seconds": { value: 2 },
    });
    expect(loadSchedulerConfig()).toEqual({
      enabled: false,
      batchSize: 12,
      intervalSeconds: 60,
      concurrency: 6,
      drainIntervalSeconds: 2,
    });
  });

  it("falls back to env vars when the loader has no value", () => {
    getSystemConfig.mockImplementation(() => {
      throw new Error("schema unavailable");
    });
    vi.stubEnv("DASHBOARD_ASSESSMENT_AUTO_ENABLED", "false");
    vi.stubEnv("DASHBOARD_ASSESSMENT_BATCH_SIZE", "3");
    vi.stubEnv("DASHBOARD_ASSESSMENT_INTERVAL_SECONDS", "30");
    vi.stubEnv("DASHBOARD_ASSESSMENT_CONCURRENCY", "2");
    vi.stubEnv("DASHBOARD_ASSESSMENT_DRAIN_INTERVAL_SECONDS", "1");
    expect(loadSchedulerConfig()).toEqual({
      enabled: false,
      batchSize: 3,
      intervalSeconds: 30,
      concurrency: 2,
      drainIntervalSeconds: 1,
    });
  });

  it("ignores a non-positive or non-numeric override and keeps the default", () => {
    getSystemConfig.mockReturnValue({
      "dashboard.assessment_batch_size": { value: 0 },
      "dashboard.assessment_interval_seconds": { value: "abc" },
      "dashboard.assessment_concurrency": { value: -1 },
    });
    const cfg = loadSchedulerConfig();
    expect(cfg.batchSize).toBe(8);
    expect(cfg.intervalSeconds).toBe(900);
    expect(cfg.concurrency).toBe(8);
  });

  it("clamps assessment_concurrency to the hard cap regardless of config", () => {
    getSystemConfig.mockReturnValue({
      "dashboard.assessment_concurrency": { value: 999 },
    });
    expect(loadSchedulerConfig().concurrency).toBe(8);
  });
});

describe("startAssessmentScheduler", () => {
  it("does not start a loop when disabled", () => {
    vi.useFakeTimers();
    getSystemConfig.mockReturnValue({
      "dashboard.assessment_auto_enabled": { value: false },
    });
    startAssessmentScheduler();
    vi.advanceTimersByTime(60 * 60 * 1000);
    expect(runAssessmentBatch).not.toHaveBeenCalled();
  });

  it("fires runAssessmentBatch on each interval when enabled", async () => {
    vi.useFakeTimers();
    getSystemConfig.mockReturnValue({
      "dashboard.assessment_batch_size": { value: 4 },
      "dashboard.assessment_interval_seconds": { value: 10 },
    });
    startAssessmentScheduler();

    // The mock's default return (properties: 0) is BELOW batchSize (4), i.e.
    // "the queue drained" — so the adaptive scheduler backs off to the full
    // idle interval here too, exactly like the old fixed setInterval did.
    // (The #666 "drains fast on a full page" behaviour has its own describe
    // block below.)
    await vi.advanceTimersByTimeAsync(10 * 1000);
    expect(runAssessmentBatch).toHaveBeenCalledTimes(1);
    // concurrency isn't configured in this test — falls back to its own
    // default (8), independent of the explicitly-configured batchSize.
    expect(runAssessmentBatch).toHaveBeenCalledWith({ batchSize: 4, concurrency: 8 });

    await vi.advanceTimersByTimeAsync(10 * 1000);
    expect(runAssessmentBatch).toHaveBeenCalledTimes(2);
  });

  it("is idempotent — a second start does not add a second loop", async () => {
    vi.useFakeTimers();
    getSystemConfig.mockReturnValue({
      "dashboard.assessment_interval_seconds": { value: 10 },
    });
    startAssessmentScheduler();
    startAssessmentScheduler(); // no-op

    await vi.advanceTimersByTimeAsync(10 * 1000);
    expect(runAssessmentBatch).toHaveBeenCalledTimes(1);
  });
});

describe("#666: adaptive duty cycle", () => {
  it("reschedules after drainIntervalSeconds (not the full interval) when a tick touches a full page", async () => {
    vi.useFakeTimers();
    getSystemConfig.mockReturnValue({
      "dashboard.assessment_batch_size": { value: 4 },
      "dashboard.assessment_interval_seconds": { value: 900 },
      "dashboard.assessment_drain_interval_seconds": { value: 5 },
    });
    // A full page (properties === batchSize) — the scheduler should treat
    // this as "there's probably more backlog" and drain fast.
    runAssessmentBatch.mockResolvedValue({
      properties: 4,
      assessed: 4,
      skipped: 0,
      noListings: 0,
      parked: 0,
      errors: 0,
      stopped: null,
    });
    startAssessmentScheduler();

    // First tick still waits the full (900s) idle interval.
    await vi.advanceTimersByTimeAsync(900 * 1000);
    expect(runAssessmentBatch).toHaveBeenCalledTimes(1);

    // The NEXT tick fires after the short drain interval, not another 900s.
    await vi.advanceTimersByTimeAsync(5 * 1000);
    expect(runAssessmentBatch).toHaveBeenCalledTimes(2);
  });

  it("backs off to the full interval (not the drain interval) when a tick stops on budget/circuit/quota", async () => {
    vi.useFakeTimers();
    getSystemConfig.mockReturnValue({
      "dashboard.assessment_batch_size": { value: 4 },
      "dashboard.assessment_interval_seconds": { value: 900 },
      "dashboard.assessment_drain_interval_seconds": { value: 5 },
    });
    // A full page AND a stop — the stop must win: hammering an open circuit
    // or an exhausted quota window every 5s helps nobody.
    runAssessmentBatch.mockResolvedValue({
      properties: 4,
      assessed: 0,
      skipped: 0,
      noListings: 0,
      parked: 0,
      errors: 0,
      stopped: "quota",
    });
    startAssessmentScheduler();

    await vi.advanceTimersByTimeAsync(900 * 1000);
    expect(runAssessmentBatch).toHaveBeenCalledTimes(1);

    // 5s (the drain interval) is NOT enough to trigger a second tick.
    await vi.advanceTimersByTimeAsync(5 * 1000);
    expect(runAssessmentBatch).toHaveBeenCalledTimes(1);

    // The full interval is.
    await vi.advanceTimersByTimeAsync(895 * 1000);
    expect(runAssessmentBatch).toHaveBeenCalledTimes(2);
  });

  it("never overlaps two ticks even when the drain interval elapses while a tick is still in flight", async () => {
    vi.useFakeTimers();
    getSystemConfig.mockReturnValue({
      "dashboard.assessment_batch_size": { value: 4 },
      "dashboard.assessment_interval_seconds": { value: 900 },
      "dashboard.assessment_drain_interval_seconds": { value: 5 },
    });
    // A tick that "hangs" until the test resolves it — models a real
    // multi-property, multi-flow pass that outlasts the short drain window.
    let resolveTick!: (v: {
      properties: number;
      assessed: number;
      skipped: number;
      noListings: number;
      parked: number;
      errors: number;
      stopped: string | null;
    }) => void;
    const pending = new Promise((resolve) => {
      resolveTick = resolve;
    });
    runAssessmentBatch.mockReturnValueOnce(pending as never);

    startAssessmentScheduler();
    await vi.advanceTimersByTimeAsync(900 * 1000); // fires tick 1, which now hangs

    // Plenty of "wall clock" passes while tick 1 is still unresolved — if the
    // scheduler could overlap, this would fire several more ticks.
    await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
    expect(runAssessmentBatch).toHaveBeenCalledTimes(1);

    // Let tick 1 finish (full page → drains fast next).
    resolveTick!({
      properties: 4,
      assessed: 4,
      skipped: 0,
      noListings: 0,
      parked: 0,
      errors: 0,
      stopped: null,
    });
    await vi.advanceTimersByTimeAsync(5 * 1000);
    expect(runAssessmentBatch).toHaveBeenCalledTimes(2);
  });
});
