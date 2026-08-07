import { describe, it, expect } from "vitest";
import {
  normalizeTasks,
  fallbackTaskId,
  portalTitle,
  taskStaleness,
  lastDoneLabel,
  relativeAgo,
  resolveStalenessDays,
  groupTasksByPortal,
  deriveConnectorState,
  buildConnectorViews,
  buildProfileCaptureView,
  captureSummary,
  formatCaptureSummary,
  DEFAULT_STALENESS_DAYS,
  type CaptureTask,
  type PortalCaptureActivity,
} from "@/lib/captura-tasks";
import type { WorklistPortalSummary } from "@/lib/worklist";

const DAY = 24 * 60 * 60 * 1000;

describe("portalTitle", () => {
  it("title-cases a portal key", () => {
    expect(portalTitle("idealista")).toBe("Idealista");
    expect(portalTitle("aliseda")).toBe("Aliseda");
  });
  it("handles the empty string", () => {
    expect(portalTitle("")).toBe("");
  });
});

describe("fallbackTaskId", () => {
  it("is deterministic for the same portal+url", () => {
    const a = fallbackTaskId("idealista", "https://x/venta?y=1");
    const b = fallbackTaskId("idealista", "https://x/venta?y=1");
    expect(a).toBe(b);
  });
  it("differs when the url differs", () => {
    expect(fallbackTaskId("idealista", "https://x/venta")).not.toBe(
      fallbackTaskId("idealista", "https://x/venta-locales"),
    );
  });
  it("is prefixed with the portal and url/attribute-safe", () => {
    const id = fallbackTaskId("aliseda", "https://a/b");
    expect(id.startsWith("aliseda-")).toBe(true);
    expect(id).toMatch(/^[a-z0-9-]+$/);
  });
});

describe("normalizeTasks", () => {
  it("returns [] for null/undefined/non-object", () => {
    expect(normalizeTasks(null)).toEqual([]);
    expect(normalizeTasks(undefined)).toEqual([]);
  });

  it("consumes the real tasks[] verbatim, defaulting label/loosened", () => {
    const body = {
      tasks: [
        { id: "t1", portal: "idealista", label: "Idealista · Viviendas", url: "https://i/v", loosened: [] },
        { id: "t2", portal: "idealista", url: "https://i/g" }, // no label/loosened
      ],
    };
    const out = normalizeTasks(body);
    expect(out).toHaveLength(2);
    expect(out[0]).toEqual({
      id: "t1",
      portal: "idealista",
      label: "Idealista · Viviendas",
      url: "https://i/v",
      loosened: [],
    });
    // Missing label falls back to Title-case portal; loosened defaults to [].
    expect(out[1].label).toBe("Idealista");
    expect(out[1].loosened).toEqual([]);
  });

  it("drops malformed task entries", () => {
    const body = { tasks: [{ portal: "idealista", url: "https://i/v" }, 42, null] };
    // First entry lacks a string id → dropped; 42/null → dropped.
    expect(normalizeTasks(body)).toEqual([]);
  });

  it("adapts the legacy urls[] shape into tasks with a stable id + label", () => {
    const body = {
      urls: [
        { portal: "idealista", url: "https://i/v", loosened: [] },
        { portal: "aliseda", url: "https://a/venta", loosened: [{ constraint: "geography", reason: "r" }] },
      ],
    };
    const out = normalizeTasks(body);
    expect(out).toHaveLength(2);
    expect(out[0].id).toBe(fallbackTaskId("idealista", "https://i/v"));
    expect(out[0].label).toBe("Idealista");
    expect(out[1].loosened).toEqual([{ constraint: "geography", reason: "r" }]);
  });

  it("prefers tasks[] over urls[] when both present", () => {
    const out = normalizeTasks({
      tasks: [{ id: "t1", portal: "idealista", url: "https://i/v" }],
      urls: [{ portal: "aliseda", url: "https://a/v", loosened: [] }],
    });
    expect(out).toHaveLength(1);
    expect(out[0].id).toBe("t1");
  });
});

