// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent, within } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import CapturaPage from "../captura/page";
import { fallbackTaskId } from "@/lib/captura-tasks";

// next/link → plain <a> so hrefs are assertable.
vi.mock("next/link", () => ({
  default: ({
    href,
    children,
    style,
  }: {
    href: string;
    children: React.ReactNode;
    style?: React.CSSProperties;
  }) => (
    <a href={href} style={style}>
      {children}
    </a>
  ),
}));

const PROFILES = [
  { id: 1, name: "Madrid centro", scope: {}, thesis_params: {} },
  { id: 2, name: "Costa", scope: {}, thesis_params: {} },
];

// Legacy `urls[]` shape — exercises the normaliser's fallback branch (the page
// must work before the search-url `tasks[]` restructure lands).
const IDEALISTA_URL = "https://www.idealista.com/venta-viviendas/madrid/";
const ALISEDA_URL = "https://www.alisedainmobiliaria.com/venta?precioMax=200000";
const SEARCH_URLS = {
  profileId: 1,
  name: "Madrid centro",
  urls: [
    { portal: "idealista", url: IDEALISTA_URL, loosened: [] },
    {
      portal: "aliseda",
      url: ALISEDA_URL,
      loosened: [{ constraint: "geography", reason: "Aliseda no busca por radio." }],
    },
  ],
};

const ALISEDA_TASK_ID = fallbackTaskId("aliseda", ALISEDA_URL);
const IDEALISTA_TASK_ID = fallbackTaskId("idealista", IDEALISTA_URL);

const WORKLIST = {
  rows: [],
  summaries: [{ source_portal: "aliseda", total: 10, pending: 4, captured: 5, failed: 1, skipped: 0 }],
};

const STALENESS = { defaultDays: 7, byPortal: {} };

// REAL capture activity from extension_capture: idealista has 10 captures even
// though NOTHING seeded its worklist (the owner opened detail pages one by one).
const ACTIVITY = [
  { portal: "idealista", captured: 10, lastCapturedAt: new Date(Date.now() - 3600000).toISOString() },
  { portal: "aliseda", captured: 0, lastCapturedAt: null },
];

function mockFetch(
  opts: {
    profilesOk?: boolean;
    urlsOk?: boolean;
    wlOk?: boolean;
    runsOk?: boolean;
    runs?: Record<string, string>;
    activity?: typeof ACTIVITY;
  } = {},
) {
  const { profilesOk = true, urlsOk = true, wlOk = true, runsOk = true, runs = {}, activity = ACTIVITY } = opts;
  return vi.fn().mockImplementation((url: string, init?: RequestInit) => {
    if (url === "/api/profiles") {
      return Promise.resolve({
        ok: profilesOk,
        json: () => Promise.resolve(profilesOk ? PROFILES : { error: "boom" }),
      });
    }
    if (url.includes("/search-urls")) {
      return Promise.resolve({ ok: urlsOk, json: () => Promise.resolve(urlsOk ? SEARCH_URLS : { error: "boom" }) });
    }
    if (url.startsWith("/api/etl/worklist")) {
      return Promise.resolve({ ok: wlOk, json: () => Promise.resolve(wlOk ? WORKLIST : { error: "boom" }) });
    }
    if (url.includes("/capture-task-runs")) {
      if (init?.method === "POST") {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ ok: true, taskId: "x", lastRunAt: new Date().toISOString() }),
        });
      }
      return Promise.resolve({
        ok: runsOk,
        json: () =>
          Promise.resolve(runsOk ? { profileId: 1, runs, staleness: STALENESS, activity } : { error: "boom" }),
      });
    }
    return Promise.resolve({ ok: false, json: () => Promise.resolve({}) });
  });
}

