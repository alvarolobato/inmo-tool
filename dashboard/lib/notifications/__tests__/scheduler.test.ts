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
  recordDigestRun: (id: number, n: number, sent: boolean, kind?: string) => recordDigestRun(id, n, sent, kind),
}));

const buildDigestForProfile = vi.fn();
vi.mock("../digest", async (orig) => {
  const actual = (await orig()) as object;
  return { ...actual, buildDigestForProfile: (p: unknown, o?: unknown) => buildDigestForProfile(p, o) };
});

const sendDigestEmail = vi.fn(async () => ({ sent: true, recipient: "x@x" }));
vi.mock("../email", () => ({ sendDigestEmail: (c: unknown, o?: unknown) => sendDigestEmail(c, o) }));

// #428: the seguimiento query layer is mocked so runSeguimientoPass's
// orchestration (anchor selection, drops-only + status, per-kind watermark) is
// tested without a live Postgres. readPriceChangeBand returns a fixed band.
const loadSeguimientoPriceDrops = vi.fn(async () => [] as unknown[]);
const loadSeguimientoStatusChanges = vi.fn(async () => [] as unknown[]);
vi.mock("../seguimiento", () => ({
  loadSeguimientoPriceDrops: (...a: unknown[]) => loadSeguimientoPriceDrops(...(a as [])),
  loadSeguimientoStatusChanges: (...a: unknown[]) => loadSeguimientoStatusChanges(...(a as [])),
  readPriceChangeBand: () => ({ minFrac: 0.01, maxFrac: 0.6 }),
}));

import {
  loadDigestSchedulerConfig,
  loadSeguimientoConfig,
  isDigestDue,
  runDigestPass,
  runSeguimientoPass,
  startDigestScheduler,
  stopDigestScheduler,
} from "../scheduler";

function makeContent(sections: { newCandidates?: unknown[]; priceDrops?: unknown[]; statusChanges?: unknown[] }) {
  return {
    profileId: 1,
    profileName: "P",
    since: "s",
    generatedAt: "g",
    seguimientoDrops: [],
    newCandidates: sections.newCandidates ?? [],
    priceDrops: sections.priceDrops ?? [],
    statusChanges: sections.statusChanges ?? [],
    relistedLower: [],
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
    expect(recordDigestRun).toHaveBeenCalledWith(5, 0, false, "digest");
  });

  it("sends a non-empty digest and records the run with sent=true", async () => {
    listDigestProfiles.mockResolvedValue([{ id: 6, name: "P", cadence: "daily", email: "p@x", lastSentAt: null }]);
    buildDigestForProfile.mockResolvedValue(makeContent({ statusChanges: [{}] }));
    const r = await runDigestPass({ now });
    expect(r.sent).toBe(1);
    expect(sendDigestEmail).toHaveBeenCalledWith(expect.anything(), { to: "p@x" });
    expect(recordDigestRun).toHaveBeenCalledWith(6, 1, true, "digest");
  });

  it("counts a no-op send (unconfigured SMTP) separately and still records the run", async () => {
    listDigestProfiles.mockResolvedValue([{ id: 7, name: "P", cadence: "daily", email: null, lastSentAt: null }]);
    buildDigestForProfile.mockResolvedValue(makeContent({ statusChanges: [{}] }));
    sendDigestEmail.mockResolvedValue({ sent: false, reason: "smtp-not-configured" });
    const r = await runDigestPass({ now });
    expect(r.sent).toBe(0);
    expect(r.noop).toBe(1);
    expect(recordDigestRun).toHaveBeenCalledWith(7, 1, false, "digest");
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

  it("fires the digest pass AND the seguimiento pass on each interval tick", async () => {
    vi.useFakeTimers();
    listDigestProfiles.mockResolvedValue([]);
    startDigestScheduler(); // default interval 3600s
    expect(listDigestProfiles).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(3600 * 1000);
    // #428: the tick runs both passes, each of which lists profiles once.
    expect(listDigestProfiles).toHaveBeenCalledTimes(2);
  });
});

describe("loadSeguimientoConfig", () => {
  it("returns defaults when nothing is configured", () => {
    expect(loadSeguimientoConfig()).toEqual({ enabled: true, lookbackHours: 24 });
  });

  it("reads env overrides (env > default)", () => {
    vi.stubEnv("NOTIFICATIONS_SEGUIMIENTO_AUTO_ENABLED", "false");
    vi.stubEnv("NOTIFICATIONS_SEGUIMIENTO_LOOKBACK_HOURS", "6");
    expect(loadSeguimientoConfig()).toEqual({ enabled: false, lookbackHours: 6 });
  });
});

