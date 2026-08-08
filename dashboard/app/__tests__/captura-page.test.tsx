// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent, within } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { CapturaProfiles } from "@/components/captura/CapturaProfiles";
import {
  deriveConnectorState,
  buildConnectorViews,
  type CaptureTask,
  type ConnectorTaskView,
  type ConnectorView,
  type ProfileCaptureView,
  type StalenessConfig,
} from "@/lib/captura-tasks";

/**
 * #413 redesign — the page is now a SERVER component that fans out DB reads and
 * hands a fully-computed view-model to the client `CapturaProfiles`. So the
 * component test drives `CapturaProfiles` with an explicit view-model (no fetch
 * fan-out to mock), and the pure due/collapse math is covered directly against
 * `buildConnectorViews` / `deriveConnectorState`.
 */

function mkTask(id: string, portal: string, url: string): CaptureTask {
  return { id, portal, label: `${portal} · ${id}`, url, loosened: [] };
}

function mkTaskView(task: CaptureTask, opts: { muted: boolean }): ConnectorTaskView {
  return {
    task,
    muted: opts.muted,
    due: !opts.muted,
    lastRunAt: opts.muted ? new Date().toISOString() : null,
    lastDone: opts.muted ? "hecho hace unos segundos" : "nunca",
  };
}

function mkConnector(
  portal: string,
  taskViews: ConnectorTaskView[],
  extra: Partial<ConnectorView> = {},
): ConnectorView {
  const dueCount = taskViews.filter((t) => t.due).length;
  const mutedCount = taskViews.filter((t) => t.muted).length;
  const state = deriveConnectorState(dueCount, mutedCount);
  return {
    portal,
    label: portal[0].toUpperCase() + portal.slice(1),
    taskViews,
    totalTasks: taskViews.length,
    dueCount,
    mutedCount,
    state,
    defaultExpanded: dueCount > 0,
    capturedProfile: 0,
    ...extra,
  };
}

const IDEALISTA_URL = "https://www.idealista.com/venta-viviendas/madrid/";
const ALISEDA_URL = "https://www.alisedainmobiliaria.com/venta?precioMax=200000";

// Profile 1: idealista DUE (expanded), aliseda NOT-DUE (collapsed).
// Profile 2: idealista HALF-DONE (expanded, one task done + one pending).
const IDEA_DUE = mkTask("idea-due", "idealista", IDEALISTA_URL);
const ALI_DONE = mkTask("ali-done", "aliseda", ALISEDA_URL);
const IDEA_HALF_DONE = mkTask("idea-half-done", "idealista", IDEALISTA_URL + "?a=1");
const IDEA_HALF_PENDING = mkTask("idea-half-pending", "idealista", IDEALISTA_URL + "?a=2");

function buildViews(): ProfileCaptureView[] {
  const p1Idealista = mkConnector("idealista", [mkTaskView(IDEA_DUE, { muted: false })], {
    capturedProfile: 10,
  });
  const p1Aliseda = mkConnector("aliseda", [mkTaskView(ALI_DONE, { muted: true })]);
  const p2Idealista = mkConnector("idealista", [
    mkTaskView(IDEA_HALF_DONE, { muted: true }),
    mkTaskView(IDEA_HALF_PENDING, { muted: false }),
  ]);
  return [
    {
      id: 1,
      name: "Madrid centro",
      connectors: [p1Idealista, p1Aliseda],
      totalTasks: 2,
      actionableConnectors: 1,
    },
    {
      id: 2,
      name: "Costa",
      connectors: [p2Idealista],
      totalTasks: 2,
      actionableConnectors: 1,
    },
  ];
}

describe("deriveConnectorState", () => {
  it("is not-due when nothing is due (collapsed)", () => {
    expect(deriveConnectorState(0, 3)).toBe("not-due");
  });
  it("is half-done when some tasks are due and some done (expanded)", () => {
    expect(deriveConnectorState(2, 1)).toBe("half-done");
  });
  it("is due when everything is pending this cycle (expanded)", () => {
    expect(deriveConnectorState(2, 0)).toBe("due");
  });
});

describe("buildConnectorViews (due/collapse derivation)", () => {
  const STALENESS: StalenessConfig = { defaultDays: 7, byPortal: {} };
  const now = new Date("2026-08-07T12:00:00Z");
  const recent = new Date("2026-08-06T12:00:00Z").toISOString(); // 1 day ago (< 7 → muted)
  const old = new Date("2026-07-01T12:00:00Z").toISOString(); // > 7 days → due

  it("collapses a connector where every task ran within the window", () => {
    const tasks = [mkTask("a", "idealista", IDEALISTA_URL), mkTask("b", "idealista", IDEALISTA_URL + "?x")];
    const [conn] = buildConnectorViews(tasks, { a: recent, b: recent }, STALENESS, {}, now);
    expect(conn.state).toBe("not-due");
    expect(conn.defaultExpanded).toBe(false);
    expect(conn.dueCount).toBe(0);
  });

  it("marks a connector half-done (expanded) when one task is pending and one recent", () => {
    const tasks = [mkTask("a", "idealista", IDEALISTA_URL), mkTask("b", "idealista", IDEALISTA_URL + "?x")];
    const [conn] = buildConnectorViews(tasks, { a: recent }, STALENESS, {}, now);
    expect(conn.state).toBe("half-done");
    expect(conn.defaultExpanded).toBe(true);
    expect(conn.dueCount).toBe(1);
    expect(conn.mutedCount).toBe(1);
  });

  it("marks a connector due (expanded) when every task is pending or stale", () => {
    const tasks = [mkTask("a", "idealista", IDEALISTA_URL), mkTask("b", "idealista", IDEALISTA_URL + "?x")];
    const [conn] = buildConnectorViews(tasks, { b: old }, STALENESS, {}, now);
    expect(conn.state).toBe("due");
    expect(conn.defaultExpanded).toBe(true);
  });
});