describe("taskStaleness", () => {
  const now = new Date("2026-08-05T12:00:00Z");

  it("never run → due, not muted, not done", () => {
    expect(taskStaleness(null, 7, now)).toEqual({ done: false, muted: false, due: true, ageDays: null });
    expect(taskStaleness(undefined, 7, now).due).toBe(true);
  });

  it("unparseable timestamp → treated as never run", () => {
    expect(taskStaleness("not-a-date", 7, now).due).toBe(true);
    expect(taskStaleness("not-a-date", 7, now).done).toBe(false);
  });

  it("run inside the window → muted, not due", () => {
    const last = new Date(now.getTime() - 3 * DAY).toISOString();
    const st = taskStaleness(last, 7, now);
    expect(st).toEqual({ done: true, muted: true, due: false, ageDays: 3 });
  });

  it("run exactly at the window boundary → due (>= window)", () => {
    const last = new Date(now.getTime() - 7 * DAY).toISOString();
    const st = taskStaleness(last, 7, now);
    expect(st.muted).toBe(false);
    expect(st.due).toBe(true);
    expect(st.done).toBe(true);
  });

  it("run past the window → due again", () => {
    const last = new Date(now.getTime() - 10 * DAY).toISOString();
    expect(taskStaleness(last, 7, now).due).toBe(true);
  });

  it("accepts a Date instance", () => {
    const last = new Date(now.getTime() - 1 * DAY);
    expect(taskStaleness(last, 7, now).muted).toBe(true);
  });

  it("non-positive window → always due (never mute)", () => {
    const last = new Date(now.getTime() - 1 * DAY).toISOString();
    expect(taskStaleness(last, 0, now).due).toBe(true);
    expect(taskStaleness(last, -5, now).muted).toBe(false);
  });

  it("clamps a future timestamp to age 0 (muted)", () => {
    const future = new Date(now.getTime() + 5 * DAY).toISOString();
    const st = taskStaleness(future, 7, now);
    expect(st.ageDays).toBe(0);
    expect(st.muted).toBe(true);
  });
});

describe("lastDoneLabel", () => {
  const now = new Date("2026-08-05T12:00:00Z");
  it("'nunca' when never run", () => {
    expect(lastDoneLabel(null, now)).toBe("nunca");
    expect(lastDoneLabel("bad", now)).toBe("nunca");
  });
  it("seconds / minutes / hours / days", () => {
    expect(lastDoneLabel(new Date(now.getTime() - 5000).toISOString(), now)).toBe("hecho hace unos segundos");
    expect(lastDoneLabel(new Date(now.getTime() - 5 * 60000).toISOString(), now)).toBe("hecho hace 5 min");
    expect(lastDoneLabel(new Date(now.getTime() - 3 * 3600000).toISOString(), now)).toBe("hecho hace 3 h");
    expect(lastDoneLabel(new Date(now.getTime() - 1 * DAY).toISOString(), now)).toBe("hecho hace 1 día");
    expect(lastDoneLabel(new Date(now.getTime() - 4 * DAY).toISOString(), now)).toBe("hecho hace 4 días");
  });
});

describe("relativeAgo", () => {
  const now = new Date("2026-08-05T12:00:00Z");
  it("'nunca' when null / unparseable", () => {
    expect(relativeAgo(null, now)).toBe("nunca");
    expect(relativeAgo("bad", now)).toBe("nunca");
  });
  it("seconds / minutes / hours / days (no verb)", () => {
    expect(relativeAgo(new Date(now.getTime() - 5000).toISOString(), now)).toBe("hace unos segundos");
    expect(relativeAgo(new Date(now.getTime() - 5 * 60000).toISOString(), now)).toBe("hace 5 min");
    expect(relativeAgo(new Date(now.getTime() - 3 * 3600000).toISOString(), now)).toBe("hace 3 h");
    expect(relativeAgo(new Date(now.getTime() - 1 * DAY).toISOString(), now)).toBe("hace 1 día");
    expect(relativeAgo(new Date(now.getTime() - 4 * DAY).toISOString(), now)).toBe("hace 4 días");
  });
});

describe("resolveStalenessDays", () => {
  it("uses the per-portal override when positive", () => {
    expect(resolveStalenessDays("idealista", { defaultDays: 7, byPortal: { idealista: 3 } })).toBe(3);
  });
  it("falls back to the global default when no override", () => {
    expect(resolveStalenessDays("aliseda", { defaultDays: 7, byPortal: { idealista: 3 } })).toBe(7);
  });
  it("ignores a non-positive override", () => {
    expect(resolveStalenessDays("idealista", { defaultDays: 7, byPortal: { idealista: 0 } })).toBe(7);
  });
  it("falls back to the hardcoded default when the global is non-positive", () => {
    expect(resolveStalenessDays("x", { defaultDays: 0, byPortal: {} })).toBe(DEFAULT_STALENESS_DAYS);
  });
});

describe("groupTasksByPortal", () => {
  const t = (id: string, portal: string): CaptureTask => ({ id, portal, label: portalTitle(portal), url: `https://${portal}/${id}`, loosened: [] });

  it("groups tasks preserving first-seen portal order and task order", () => {
    const groups = groupTasksByPortal([t("a", "idealista"), t("b", "aliseda"), t("c", "idealista")]);
    expect(groups.map((g) => g.portal)).toEqual(["idealista", "aliseda"]);
    expect(groups[0].tasks.map((x) => x.id)).toEqual(["a", "c"]);
    expect(groups[0].label).toBe("Idealista");
    expect(groups[1].tasks).toHaveLength(1);
  });

  it("returns [] for no tasks", () => {
    expect(groupTasksByPortal([])).toEqual([]);
  });
});

