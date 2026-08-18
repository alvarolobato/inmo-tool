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
import { MAX_QUEUE_ENTRIES } from "@/lib/extension-capture";

/**
 * #413 redesign — the page is now a SERVER component that fans out DB reads and
 * hands a fully-computed view-model to the client `CapturaProfiles`. So the
 * component test drives `CapturaProfiles` with an explicit view-model (no fetch
 * fan-out to mock), and the pure due/collapse math is covered directly against
 * `buildConnectorViews` / `deriveConnectorState`.
 */

function mkTask(id: string, portal: string, url: string): CaptureTask {
  // captureUrl defaults to url (no map-view) — #529; a map task would pass a
  // distinct listing form explicitly.
  return { id, portal, label: `${portal} · ${id}`, url, captureUrl: url, loosened: [] };
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

describe("CapturaProfiles — global 'Capturar todo' (issue #559)", () => {
  afterEach(() => vi.restoreAllMocks());
  beforeEach(() => vi.restoreAllMocks());

  /** A fake `Window` — `window.open` mocked to return this counts as "opened" (non-null). */
  const FAKE_WINDOW = {} as Window;

  it("is ONE button spanning every profile — the count includes DUE tasks across both", () => {
    render(<CapturaProfiles profiles={buildViews()} />);
    // Profile 1: IDEA_DUE is due. Profile 2: IDEA_HALF_PENDING is due. Total = 2.
    expect(screen.getByTestId("captura-batch-run")).toHaveTextContent("Capturar 2 tareas");
    // No per-profile buttons anywhere.
    expect(screen.queryByTestId("captura-batch-run-1")).toBeNull();
    expect(screen.queryByTestId("captura-batch-run-2")).toBeNull();
  });

  it("is ONE select-all/select-none pair — none per-profile", () => {
    render(<CapturaProfiles profiles={buildViews()} />);
    expect(screen.getAllByTestId("captura-batch-select-all")).toHaveLength(1);
    expect(screen.getAllByTestId("captura-batch-select-none")).toHaveLength(1);
    expect(screen.queryByTestId("captura-batch-select-all-1")).toBeNull();
    expect(screen.queryByTestId("captura-batch-select-none-1")).toBeNull();
  });

  it("select-all/select-none act across BOTH profiles from one click", () => {
    render(<CapturaProfiles profiles={buildViews()} />);
    fireEvent.click(screen.getByTestId("captura-batch-select-all"));
    expect(screen.getByTestId("captura-batch-run")).toHaveTextContent("Capturar 4 tareas");
    fireEvent.click(screen.getByTestId("captura-batch-select-none"));
    expect(screen.getByTestId("captura-batch-run")).toHaveTextContent("Capturar 0 tareas");
  });

  it("a task is tickable/untickable with EVERY connector collapsed (issue #559 core fix)", () => {
    render(<CapturaProfiles profiles={buildViews()} />);
    // Profile 1's aliseda connector (ALI_DONE, muted) is NOT-DUE → collapsed by
    // default. Its checkbox must still be reachable and functional without
    // expanding anything.
    const aliseda = screen.getByTestId("captura-connector-1-aliseda");
    expect(aliseda).toHaveAttribute("data-expanded", "false");
    const check = screen.getByTestId(`captura-task-check-1-${ALI_DONE.id}`);
    expect(check).not.toBeChecked(); // muted → not ticked by default
    fireEvent.click(check);
    expect(check).toBeChecked();
    expect(aliseda).toHaveAttribute("data-expanded", "false"); // never expanded
    expect(screen.getByTestId("captura-batch-run")).toHaveTextContent("Capturar 3 tareas");
  });

  it("nothing ticked → clicking Capturar todo shows a message and mutates nothing", async () => {
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    const openSpy = vi.spyOn(window, "open").mockReturnValue(null);

    render(<CapturaProfiles profiles={buildViews()} />);
    fireEvent.click(screen.getByTestId("captura-batch-select-none"));
    fireEvent.click(screen.getByTestId("captura-batch-run"));

    await waitFor(() =>
      expect(screen.getByTestId("captura-batch-status")).toHaveTextContent("No has marcado ninguna tarea"),
    );
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(openSpy).not.toHaveBeenCalled();
  });

  it("a click spanning two profiles opens ONE tab and records a run against EACH task's own profile endpoint", async () => {
    const fetchSpy = vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({ ok: true }) });
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    const openSpy = vi.spyOn(window, "open").mockReturnValue(FAKE_WINDOW);

    render(<CapturaProfiles profiles={buildViews()} />);
    // Default ticks: IDEA_DUE (profile 1) + IDEA_HALF_PENDING (profile 2).
    fireEvent.click(screen.getByTestId("captura-batch-run"));

    expect(openSpy).toHaveBeenCalledTimes(1);
    const opened = new URL(String(openSpy.mock.calls[0][0]));
    expect(opened.origin + opened.pathname).toBe(IDEALISTA_URL); // profile 1's task opens first (display order)

    await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(2));
    const posted = fetchSpy.mock.calls.map((c) => ({
      url: String(c[0]),
      body: JSON.parse((c[1] as RequestInit).body as string),
    }));
    expect(posted).toEqual(
      expect.arrayContaining([
        { url: "/api/profiles/1/capture-task-runs", body: { taskId: IDEA_DUE.id } },
        { url: "/api/profiles/2/capture-task-runs", body: { taskId: IDEA_HALF_PENDING.id } },
      ]),
    );

    await waitFor(() => expect(screen.getByTestId("captura-batch-run")).toHaveTextContent("Capturar 0 tareas"));
  });

  it("filtering to one profile scopes the count, select-all/none, and the click to ONLY that profile's tasks — and says so", () => {
    render(<CapturaProfiles profiles={buildViews()} />);
    // No scope note while unfiltered.
    expect(screen.queryByTestId("captura-batch-scope-note")).toBeNull();

    fireEvent.change(screen.getByTestId("captura-profile-filter"), { target: { value: "1" } });
    // Only profile 1 visible → scope note names it.
    expect(screen.getByTestId("captura-batch-scope-note")).toHaveTextContent("Madrid centro");
    // Count now reflects ONLY profile 1's ticked-and-visible tasks (IDEA_DUE).
    expect(screen.getByTestId("captura-batch-run")).toHaveTextContent("Capturar 1 tarea");

    // select-all under the filter only ticks profile 1's tasks (2 total: IDEA_DUE + ALI_DONE).
    fireEvent.click(screen.getByTestId("captura-batch-select-all"));
    expect(screen.getByTestId("captura-batch-run")).toHaveTextContent("Capturar 2 tareas");

    // Clearing the filter reveals profile 2's ticks were UNTOUCHED by the
    // filtered select-all (still just its own default: IDEA_HALF_PENDING).
    fireEvent.change(screen.getByTestId("captura-profile-filter"), { target: { value: "" } });
    expect(screen.getByTestId("captura-batch-run")).toHaveTextContent("Capturar 3 tareas"); // 2 (profile 1, all) + 1 (profile 2, default)
  });

  it("caps how many searches ride along across profiles and names EVERY affected profile in the status", async () => {
    const N_PER_PROFILE = MAX_QUEUE_ENTRIES; // 24 per profile → 48 total, well over the cap
    function bigProfile(id: number, name: string): ProfileCaptureView {
      const taskViews: ConnectorTaskView[] = Array.from({ length: N_PER_PROFILE }, (_, i) =>
        mkTaskView(mkTask(`p${id}-t${i}`, "idealista", `https://www.idealista.com/venta-viviendas/x${id}-${i}/`), {
          muted: false,
        }),
      );
      const connector = mkConnector("idealista", taskViews);
      return { id, name, connectors: [connector], totalTasks: N_PER_PROFILE, actionableConnectors: 1 };
    }
    const profiles = [bigProfile(101, "Grande Uno"), bigProfile(102, "Grande Dos")];

    const fetchSpy = vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({ ok: true }) });
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    vi.spyOn(window, "open").mockReturnValue(FAKE_WINDOW);

    render(<CapturaProfiles profiles={profiles} />);
    expect(screen.getByTestId("captura-batch-run")).toHaveTextContent(`Capturar ${2 * N_PER_PROFILE} tareas`);
    fireEvent.click(screen.getByTestId("captura-batch-run"));

    const expectedPosts = 1 + MAX_QUEUE_ENTRIES;
    await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(expectedPosts));
    const droppedCount = 2 * N_PER_PROFILE - expectedPosts;
    await waitFor(() => {
      const status = screen.getByTestId("captura-batch-status");
      expect(status).toHaveTextContent(`${droppedCount} tareas no caben en esta tanda`);
      // Profile 101 fully fits within the cap (24 of the 24+ before profile
      // 102 even starts contributing to the queue) — only 102 loses tasks.
      expect(status).toHaveTextContent("Grande Dos");
      expect(status).not.toHaveTextContent("Grande Uno");
    });
  });
});