describe("CapturaProfiles (stacked per-profile)", () => {
  afterEach(() => vi.restoreAllMocks());
  beforeEach(() => vi.restoreAllMocks());

  it("stacks every profile with its connectors", () => {
    render(<CapturaProfiles profiles={buildViews()} />);
    expect(screen.getByTestId("captura-profile-1")).toBeInTheDocument();
    expect(screen.getByTestId("captura-profile-2")).toBeInTheDocument();
    expect(within(screen.getByTestId("captura-profile-1")).getByRole("heading", { name: "Madrid centro" })).toBeInTheDocument();
    expect(within(screen.getByTestId("captura-profile-2")).getByRole("heading", { name: "Costa" })).toBeInTheDocument();
    // No error surface.
    expect(screen.queryByText("Detalles técnicos")).not.toBeInTheDocument();
  });

  it("expands due & half-done connectors by default, collapses not-due ones", () => {
    render(<CapturaProfiles profiles={buildViews()} />);

    // Profile 1 idealista is DUE → expanded, its run button visible.
    const p1Idea = screen.getByTestId("captura-connector-1-idealista");
    expect(p1Idea).toHaveAttribute("data-state", "due");
    expect(p1Idea).toHaveAttribute("data-expanded", "true");
    expect(screen.getByTestId(`captura-task-run-${IDEA_DUE.id}`)).toBeVisible();

    // Profile 1 aliseda is NOT-DUE → collapsed: a stats line, no task rows.
    const p1Ali = screen.getByTestId("captura-connector-1-aliseda");
    expect(p1Ali).toHaveAttribute("data-state", "not-due");
    expect(p1Ali).toHaveAttribute("data-expanded", "false");
    expect(screen.getByTestId("captura-connector-stats-1-aliseda")).toBeInTheDocument();
    expect(screen.queryByTestId(`captura-task-run-${ALI_DONE.id}`)).not.toBeInTheDocument();

    // Profile 2 idealista is HALF-DONE → expanded with an "A medias" badge.
    const p2Idea = screen.getByTestId("captura-connector-2-idealista");
    expect(p2Idea).toHaveAttribute("data-state", "half-done");
    expect(p2Idea).toHaveAttribute("data-expanded", "true");
    expect(screen.getByTestId("captura-connector-badge-2-idealista")).toHaveTextContent("A medias");
  });

  it("expands a collapsed connector manually", () => {
    render(<CapturaProfiles profiles={buildViews()} />);
    const toggle = screen.getByTestId("captura-connector-toggle-1-aliseda");
    // Collapsed: no task row yet.
    expect(screen.queryByTestId(`captura-task-run-${ALI_DONE.id}`)).not.toBeInTheDocument();
    fireEvent.click(toggle);
    expect(screen.getByTestId("captura-connector-1-aliseda")).toHaveAttribute("data-expanded", "true");
    expect(screen.getByTestId(`captura-task-run-${ALI_DONE.id}`)).toBeVisible();
  });

  it("records the run and grays the row optimistically when a launch button is clicked", async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ ok: true, taskId: IDEA_DUE.id, lastRunAt: new Date().toISOString() }),
    });
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    const openSpy = vi.spyOn(window, "open").mockReturnValue(null);

    render(<CapturaProfiles profiles={buildViews()} />);
    fireEvent.click(screen.getByTestId(`captura-task-run-${IDEA_DUE.id}`));

    // POSTs the run to the OWNING profile's endpoint.
    await waitFor(() =>
      expect(
        fetchSpy.mock.calls.some(
          (c) =>
            String(c[0]) === "/api/profiles/1/capture-task-runs" &&
            (c[1] as RequestInit)?.method === "POST",
        ),
      ).toBe(true),
    );
    // Opens the URL tagged with the auto-start signal.
    await waitFor(() =>
      expect(openSpy).toHaveBeenCalledWith(
        `${IDEALISTA_URL}#inmo-capture`,
        "_blank",
        expect.any(String),
      ),
    );
    // Optimistic grey-out of the launched task's row.
    await waitFor(() => {
      const row = screen.getByTestId(`captura-task-${IDEA_DUE.id}`);
      expect(row).toHaveAttribute("data-muted", "true");
    });
  });

  it("filters to a single profile when the optional filter is used", () => {
    render(<CapturaProfiles profiles={buildViews()} />);
    expect(screen.getByTestId("captura-profile-2")).toBeInTheDocument();
    fireEvent.change(screen.getByTestId("captura-profile-filter"), { target: { value: "1" } });
    expect(screen.getByTestId("captura-profile-1")).toBeInTheDocument();
    expect(screen.queryByTestId("captura-profile-2")).not.toBeInTheDocument();
  });

  it("shows a per-profile empty note when a profile has no connectors", () => {
    const views: ProfileCaptureView[] = [
      { id: 5, name: "Vacío", connectors: [], totalTasks: 0, actionableConnectors: 0 },
    ];
    render(<CapturaProfiles profiles={views} />);
    expect(within(screen.getByTestId("captura-profile-5")).getByTestId("captura-profile-empty-5")).toBeInTheDocument();
  });
});