describe("per-profile × connector captured counts (issue #430)", () => {
  const t = (id: string, portal: string): CaptureTask => ({
    id,
    portal,
    label: portalTitle(portal),
    url: `https://${portal}/${id}`,
    loosened: [],
  });
  const staleness = { defaultDays: 7, byPortal: {} };
  const emptyActivity = new Map<string, PortalCaptureActivity>();
  const emptySummary = new Map<string, WorklistPortalSummary>();

  it("uses the per-connector map for capturedProfile, independent of portal-global", () => {
    const activity = new Map<string, PortalCaptureActivity>([
      ["idealista", { portal: "idealista", captured: 10, lastCapturedAt: "2026-08-01T00:00:00.000Z" }],
    ]);
    const [connector] = buildConnectorViews(
      [t("a", "idealista")],
      {},
      staleness,
      activity,
      emptySummary,
      { idealista: 3 },
    );
    // Per-profile figure comes from the map; portal-global is carried alongside.
    expect(connector.capturedProfile).toBe(3);
    expect(connector.capturedReal).toBe(10);
  });

  it("defaults capturedProfile to 0 for a connector absent from the map", () => {
    const [connector] = buildConnectorViews(
      [t("a", "aliseda")],
      {},
      staleness,
      emptyActivity,
      emptySummary,
      { idealista: 5 }, // no aliseda entry
    );
    expect(connector.capturedProfile).toBe(0);
  });

  it("counts a property matching MULTIPLE profiles under EACH (captures not exclusive)", () => {
    // The same captured idealista property matches profiles 1 AND 2, so the
    // per-profile map (the shape getProfileConnectorCaptured returns) carries a
    // count of 1 for BOTH — the correct 'this profile has that captured' reading.
    const capturedByProfileConnector = new Map<number, Record<string, number>>([
      [1, { idealista: 1 }],
      [2, { idealista: 1 }],
    ]);
    const tasks = [t("a", "idealista")];
    const viewA = buildProfileCaptureView(
      { id: 1, name: "A" },
      tasks,
      {},
      staleness,
      emptyActivity,
      emptySummary,
      capturedByProfileConnector,
    );
    const viewB = buildProfileCaptureView(
      { id: 2, name: "B" },
      tasks,
      {},
      staleness,
      emptyActivity,
      emptySummary,
      capturedByProfileConnector,
    );
    expect(viewA.connectors[0].capturedProfile).toBe(1);
    expect(viewB.connectors[0].capturedProfile).toBe(1);
  });

  it("gives a profile absent from the captured map all-zero per-profile counts", () => {
    const view = buildProfileCaptureView(
      { id: 99, name: "Z" },
      [t("a", "idealista")],
      {},
      staleness,
      emptyActivity,
      emptySummary,
      new Map(), // profile 99 not present
    );
    expect(view.connectors[0].capturedProfile).toBe(0);
  });
});

describe("captureSummary / formatCaptureSummary (issue #433)", () => {
  it("captured + remaining reconcile to total (pending+captured basis)", () => {
    const s = captureSummary({ capturedProfile: 12, dueCount: 28 });
    expect(s).toEqual({ captured: 12, total: 40, remaining: 28 });
    expect(s.captured + s.remaining).toBe(s.total);
  });

  it("reads 0 / 0 · 0 for an empty connector", () => {
    expect(captureSummary({ capturedProfile: 0, dueCount: 0 })).toEqual({
      captured: 0,
      total: 0,
      remaining: 0,
    });
    expect(formatCaptureSummary({ capturedProfile: 0, dueCount: 0 })).toBe("0 / 0 · 0 restantes");
  });

  it("all captured, nothing pending → total equals captured, 0 remaining", () => {
    expect(formatCaptureSummary({ capturedProfile: 5, dueCount: 0 })).toBe("5 / 5 · 0 restantes");
  });

  it("nothing captured yet, all pending → 0 / N · N restantes", () => {
    expect(formatCaptureSummary({ capturedProfile: 0, dueCount: 3 })).toBe("0 / 3 · 3 restantes");
  });

  it("floors negative inputs at 0 defensively (never negative numbers)", () => {
    expect(captureSummary({ capturedProfile: -4, dueCount: -2 })).toEqual({
      captured: 0,
      total: 0,
      remaining: 0,
    });
  });

  it("formats the compact '12 / 40 · 28 restantes' line", () => {
    expect(formatCaptureSummary({ capturedProfile: 12, dueCount: 28 })).toBe("12 / 40 · 28 restantes");
  });
});

describe("deriveConnectorState", () => {
  it("not-due when nothing is due", () => {
    expect(deriveConnectorState(0, 3)).toBe("not-due");
  });
  it("half-done when some due and some muted", () => {
    expect(deriveConnectorState(2, 1)).toBe("half-done");
  });
  it("due when everything is pending", () => {
    expect(deriveConnectorState(2, 0)).toBe("due");
  });
});