describe("CapturaPage (task-driven)", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("auto-selects the first profile and renders its tasks grouped by portal, each with a run button", async () => {
    globalThis.fetch = mockFetch();
    render(<CapturaPage />);

    await waitFor(() => expect(screen.getByTestId("captura-profile-select")).toBeInTheDocument());

    // Both portals render as task groups.
    await waitFor(() => expect(screen.getByTestId("captura-portal-idealista")).toBeInTheDocument());
    expect(screen.getByTestId("captura-portal-aliseda")).toBeInTheDocument();

    // Aliseda task: a run button + loosened flag inline + 'nunca' last-done, active.
    const alisedaRow = screen.getByTestId(`captura-task-${ALISEDA_TASK_ID}`);
    expect(alisedaRow).toHaveAttribute("data-muted", "false");
    expect(within(alisedaRow).getByTestId(`captura-task-run-${ALISEDA_TASK_ID}`)).toHaveTextContent("Abrir búsqueda");
    expect(within(alisedaRow).getByTestId(`captura-task-loosened-${ALISEDA_TASK_ID}`)).toHaveTextContent("ampliada");
    expect(within(alisedaRow).getByTestId(`captura-task-lastdone-${ALISEDA_TASK_ID}`)).toHaveTextContent("nunca");

    // REAL capture activity is the headline: idealista shows 10 captured even
    // though NOTHING seeded its worklist (regression guard for "reads empty
    // while captures are working").
    expect(screen.getByTestId("captura-activity-idealista")).toHaveTextContent("10 propiedades capturadas");
    expect(screen.getByTestId("captura-nolist-idealista")).toBeInTheDocument();
    // Aliseda: worklist roll-up present but no real captures yet.
    expect(screen.getByTestId("captura-captured-aliseda")).toHaveTextContent("5/10");
    expect(screen.getByTestId("captura-activity-aliseda")).toHaveTextContent("sin capturas todavía");

    // Totals strip: 2 tasks, 0 done, and the REAL captured count (10).
    expect(screen.getByTestId("captura-totals")).toHaveTextContent("2 de 2 tareas por hacer en 2 portales");
    expect(screen.getByTestId("captura-totals")).toHaveTextContent("10 propiedades capturadas");

    // No error surface.
    expect(screen.queryByText("Detalles técnicos")).not.toBeInTheDocument();
  });

  it("renders a done task grayed with a 'hecho' last-done when a recent run exists", async () => {
    const recent = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
    globalThis.fetch = mockFetch({ runs: { [ALISEDA_TASK_ID]: recent } });
    render(<CapturaPage />);

    await waitFor(() => expect(screen.getByTestId(`captura-task-${ALISEDA_TASK_ID}`)).toBeInTheDocument());
    const alisedaRow = screen.getByTestId(`captura-task-${ALISEDA_TASK_ID}`);
    // Within the 7-day window → muted + 'hecho' + Repetir button; still enabled.
    expect(alisedaRow).toHaveAttribute("data-muted", "true");
    expect(within(alisedaRow).getByTestId(`captura-task-lastdone-${ALISEDA_TASK_ID}`)).toHaveTextContent("hecho");
    expect(within(alisedaRow).getByTestId(`captura-task-run-${ALISEDA_TASK_ID}`)).toBeEnabled();
    // The other task stays active.
    expect(screen.getByTestId(`captura-task-${IDEALISTA_TASK_ID}`)).toHaveAttribute("data-muted", "false");
  });

  it("records the run and grays the row optimistically when a task button is clicked", async () => {
    const fetchSpy = mockFetch();
    globalThis.fetch = fetchSpy;
    const openSpy = vi.spyOn(window, "open").mockReturnValue(null);
    render(<CapturaPage />);

    await waitFor(() => expect(screen.getByTestId(`captura-task-${ALISEDA_TASK_ID}`)).toBeInTheDocument());
    fireEvent.click(screen.getByTestId(`captura-task-run-${ALISEDA_TASK_ID}`));

    // POSTs the run then opens the URL.
    await waitFor(() =>
      expect(
        fetchSpy.mock.calls.some(
          (c) => String(c[0]).includes("/capture-task-runs") && (c[1] as RequestInit)?.method === "POST",
        ),
      ).toBe(true),
    );
    // Opens the search tagged with the auto-start signal (#inmo-capture, #297)
    // so the extension starts the batch without a popup/banner click.
    await waitFor(() =>
      expect(openSpy).toHaveBeenCalledWith(
        `${ALISEDA_URL}#inmo-capture`,
        "_blank",
        expect.any(String),
      ),
    );
    // Optimistic grey-out.
    await waitFor(() =>
      expect(screen.getByTestId(`captura-task-${ALISEDA_TASK_ID}`)).toHaveAttribute("data-muted", "true"),
    );
  });

  it("shows an empty state with a link to Perfiles when there are no profiles", async () => {
    globalThis.fetch = vi.fn().mockImplementation((url: string) => {
      if (url === "/api/profiles") return Promise.resolve({ ok: true, json: () => Promise.resolve([]) });
      return Promise.resolve({ ok: false, json: () => Promise.resolve({}) });
    });
    render(<CapturaPage />);
    await waitFor(() => expect(screen.getByTestId("captura-no-profiles")).toBeInTheDocument());
    expect(screen.getByTestId("captura-no-profiles")).toHaveTextContent("No hay perfiles");
  });

  it("surfaces an error when the profile list fails to load", async () => {
    globalThis.fetch = mockFetch({ profilesOk: false });
    render(<CapturaPage />);
    await waitFor(() => expect(screen.getByText(/No se pudieron cargar los perfiles/)).toBeInTheDocument());
  });

  it("surfaces an error when the worklist roll-up fails", async () => {
    globalThis.fetch = mockFetch({ wlOk: false });
    render(<CapturaPage />);
    await waitFor(() => expect(screen.getByText(/No se pudo cargar el progreso de captura/)).toBeInTheDocument());
  });

  it("surfaces an error when the task-run history fails", async () => {
    globalThis.fetch = mockFetch({ runsOk: false });
    render(<CapturaPage />);
    await waitFor(() => expect(screen.getByText(/No se pudo cargar el histórico de tareas/)).toBeInTheDocument());
  });

  it("re-fetches when 'Actualizar' is clicked", async () => {
    const fetchSpy = mockFetch();
    globalThis.fetch = fetchSpy;
    render(<CapturaPage />);
    await waitFor(() => expect(screen.getByTestId("captura-refresh")).toBeInTheDocument());
    await waitFor(() => expect(screen.getByTestId("captura-portal-aliseda")).toBeInTheDocument());

    const before = fetchSpy.mock.calls.filter((c) => String(c[0]).startsWith("/api/etl/worklist")).length;
    fireEvent.click(screen.getByTestId("captura-refresh"));
    await waitFor(() => {
      const after = fetchSpy.mock.calls.filter((c) => String(c[0]).startsWith("/api/etl/worklist")).length;
      expect(after).toBeGreaterThan(before);
    });
  });
});