describe("runSeguimientoPass (#428 watchlist pass)", () => {
  const now = new Date(2026, 7, 5, 9, 0, 0);

  beforeEach(() => {
    loadSeguimientoPriceDrops.mockReset();
    loadSeguimientoPriceDrops.mockResolvedValue([]);
    loadSeguimientoStatusChanges.mockReset();
    loadSeguimientoStatusChanges.mockResolvedValue([]);
  });

  it("runs regardless of digest_cadence — even an 'off' profile is watched", async () => {
    listDigestProfiles.mockResolvedValue([
      { id: 1, name: "off-but-tracked", cadence: "off", email: null, lastSentAt: null, lastSeguimientoAt: null },
    ]);
    await runSeguimientoPass({ now });
    // The tracked-drop query WAS consulted for the 'off' profile.
    expect(loadSeguimientoPriceDrops).toHaveBeenCalledTimes(1);
  });

  it("nothing tracked moved → advances the seguimiento watermark, sends nothing", async () => {
    listDigestProfiles.mockResolvedValue([
      { id: 2, name: "P", cadence: "daily", email: null, lastSentAt: null, lastSeguimientoAt: null },
    ]);
    const r = await runSeguimientoPass({ now });
    expect(r.empty).toBe(1);
    expect(r.sent).toBe(0);
    expect(sendDigestEmail).not.toHaveBeenCalled();
    expect(recordDigestRun).toHaveBeenCalledWith(2, 0, false, "seguimiento");
  });

  it("a tracked drop → sends the alert and records the run under kind='seguimiento'", async () => {
    listDigestProfiles.mockResolvedValue([
      { id: 3, name: "P", cadence: "weekly", email: "p@x", lastSentAt: null, lastSeguimientoAt: null },
    ]);
    loadSeguimientoPriceDrops.mockResolvedValue([{ propertyId: 9 }]);
    const r = await runSeguimientoPass({ now });
    expect(r.withChanges).toBe(1);
    expect(r.sent).toBe(1);
    expect(sendDigestEmail).toHaveBeenCalledWith(
      expect.objectContaining({ seguimientoDrops: [{ propertyId: 9 }], priceDrops: [], newCandidates: [] }),
      { to: "p@x" },
    );
    expect(recordDigestRun).toHaveBeenCalledWith(3, 1, true, "seguimiento");
  });

  it("no double-alert: anchors on the profile's last seguimiento run, not the digest run", async () => {
    const lastSeg = "2026-08-05T08:30:00.000Z";
    listDigestProfiles.mockResolvedValue([
      { id: 4, name: "P", cadence: "daily", email: null, lastSentAt: "2026-08-01T00:00:00.000Z", lastSeguimientoAt: lastSeg },
    ]);
    await runSeguimientoPass({ now });
    // The tracked-drop query is anchored on lastSeguimientoAt — so a drop
    // already covered by the previous seguimiento run can't re-alert.
    expect(loadSeguimientoPriceDrops).toHaveBeenCalledWith(4, lastSeg, { minFrac: 0.01, maxFrac: 0.6 }, 25);
  });

  it("never-run profile falls back to now - lookbackHours", async () => {
    vi.stubEnv("NOTIFICATIONS_SEGUIMIENTO_LOOKBACK_HOURS", "2");
    listDigestProfiles.mockResolvedValue([
      { id: 5, name: "P", cadence: "daily", email: null, lastSentAt: null, lastSeguimientoAt: null },
    ]);
    await runSeguimientoPass({ now });
    const expectedAnchor = new Date(now.getTime() - 2 * 60 * 60 * 1000).toISOString();
    expect(loadSeguimientoPriceDrops).toHaveBeenCalledWith(5, expectedAnchor, { minFrac: 0.01, maxFrac: 0.6 }, 25);
  });

  it("isolates a per-profile failure and continues the pass", async () => {
    listDigestProfiles.mockResolvedValue([
      { id: 6, name: "boom", cadence: "daily", email: null, lastSentAt: null, lastSeguimientoAt: null },
      { id: 7, name: "ok", cadence: "daily", email: null, lastSentAt: null, lastSeguimientoAt: null },
    ]);
    loadSeguimientoPriceDrops.mockImplementation(async (id: number) => {
      if (id === 6) throw new Error("boom");
      return [{ propertyId: 1 }];
    });
    const r = await runSeguimientoPass({ now });
    expect(r.errors).toBe(1);
    expect(r.withChanges).toBe(1);
    expect(r.sent).toBe(1);
  });
});
