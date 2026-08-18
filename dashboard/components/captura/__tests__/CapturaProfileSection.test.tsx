// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { CapturaProfileSection } from "@/components/captura/CapturaProfileSection";
import {
  deriveConnectorState,
  type CaptureTask,
  type ConnectorTaskView,
  type ConnectorView,
  type ProfileCaptureView,
} from "@/lib/captura-tasks";
import { MAX_QUEUE_ENTRIES } from "@/lib/extension-capture";

/**
 * Unit coverage for the "Capturar todo" batch button (issue #556, D-113):
 * default tick state (due → ticked, muted → unticked), select-all/none, the
 * live count in the button label, the nothing-ticked no-op, and — the
 * bug-prone parts — that a multi-task click:
 *   - opens exactly ONE tab (never N);
 *   - carries the auto-start signal in the QUERY and the rest of the ticked
 *     tasks in the URL FRAGMENT (D-113 review B2 — never the query, so the
 *     payload never reaches the first task's portal server);
 *   - opens the tab BEFORE recording anything (review N5);
 *   - caps how many searches ride along and never records a dropped task as
 *     done (review B3);
 *   - un-ticks + greys out every task it just launched (review N7), so a
 *     second click doesn't re-fire the same batch.
 */

function mkTask(id: string, portal: string, captureUrl: string): CaptureTask {
  return { id, portal, label: `${portal} · ${id}`, url: captureUrl, captureUrl, loosened: [] };
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

function mkConnector(portal: string, taskViews: ConnectorTaskView[]): ConnectorView {
  const dueCount = taskViews.filter((t) => t.due).length;
  const mutedCount = taskViews.filter((t) => t.muted).length;
  return {
    portal,
    label: portal[0].toUpperCase() + portal.slice(1),
    taskViews,
    totalTasks: taskViews.length,
    dueCount,
    mutedCount,
    state: deriveConnectorState(dueCount, mutedCount),
    defaultExpanded: dueCount > 0,
    capturedProfile: 0,
  };
}

const IDEA_DUE_1 = mkTask("idea-1", "idealista", "https://www.idealista.com/venta-viviendas/madrid/piso/");
const IDEA_DUE_2 = mkTask("idea-2", "idealista", "https://www.idealista.com/venta-viviendas/madrid/local/");
const ALI_MUTED = mkTask("ali-1", "aliseda", "https://www.alisedainmobiliaria.com/venta?precioMax=200000");

function buildProfile(): ProfileCaptureView {
  const idealista = mkConnector("idealista", [
    mkTaskView(IDEA_DUE_1, { muted: false }),
    mkTaskView(IDEA_DUE_2, { muted: false }),
  ]);
  const aliseda = mkConnector("aliseda", [mkTaskView(ALI_MUTED, { muted: true })]);
  return {
    id: 1,
    name: "Madrid centro",
    connectors: [idealista, aliseda],
    totalTasks: 3,
    actionableConnectors: 1,
  };
}

/** A fake `Window` — `window.open` mocked to return this counts as "opened" (non-null). */
const FAKE_WINDOW = {} as Window;

describe("CapturaProfileSection — Capturar todo (issue #556)", () => {
  beforeEach(() => vi.restoreAllMocks());
  afterEach(() => vi.restoreAllMocks());

  it("pre-ticks DUE tasks and leaves MUTED tasks unticked, reflected in the button count", () => {
    render(<CapturaProfileSection profile={buildProfile()} />);
    expect(screen.getByTestId("captura-task-check-idea-1")).toBeChecked();
    expect(screen.getByTestId("captura-task-check-idea-2")).toBeChecked();
    expect(screen.getByTestId("captura-batch-run-1")).toHaveTextContent("Capturar 2 tareas");
    // aliseda's one task is MUTED (not-due) → its connector is collapsed by
    // default (#413); expand it to confirm its checkbox itself is unticked.
    fireEvent.click(screen.getByTestId("captura-connector-toggle-1-aliseda"));
    expect(screen.getByTestId("captura-task-check-ali-1")).not.toBeChecked();
  });

  it("select-all ticks every task (including a collapsed connector's); select-none clears them — count follows", () => {
    render(<CapturaProfileSection profile={buildProfile()} />);
    // aliseda is NOT-DUE (its one task is muted) → collapsed by default; the
    // batch selection must still cover it (allProfileTasks is not scoped to
    // what's currently rendered/expanded).
    fireEvent.click(screen.getByTestId("captura-batch-select-all-1"));
    expect(screen.getByTestId("captura-batch-run-1")).toHaveTextContent("Capturar 3 tareas");

    // Expand aliseda to confirm ITS checkbox reflects the same tick.
    fireEvent.click(screen.getByTestId("captura-connector-toggle-1-aliseda"));
    expect(screen.getByTestId("captura-task-check-ali-1")).toBeChecked();

    fireEvent.click(screen.getByTestId("captura-batch-select-none-1"));
    expect(screen.getByTestId("captura-batch-run-1")).toHaveTextContent("Capturar 0 tareas");
    expect(screen.getByTestId("captura-task-check-idea-1")).not.toBeChecked();
    expect(screen.getByTestId("captura-task-check-ali-1")).not.toBeChecked();
  });

  it("ticking a muted task back in (or a due one out) updates the count", () => {
    render(<CapturaProfileSection profile={buildProfile()} />);
    fireEvent.click(screen.getByTestId("captura-connector-toggle-1-aliseda")); // expand to reach its checkbox
    fireEvent.click(screen.getByTestId("captura-task-check-ali-1")); // tick back in
    expect(screen.getByTestId("captura-batch-run-1")).toHaveTextContent("Capturar 3 tareas");
    fireEvent.click(screen.getByTestId("captura-task-check-idea-1")); // untick a due one
    expect(screen.getByTestId("captura-batch-run-1")).toHaveTextContent("Capturar 2 tareas");
  });

  it("nothing ticked → clicking Capturar todo shows a message and mutates nothing", async () => {
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    const openSpy = vi.spyOn(window, "open").mockReturnValue(null);

    render(<CapturaProfileSection profile={buildProfile()} />);
    fireEvent.click(screen.getByTestId("captura-batch-select-none-1"));
    fireEvent.click(screen.getByTestId("captura-batch-run-1"));

    await waitFor(() =>
      expect(screen.getByTestId("captura-batch-status-1")).toHaveTextContent(
        "No has marcado ninguna tarea",
      ),
    );
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(openSpy).not.toHaveBeenCalled();
  });

  it("multi-task click opens exactly ONE tab BEFORE recording anything (N5), carrying the signal in the QUERY and the rest in the FRAGMENT (B2), and records a run for every ticked task", async () => {
    let openedBeforeFirstFetch = false;
    const fetchSpy = vi.fn().mockImplementation(async () => {
      openedBeforeFirstFetch = openSpy.mock.calls.length === 1; // captured on first fetch call
      return { ok: true, json: () => Promise.resolve({ ok: true }) };
    });
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    const openSpy = vi.spyOn(window, "open").mockReturnValue(FAKE_WINDOW);

    render(<CapturaProfileSection profile={buildProfile()} />);
    // Default tick state: idea-1 + idea-2 ticked (due), ali-1 unticked (muted).
    fireEvent.click(screen.getByTestId("captura-batch-run-1"));

    // Exactly ONE tab, ever — synchronously, before any fetch resolved.
    expect(openSpy).toHaveBeenCalledTimes(1);
    const openedUrl = String(openSpy.mock.calls[0][0]);
    const u = new URL(openedUrl);
    // Opens the FIRST ticked task's captureUrl (display order), never a 2nd tab.
    expect(u.origin + u.pathname).toBe("https://www.idealista.com/venta-viviendas/madrid/piso/");
    // B2: signal rides in the QUERY (fragment is claimed by the queue payload).
    expect(u.searchParams.get("inmo-capture")).toBe("1");
    // B2: the queue payload rides in the FRAGMENT, never the query string —
    // the whole point being that it's never sent to idealista's server.
    expect(u.searchParams.has("inmo-capture-queue")).toBe(false);
    expect(u.hash.startsWith("#inmo-capture-queue=")).toBe(true);
    const decoded = decodeURIComponent(u.hash.slice("#inmo-capture-queue=".length));
    expect(JSON.parse(decoded)).toEqual([["idealista", IDEA_DUE_2.captureUrl]]);

    // Records capture_task_run for BOTH ticked tasks (never the untouched muted one).
    await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(2));
    expect(openedBeforeFirstFetch).toBe(true); // N5: open happened before any record POST
    const posted = fetchSpy.mock.calls.map((c) => ({
      url: String(c[0]),
      body: JSON.parse((c[1] as RequestInit).body as string),
    }));
    expect(posted).toEqual(
      expect.arrayContaining([
        { url: "/api/profiles/1/capture-task-runs", body: { taskId: "idea-1" } },
        { url: "/api/profiles/1/capture-task-runs", body: { taskId: "idea-2" } },
      ]),
    );

    // N1: the status is honest about what's confirmed vs. merely queued.
    await waitFor(() =>
      expect(screen.getByTestId("captura-batch-status-1")).toHaveTextContent(
        'Se abre "idealista · idea-1" ahora.',
      ),
    );
    expect(screen.getByTestId("captura-batch-status-1")).toHaveTextContent(
      "1 búsqueda más en cola en la extensión",
    );
    expect(screen.getByTestId("captura-batch-status-1")).toHaveTextContent(
      "solo se capturarán si la extensión está instalada y activa",
    );

    // N7: both launched tasks un-tick themselves (a second click wouldn't re-fire them).
    await waitFor(() => expect(screen.getByTestId("captura-batch-run-1")).toHaveTextContent("Capturar 0 tareas"));
    expect(screen.getByTestId("captura-task-check-idea-1")).not.toBeChecked();
    expect(screen.getByTestId("captura-task-check-idea-2")).not.toBeChecked();
  });

  it("when window.open returns null (blocked), the status says so honestly instead of claiming success", async () => {
    const fetchSpy = vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({ ok: true }) });
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    vi.spyOn(window, "open").mockReturnValue(null); // simulates a popup-blocked open

    render(<CapturaProfileSection profile={buildProfile()} />);
    fireEvent.click(screen.getByTestId("captura-batch-run-1"));

    await waitFor(() =>
      expect(screen.getByTestId("captura-batch-status-1")).toHaveTextContent(
        "puede que el navegador haya bloqueado la pestaña",
      ),
    );
  });

  it("a single ticked task behaves like the plain single-task flow (no queue param, signal back in the fragment)", async () => {
    const fetchSpy = vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({ ok: true }) });
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    const openSpy = vi.spyOn(window, "open").mockReturnValue(FAKE_WINDOW);

    render(<CapturaProfileSection profile={buildProfile()} />);
    fireEvent.click(screen.getByTestId("captura-task-check-idea-2")); // leave only idea-1 ticked
    fireEvent.click(screen.getByTestId("captura-batch-run-1"));

    expect(openSpy).toHaveBeenCalledTimes(1);
    const u = new URL(String(openSpy.mock.calls[0][0]));
    expect(u.searchParams.has("inmo-capture-queue")).toBe(false);
    expect(u.hash).toBe("#inmo-capture"); // byte-identical to the single-task flow
    expect(u.searchParams.has("inmo-capture")).toBe(false); // signal not pushed to query when queue is empty

    await waitFor(() =>
      expect(screen.getByTestId("captura-batch-status-1")).toHaveTextContent('Se abre "idealista · idea-1" ahora.'),
    );
    expect(screen.getByTestId("captura-batch-status-1")).not.toHaveTextContent("en cola en la extensión");
  });

  it("caps how many searches ride along (B3): drops the tail, never queues or records a dropped task", async () => {
    const N = MAX_QUEUE_ENTRIES + 6; // comfortably over the cap
    const tasks = Array.from({ length: N }, (_, i) =>
      mkTask(`t${i}`, "idealista", `https://www.idealista.com/venta-viviendas/x${i}/`),
    );
    const connector = mkConnector(
      "idealista",
      tasks.map((t) => mkTaskView(t, { muted: false })),
    );
    const profile: ProfileCaptureView = {
      id: 9,
      name: "Grande",
      connectors: [connector],
      totalTasks: N,
      actionableConnectors: 1,
    };

    const fetchSpy = vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({ ok: true }) });
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    const openSpy = vi.spyOn(window, "open").mockReturnValue(FAKE_WINDOW);

    render(<CapturaProfileSection profile={profile} />);
    expect(screen.getByTestId("captura-batch-run-9")).toHaveTextContent(`Capturar ${N} tareas`);
    fireEvent.click(screen.getByTestId("captura-batch-run-9"));

    expect(openSpy).toHaveBeenCalledTimes(1);
    const u = new URL(String(openSpy.mock.calls[0][0]));
    const decoded = JSON.parse(decodeURIComponent(u.hash.slice("#inmo-capture-queue=".length))) as unknown[];
    expect(decoded).toHaveLength(MAX_QUEUE_ENTRIES); // capped, not N-1

    // Only 1 (first) + MAX_QUEUE_ENTRIES (queue) get recorded — never the dropped tail.
    const expectedPosts = 1 + MAX_QUEUE_ENTRIES;
    await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(expectedPosts));
    // Give any stray extra call a chance to show up before asserting the ceiling.
    await new Promise((r) => setTimeout(r, 10));
    expect(fetchSpy).toHaveBeenCalledTimes(expectedPosts);

    const droppedCount = N - expectedPosts;
    await waitFor(() =>
      expect(screen.getByTestId("captura-batch-status-9")).toHaveTextContent(
        `${droppedCount} tareas no caben en esta tanda`,
      ),
    );
  });
});
