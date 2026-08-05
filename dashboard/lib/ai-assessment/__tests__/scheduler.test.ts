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
      batchSize: 5,
      intervalSeconds: 900,
    });
  });

  it("reads values from config.yaml (via the loader)", () => {
    getSystemConfig.mockReturnValue({
      "dashboard.assessment_auto_enabled": { value: false },
      "dashboard.assessment_batch_size": { value: 12 },
      "dashboard.assessment_interval_seconds": { value: 60 },
    });
    expect(loadSchedulerConfig()).toEqual({
      enabled: false,
      batchSize: 12,
      intervalSeconds: 60,
    });
  });

  it("falls back to env vars when the loader has no value", () => {
    getSystemConfig.mockImplementation(() => {
      throw new Error("schema unavailable");
    });
    vi.stubEnv("DASHBOARD_ASSESSMENT_AUTO_ENABLED", "false");
    vi.stubEnv("DASHBOARD_ASSESSMENT_BATCH_SIZE", "3");
    vi.stubEnv("DASHBOARD_ASSESSMENT_INTERVAL_SECONDS", "30");
    expect(loadSchedulerConfig()).toEqual({
      enabled: false,
      batchSize: 3,
      intervalSeconds: 30,
    });
  });

  it("ignores a non-positive or non-numeric override and keeps the default", () => {
    getSystemConfig.mockReturnValue({
      "dashboard.assessment_batch_size": { value: 0 },
      "dashboard.assessment_interval_seconds": { value: "abc" },
    });
    const cfg = loadSchedulerConfig();
    expect(cfg.batchSize).toBe(5);
    expect(cfg.intervalSeconds).toBe(900);
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

    await vi.advanceTimersByTimeAsync(10 * 1000);
    expect(runAssessmentBatch).toHaveBeenCalledTimes(1);
    expect(runAssessmentBatch).toHaveBeenCalledWith({ batchSize: 4 });

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
