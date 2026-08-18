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

/**
 * Unit coverage for the "Capturar todo" batch button (issue #556):
 * default tick state (due → ticked, muted → unticked), select-all/none, the
 * live count in the button label, the nothing-ticked no-op, and — the
 * bug-prone part — that a multi-task click opens exactly ONE tab (never N)
 * whose URL carries both the auto-start signal AND the rest of the ticked
 * tasks as the `inmo-capture-queue` param.
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

  it("multi-task click opens exactly ONE tab, carrying the signal + the rest as the queue param, and records a run for every ticked task", async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ ok: true }),
    });
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    const openSpy = vi.spyOn(window, "open").mockReturnValue(null);

    render(<CapturaProfileSection profile={buildProfile()} />);
    // Default tick state: idea-1 + idea-2 ticked (due), ali-1 unticked (muted).
    fireEvent.click(screen.getByTestId("captura-batch-run-1"));

    await waitFor(() => expect(openSpy).toHaveBeenCalledTimes(1));
    const openedUrl = String(openSpy.mock.calls[0][0]);
    const u = new URL(openedUrl);
    // Opens the FIRST ticked task's captureUrl (display order), never a 2nd tab.
    expect(u.origin + u.pathname).toBe("https://www.idealista.com/venta-viviendas/madrid/piso/");
    expect(u.hash).toBe("#inmo-capture");
    const queueParam = u.searchParams.get("inmo-capture-queue");
    expect(queueParam).toBeTruthy();
    expect(JSON.parse(queueParam!)).toEqual([["idealista", IDEA_DUE_2.captureUrl]]);

    // Records capture_task_run for BOTH ticked tasks (never the untouched muted one).
    await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(2));
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

    await waitFor(() =>
      expect(screen.getByTestId("captura-batch-status-1")).toHaveTextContent("Capturando 2 tareas"),
    );
  });

  it("a single ticked task behaves like the plain single-task flow (no queue param)", async () => {
    const fetchSpy = vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({ ok: true }) });
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    const openSpy = vi.spyOn(window, "open").mockReturnValue(null);

    render(<CapturaProfileSection profile={buildProfile()} />);
    fireEvent.click(screen.getByTestId("captura-task-check-idea-2")); // leave only idea-1 ticked
    fireEvent.click(screen.getByTestId("captura-batch-run-1"));

    await waitFor(() => expect(openSpy).toHaveBeenCalledTimes(1));
    const u = new URL(String(openSpy.mock.calls[0][0]));
    expect(u.searchParams.has("inmo-capture-queue")).toBe(false);
  });
});
