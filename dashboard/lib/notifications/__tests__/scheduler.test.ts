/**
 * Digest scheduler — unit tests (issue #35, Phase 5.5 v1).
 *
 * Covers config precedence, the pure `isDigestDue` cadence rule (all
 * branches), the `runDigestPass` orchestration (due filtering, the
 * empty-digest-skip that is issue #35 EC-2, the send path, and per-profile
 * error isolation), and the start/stop loop guards. The builder, DB layer, and
 * email sender are mocked — their own logic lives in digest.test.ts /
 * email.test.ts.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const getSystemConfig = vi.fn<() => Record<string, { value: unknown }>>(() => ({}));
vi.mock("@/lib/system-config/loader", () => ({ getSystemConfig: () => getSystemConfig() }));

const listDigestProfiles = vi.fn(async () => [] as unknown[]);
const recordDigestRun = vi.fn(async () => "2026-08-05T07:00:00.000Z");
vi.mock("@/lib/db/digest", () => ({
  listDigestProfiles: () => listDigestProfiles(),
  recordDigestRun: (id: number, n: number, sent: boolean) => recordDigestRun(id, n, sent),
}));

const buildDigestForProfile = vi.fn();
vi.mock("../digest", async (orig) => {
  const actual = (await orig()) as object;
  return { ...actual, buildDigestForProfile: (p: unknown, o?: unknown) => buildDigestForProfile(p, o) };
});

const sendDigestEmail = vi.fn(async () => ({ sent: true, recipient: "x@x" }));
vi.mock("../email", () => ({ sendDigestEmail: (c: unknown, o?: unknown) => sendDigestEmail(c, o) }));

import {
  loadDigestSchedulerConfig,
  isDigestDue,
  runDigestPass,
  startDigestScheduler,
  stopDigestScheduler,
} from "../scheduler";

function makeContent(sections: { newCandidates?: unknown[]; priceDrops?: unknown[]; statusChanges?: unknown[] }) {
  return {
    profileId: 1,
    profileName: "P",
    since: "s",
    generatedAt: "g",
    newCandidates: sections.newCandidates ?? [],
    priceDrops: sections.priceDrops ?? [],
    statusChanges: sections.statusChanges ?? [],
  };
}

beforeEach(() => {
  getSystemConfig.mockReturnValue({});
  vi.unstubAllEnvs();
  listDigestProfiles.mockReset();
  recordDigestRun.mockClear();
  buildDigestForProfile.mockReset();
  sendDigestEmail.mockClear();
  sendDigestEmail.mockResolvedValue({ sent: true, recipient: "x@x" });
});

afterEach(() => {
  stopDigestScheduler();
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe("loadDigestSchedulerConfig", () => {
  it("returns defaults when nothing is configured", () => {
    expect(loadDigestSchedulerConfig()).toEqual({ enabled: true, intervalSeconds: 3600, sendHour: 7 });
  });

  it("reads env overrides (env > default)", () => {
    vi.stubEnv("NOTIFICATIONS_DIGEST_AUTO_ENABLED", "false");
    vi.stubEnv("NOTIFICATIONS_DIGEST_INTERVAL_SECONDS", "60");
    vi.stubEnv("NOTIFICATIONS_DIGEST_SEND_HOUR", "9");
    expect(loadDigestSchedulerConfig()).toEqual({ enabled: false, intervalSeconds: 60, sendHour: 9 });
  });

  it("clamps an out-of-range send hour back to the default", () => {
    vi.stubEnv("NOTIFICATIONS_DIGEST_SEND_HOUR", "99");
    expect(loadDigestSchedulerConfig().sendHour).toBe(7);
  });
});

describe("isDigestDue", () => {
  const at = (h: number) => new Date(2026, 7, 5, h, 0, 0); // local time, 2026-08-05

  it("off is never due", () => {
    expect(isDigestDue("off", null, at(10), 7)).toBe(false);
  });

  it("nothing sends before the send hour", () => {
    expect(isDigestDue("daily", null, at(6), 7)).toBe(false);
    expect(isDigestDue("daily", null, at(7), 7)).toBe(true);
  });

  it("a never-sent profile is due once past the send hour", () => {
    expect(isDigestDue("daily", null, at(8), 7)).toBe(true);
  });

  it("daily: not due again the same calendar day, due the next day", () => {
    const earlierToday = new Date(2026, 7, 5, 7, 30, 0).toISOString();
    expect(isDigestDue("daily", earlierToday, at(9), 7)).toBe(false);
    const yesterday = new Date(2026, 7, 4, 7, 30, 0).toISOString();
    expect(isDigestDue("daily", yesterday, at(9), 7)).toBe(true);
  });

  it("weekly: due only after >=7 days", () => {
    const threeDaysAgo = new Date(2026, 7, 2, 8, 0, 0).toISOString();
    expect(isDigestDue("weekly", threeDaysAgo, at(9), 7)).toBe(false);
    const eightDaysAgo = new Date(2026, 6, 28, 8, 0, 0).toISOString();
    expect(isDigestDue("weekly", eightDaysAgo, at(9), 7)).toBe(true);
  });

  it("an unparseable watermark is treated as never sent", () => {
    expect(isDigestDue("daily", "not-a-date", at(9), 7)).toBe(true);
  });
});

describe("runDigestPass", () => {
  const now = new Date(2026, 7, 5, 9, 0, 0); // 09:00 local, past the default send hour

  it("skips profiles that are not due", async () => {
    listDigestProfiles.mockResolvedValue([
      { id: 1, name: "off", cadence: "off", email: null, lastSentAt: null },
      { id: 2, name: "sent-today", cadence: "daily", email: null, lastSentAt: new Date(2026, 7, 5, 7, 0, 0).toISOString() },
    ]);
    const r = await runDigestPass({ now });
    expect(r.due).toBe(0);
    expect(buildDigestForProfile).not.toHaveBeenCalled();
    expect(recordDigestRun).not.toHaveBeenCalled();
  });

  it("empty digest is skipped, not sent", async () => {
    // EC-2: a profile with zero qualifying activity records a run (watermark
    // advances) but no email goes out.
    listDigestProfiles.mockResolvedValue([{ id: 5, name: "P", cadence: "daily", email: null, lastSentAt: null }]);
    buildDigestForProfile.mockResolvedValue(makeContent({}));
    const r = await runDigestPass({ now });
    expect(r.due).toBe(1);
    expect(r.empty).toBe(1);
    expect(r.sent).toBe(0);
    expect(sendDigestEmail).not.toHaveBeenCalled();
    expect(recordDigestRun).toHaveBeenCalledWith(5, 0, false);
  });

  it("sends a non-empty digest and records the run with sent=true", async () => {
    listDigestProfiles.mockResolvedValue([{ id: 6, name: "P", cadence: "daily", email: "p@x", lastSentAt: null }]);
    buildDigestForProfile.mockResolvedValue(makeContent({ statusChanges: [{}] }));
    const r = await runDigestPass({ now });
    expect(r.sent).toBe(1);
    expect(sendDigestEmail).toHaveBeenCalledWith(expect.anything(), { to: "p@x" });
    expect(recordDigestRun).toHaveBeenCalledWith(6, 1, true);
  });

  it("counts a no-op send (unconfigured SMTP) separately and still records the run", async () => {
    listDigestProfiles.mockResolvedValue([{ id: 7, name: "P", cadence: "daily", email: null, lastSentAt: null }]);
    buildDigestForProfile.mockResolvedValue(makeContent({ statusChanges: [{}] }));
    sendDigestEmail.mockResolvedValue({ sent: false, reason: "smtp-not-configured" });
    const r = await runDigestPass({ now });
    expect(r.sent).toBe(0);
    expect(r.noop).toBe(1);
    expect(recordDigestRun).toHaveBeenCalledWith(7, 1, false);
  });

  it("isolates a per-profile failure and continues the pass", async () => {
    listDigestProfiles.mockResolvedValue([
      { id: 8, name: "boom", cadence: "daily", email: null, lastSentAt: null },
      { id: 9, name: "ok", cadence: "daily", email: null, lastSentAt: null },
    ]);
    buildDigestForProfile.mockImplementation(async (p: { id: number }) => {
      if (p.id === 8) throw new Error("boom");
      return makeContent({ statusChanges: [{}] });
    });
    const r = await runDigestPass({ now });
    expect(r.errors).toBe(1);
    expect(r.sent).toBe(1);
  });
});

describe("start/stop", () => {
  it("does not start when disabled", () => {
    vi.stubEnv("NOTIFICATIONS_DIGEST_AUTO_ENABLED", "false");
    const spy = vi.spyOn(global, "setInterval");
    startDigestScheduler();
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it("is idempotent — a second start is a no-op", () => {
    vi.useFakeTimers();
    const spy = vi.spyOn(global, "setInterval");
    startDigestScheduler();
    startDigestScheduler();
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });

  it("fires a digest pass on each interval tick", async () => {
    vi.useFakeTimers();
    listDigestProfiles.mockResolvedValue([]);
    startDigestScheduler(); // default interval 3600s
    expect(listDigestProfiles).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(3600 * 1000);
    expect(listDigestProfiles).toHaveBeenCalledTimes(1);
  });
});
