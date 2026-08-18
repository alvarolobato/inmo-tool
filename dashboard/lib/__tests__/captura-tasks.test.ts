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
  defaultTickedTaskIds,
  allProfileTasks,
  buildCaptureBatchPlan,
  capCaptureBatchPlan,
  selectionKey,
  allTasksAcrossProfiles,
  defaultTickedSelectionKeys,
  buildGlobalCaptureBatchPlan,
  capGlobalCaptureBatchPlan,
  DEFAULT_STALENESS_DAYS,
  type CaptureTask,
  type ConnectorView,
  type ProfileCaptureView,
  type ProfileTask,
} from "@/lib/captura-tasks";

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
      // #529: no captureUrl in the source → defaults to url.
      captureUrl: "https://i/v",
      loosened: [],
    });
    // Missing label falls back to Title-case portal; loosened defaults to [].
    expect(out[1].label).toBe("Idealista");
    expect(out[1].loosened).toEqual([]);
  });

  it("#529: passes through a server-derived captureUrl distinct from url", () => {
    const out = normalizeTasks({
      tasks: [
        {
          id: "t1",
          portal: "idealista",
          url: "https://www.idealista.com/areas/venta-viviendas/mapa-google?shape=x",
          captureUrl: "https://www.idealista.com/areas/venta-viviendas/?shape=x",
        },
      ],
    });
    expect(out[0].url).toContain("/mapa-google");
    expect(out[0].captureUrl).not.toContain("/mapa-google");
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

  it("uses the per-connector map for capturedProfile (the only capturados figure, #445)", () => {
    const [connector] = buildConnectorViews([t("a", "idealista")], {}, staleness, { idealista: 3 });
    // Per-profile figure comes from the map; no portal-global figure is carried.
    expect(connector.capturedProfile).toBe(3);
  });

  it("defaults capturedProfile to 0 for a connector absent from the map", () => {
    const [connector] = buildConnectorViews(
      [t("a", "aliseda")],
      {},
      staleness,
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
      capturedByProfileConnector,
    );
    const viewB = buildProfileCaptureView(
      { id: 2, name: "B" },
      tasks,
      {},
      staleness,
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

// ─── "Capturar todo" selection→queue mapping (issue #556) ─────────────────

function mkTask(id: string, portal: string, captureUrl: string): CaptureTask {
  return { id, portal, label: id, url: captureUrl, captureUrl, loosened: [] };
}

function mkConnector(
  portal: string,
  entries: { task: CaptureTask; due: boolean }[],
): ConnectorView {
  const taskViews = entries.map(({ task, due }) => ({
    task,
    muted: !due,
    due,
    lastRunAt: due ? null : new Date().toISOString(),
    lastDone: due ? "nunca" : "hecho hace unos segundos",
  }));
  const dueCount = taskViews.filter((t) => t.due).length;
  const mutedCount = taskViews.filter((t) => t.muted).length;
  return {
    portal,
    label: portal,
    taskViews,
    totalTasks: taskViews.length,
    dueCount,
    mutedCount,
    state: deriveConnectorState(dueCount, mutedCount),
    defaultExpanded: dueCount > 0,
    capturedProfile: 0,
  };
}

const T_DUE_1 = mkTask("t1", "idealista", "https://idealista.example/1");
const T_DUE_2 = mkTask("t2", "idealista", "https://idealista.example/2");
const T_MUTED = mkTask("t3", "aliseda", "https://aliseda.example/1");

describe("defaultTickedTaskIds", () => {
  it("ticks every DUE task and leaves MUTED tasks unticked", () => {
    const connectors = [
      mkConnector("idealista", [
        { task: T_DUE_1, due: true },
        { task: T_DUE_2, due: true },
      ]),
      mkConnector("aliseda", [{ task: T_MUTED, due: false }]),
    ];
    expect(defaultTickedTaskIds(connectors)).toEqual(new Set(["t1", "t2"]));
  });

  it("returns an empty set when nothing is due", () => {
    const connectors = [mkConnector("aliseda", [{ task: T_MUTED, due: false }])];
    expect(defaultTickedTaskIds(connectors).size).toBe(0);
  });
});

describe("allProfileTasks", () => {
  it("flattens every connector's tasks, preserving order", () => {
    const connectors = [
      mkConnector("idealista", [
        { task: T_DUE_1, due: true },
        { task: T_DUE_2, due: true },
      ]),
      mkConnector("aliseda", [{ task: T_MUTED, due: false }]),
    ];
    expect(allProfileTasks(connectors).map((t) => t.id)).toEqual(["t1", "t2", "t3"]);
  });
});

describe("buildCaptureBatchPlan", () => {
  const tasks = [T_DUE_1, T_DUE_2, T_MUTED];

  it("returns null when nothing is ticked — the caller must mutate nothing", () => {
    expect(buildCaptureBatchPlan(tasks, new Set())).toBeNull();
  });

  it("picks the first ticked task (in TASK LIST order, not Set insertion order) and queues the rest", () => {
    // Set built in reverse order — the plan must still follow `tasks`' order.
    const ticked = new Set(["t3", "t1"]);
    const plan = buildCaptureBatchPlan(tasks, ticked);
    expect(plan).not.toBeNull();
    expect(plan!.first.id).toBe("t1");
    expect(plan!.queue).toEqual([{ portal: "aliseda", captureUrl: T_MUTED.captureUrl }]);
    expect(plan!.taskIds).toEqual(["t1", "t3"]);
  });

  it("a single ticked task yields an empty queue (degenerates to the single-task flow)", () => {
    const plan = buildCaptureBatchPlan(tasks, new Set(["t2"]));
    expect(plan!.first.id).toBe("t2");
    expect(plan!.queue).toEqual([]);
    expect(plan!.taskIds).toEqual(["t2"]);
  });

  it("every ticked task appears in taskIds, including the first", () => {
    const plan = buildCaptureBatchPlan(tasks, new Set(["t1", "t2", "t3"]));
    expect(plan!.taskIds).toEqual(["t1", "t2", "t3"]);
    expect(plan!.queue.map((q) => q.captureUrl)).toEqual([T_DUE_2.captureUrl, T_MUTED.captureUrl]);
  });

  it("ignores ticked ids absent from the task list (stale selection)", () => {
    const plan = buildCaptureBatchPlan(tasks, new Set(["ghost", "t1"]));
    expect(plan!.taskIds).toEqual(["t1"]);
  });
});

describe("capCaptureBatchPlan (issue #556 review B3 — bound the piggybacked queue)", () => {
  function planWithQueueLength(n: number) {
    const first = mkTask("first", "idealista", "https://x/first");
    const queue = Array.from({ length: n }, (_, i) => ({ portal: "idealista", captureUrl: `https://x/${i}` }));
    return {
      first,
      queue,
      taskIds: ["first", ...queue.map((_, i) => `q${i}`)],
    };
  }

  it("is a no-op (droppedCount 0, same plan) when already within the cap", () => {
    const plan = planWithQueueLength(5);
    const capped = capCaptureBatchPlan(plan, 10);
    expect(capped.droppedCount).toBe(0);
    expect(capped.plan).toEqual(plan);
  });

  it("is a no-op exactly AT the cap boundary", () => {
    const plan = planWithQueueLength(10);
    const capped = capCaptureBatchPlan(plan, 10);
    expect(capped.droppedCount).toBe(0);
    expect(capped.plan.queue).toHaveLength(10);
  });

  it("truncates the queue and taskIds together, reporting how many were dropped", () => {
    const plan = planWithQueueLength(30);
    const capped = capCaptureBatchPlan(plan, 24);
    expect(capped.droppedCount).toBe(6);
    expect(capped.plan.queue).toHaveLength(24);
    // taskIds = first + kept queue entries only — the dropped tail never appears.
    expect(capped.plan.taskIds).toHaveLength(25);
    expect(capped.plan.taskIds[0]).toBe("first");
    expect(capped.plan.first).toBe(plan.first); // the first task always rides along regardless
  });

  it("the FIRST task is never counted against the cap (only the queue tail is bounded)", () => {
    const plan = planWithQueueLength(1);
    const capped = capCaptureBatchPlan(plan, 0);
    expect(capped.plan.queue).toHaveLength(0);
    expect(capped.plan.taskIds).toEqual(["first"]); // first still present even with a 0 cap
    expect(capped.droppedCount).toBe(1);
  });
});

// ─── Cross-profile "Capturar todo" (issue #559) ────────────────────────────

function mkProfileView(id: number, name: string, connectors: ConnectorView[]): ProfileCaptureView {
  const totalTasks = connectors.reduce((a, c) => a + c.totalTasks, 0);
  return {
    id,
    name,
    connectors,
    totalTasks,
    actionableConnectors: connectors.filter((c) => c.state !== "not-due").length,
  };
}

describe("selectionKey", () => {
  it("combines profileId + taskId", () => {
    expect(selectionKey(7, "t1")).toBe("7:t1");
  });
  it("distinguishes two profiles sharing the same bare task id", () => {
    expect(selectionKey(1, "t1")).not.toBe(selectionKey(2, "t1"));
  });
});

describe("allTasksAcrossProfiles", () => {
  it("flattens every profile's tasks, tagged with their profile id, preserving profile then task order", () => {
    const p1 = mkProfileView(1, "A", [
      mkConnector("idealista", [
        { task: T_DUE_1, due: true },
        { task: T_DUE_2, due: true },
      ]),
    ]);
    const p2 = mkProfileView(2, "B", [mkConnector("aliseda", [{ task: T_MUTED, due: false }])]);
    const out = allTasksAcrossProfiles([p1, p2]);
    expect(out).toEqual([
      { profileId: 1, task: T_DUE_1 },
      { profileId: 1, task: T_DUE_2 },
      { profileId: 2, task: T_MUTED },
    ]);
  });

  it("returns [] for no profiles", () => {
    expect(allTasksAcrossProfiles([])).toEqual([]);
  });
});

describe("defaultTickedSelectionKeys", () => {
  it("ticks every DUE task across EVERY given profile, keyed by (profileId, taskId)", () => {
    const p1 = mkProfileView(1, "A", [
      mkConnector("idealista", [
        { task: T_DUE_1, due: true },
        { task: T_DUE_2, due: true },
      ]),
    ]);
    const p2 = mkProfileView(2, "B", [mkConnector("aliseda", [{ task: T_MUTED, due: false }])]);
    const keys = defaultTickedSelectionKeys([p1, p2]);
    expect(keys).toEqual(new Set([selectionKey(1, "t1"), selectionKey(1, "t2")]));
  });

  it("returns an empty set when nothing anywhere is due", () => {
    const p = mkProfileView(1, "A", [mkConnector("aliseda", [{ task: T_MUTED, due: false }])]);
    expect(defaultTickedSelectionKeys([p]).size).toBe(0);
  });
});

describe("buildGlobalCaptureBatchPlan (issue #559)", () => {
  // Same bare task id ("shared") on TWO different profiles — the scenario
  // that makes a cross-profile plan need composite keys at all.
  const shared = (portal: string, suffix: string) => ({
    id: "shared",
    portal,
    label: `${portal}-${suffix}`,
    url: `https://${portal}.example/${suffix}`,
    captureUrl: `https://${portal}.example/${suffix}`,
    loosened: [],
  });
  const P1_SHARED = shared("idealista", "p1");
  const P2_SHARED = shared("idealista", "p2");

  function twoProfileTasks(): ProfileTask[] {
    return [
      { profileId: 1, task: P1_SHARED },
      { profileId: 2, task: P2_SHARED },
    ];
  }

  it("returns null when nothing is ticked", () => {
    expect(buildGlobalCaptureBatchPlan(twoProfileTasks(), new Set())).toBeNull();
  });

  it("distinguishes two profiles' tasks sharing the same bare id — ticking only profile 2's opens/queues the right one", () => {
    const ticked = new Set([selectionKey(2, "shared")]);
    const plan = buildGlobalCaptureBatchPlan(twoProfileTasks(), ticked);
    expect(plan).not.toBeNull();
    expect(plan!.first).toBe(P2_SHARED);
    expect(plan!.entries).toEqual([{ profileId: 2, taskId: "shared" }]);
    expect(plan!.queue).toEqual([]);
  });

  it("ticking BOTH profiles' same-id task keeps them distinct in entries and queues the second", () => {
    const ticked = new Set([selectionKey(1, "shared"), selectionKey(2, "shared")]);
    const plan = buildGlobalCaptureBatchPlan(twoProfileTasks(), ticked);
    expect(plan!.first).toBe(P1_SHARED);
    expect(plan!.entries).toEqual([
      { profileId: 1, taskId: "shared" },
      { profileId: 2, taskId: "shared" },
    ]);
    expect(plan!.queue).toEqual([{ portal: "idealista", captureUrl: P2_SHARED.captureUrl }]);
  });

  it("preserves the profileTasks display order (profile order, then each profile's task order)", () => {
    const p1 = { profileId: 1, task: T_DUE_1 };
    const p1b = { profileId: 1, task: T_DUE_2 };
    const p2 = { profileId: 2, task: T_MUTED };
    const ticked = new Set([selectionKey(2, "t3"), selectionKey(1, "t1"), selectionKey(1, "t2")]);
    const plan = buildGlobalCaptureBatchPlan([p1, p1b, p2], ticked);
    expect(plan!.entries.map((e) => `${e.profileId}:${e.taskId}`)).toEqual(["1:t1", "1:t2", "2:t3"]);
  });
});

describe("capGlobalCaptureBatchPlan (issue #559)", () => {
  function bigCrossProfilePlan(perProfile: number, profileCount: number) {
    const profileTasks: ProfileTask[] = [];
    for (let p = 1; p <= profileCount; p += 1) {
      for (let i = 0; i < perProfile; i += 1) {
        profileTasks.push({
          profileId: p,
          task: mkTask(`p${p}-t${i}`, "idealista", `https://x/${p}/${i}`),
        });
      }
    }
    const ticked = new Set(profileTasks.map((pt) => selectionKey(pt.profileId, pt.task.id)));
    return buildGlobalCaptureBatchPlan(profileTasks, ticked)!;
  }

  it("is a no-op when already within the cap", () => {
    const plan = bigCrossProfilePlan(3, 2); // 6 total, 5 in queue
    const capped = capGlobalCaptureBatchPlan(plan, 10);
    expect(capped.droppedCount).toBe(0);
    expect(capped.droppedProfileIds).toEqual([]);
    expect(capped.plan).toEqual(plan);
  });

  it("truncates the tail and reports WHICH profiles lost entries — the whole point of issue #559's cap message", () => {
    // Profile 1 contributes 20 tasks (fits entirely within a 24 cap after the
    // first), profile 2 contributes 10 more — the tail that gets dropped is
    // entirely profile 2's.
    const p1Tasks: ProfileTask[] = Array.from({ length: 20 }, (_, i) => ({
      profileId: 1,
      task: mkTask(`p1-t${i}`, "idealista", `https://x/1/${i}`),
    }));
    const p2Extra: ProfileTask[] = Array.from({ length: 10 }, (_, i) => ({
      profileId: 2,
      task: mkTask(`p2-extra-${i}`, "idealista", `https://x/2extra/${i}`),
    }));
    const allTasks = [...p1Tasks, ...p2Extra];
    const ticked = new Set(allTasks.map((pt) => selectionKey(pt.profileId, pt.task.id)));
    const fullPlan = buildGlobalCaptureBatchPlan(allTasks, ticked)!;

    const capped = capGlobalCaptureBatchPlan(fullPlan, 24);
    expect(capped.droppedCount).toBe(30 - 1 - 24); // total 30, 1 "first" + 24 kept queue
    expect(capped.droppedProfileIds).toEqual([2]); // only profile 2's tail was dropped
    expect(capped.plan.entries).toHaveLength(25);
    expect(capped.plan.queue).toHaveLength(24);
  });

  it("names MULTIPLE dropped profiles when the cap cuts across a profile boundary", () => {
    // Profile 1: 30 tasks (more than the whole cap on its own), profile 2: 5
    // more. Cap at 24 (1 first + 23 queue → 25 kept total) keeps entries
    // 0..24 — ALL from profile 1 (which has 30) — and drops entries 25..34:
    // profile 1's remaining 5 (indices 25-29) AND every one of profile 2's 5
    // (indices 30-34). The dropped tail spans the profile boundary.
    const p1Tasks: ProfileTask[] = Array.from({ length: 30 }, (_, i) => ({
      profileId: 1,
      task: mkTask(`p1-t${i}`, "idealista", `https://x/1/${i}`),
    }));
    const p2Tasks: ProfileTask[] = Array.from({ length: 5 }, (_, i) => ({
      profileId: 2,
      task: mkTask(`p2-t${i}`, "idealista", `https://x/2/${i}`),
    }));
    const allTasks = [...p1Tasks, ...p2Tasks];
    const ticked = new Set(allTasks.map((pt) => selectionKey(pt.profileId, pt.task.id)));
    const plan = buildGlobalCaptureBatchPlan(allTasks, ticked)!;

    const capped = capGlobalCaptureBatchPlan(plan, 24);
    expect(capped.droppedCount).toBe(35 - 1 - 24);
    // The dropped tail spans the boundary between profile 1 and profile 2.
    expect(capped.droppedProfileIds.sort()).toEqual([1, 2]);
  });

  it("the FIRST task is never counted against the cap regardless of which profile it belongs to", () => {
    const plan = bigCrossProfilePlan(1, 1);
    const capped = capGlobalCaptureBatchPlan(plan, 0);
    expect(capped.plan.queue).toHaveLength(0);
    expect(capped.plan.entries).toEqual([{ profileId: 1, taskId: "p1-t0" }]);
    expect(capped.droppedCount).toBe(0);
  });
});
