// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import CapturaPage from "../captura/page";

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

const SEARCH_URLS = {
  profileId: 1,
  name: "Madrid centro",
  urls: [
    { portal: "idealista", url: "https://www.idealista.com/venta-viviendas/madrid/", loosened: [] },
    {
      portal: "aliseda",
      url: "https://www.alisedainmobiliaria.com/venta?precioMax=200000",
      loosened: [{ constraint: "geography", reason: "Aliseda no busca por radio." }],
    },
  ],
};

const WORKLIST = {
  rows: [],
  summaries: [
    { source_portal: "aliseda", total: 10, pending: 4, captured: 5, failed: 1, skipped: 0 },
  ],
};

function mockFetch(opts: { profilesOk?: boolean; urlsOk?: boolean; wlOk?: boolean } = {}) {
  const { profilesOk = true, urlsOk = true, wlOk = true } = opts;
  return vi.fn().mockImplementation((url: string) => {
    if (url === "/api/profiles") {
      return Promise.resolve({
        ok: profilesOk,
        json: () => Promise.resolve(profilesOk ? PROFILES : { error: "boom" }),
      });
    }
    if (url.includes("/search-urls")) {
      return Promise.resolve({
        ok: urlsOk,
        json: () => Promise.resolve(urlsOk ? SEARCH_URLS : { error: "boom" }),
      });
    }
    if (url.startsWith("/api/etl/worklist")) {
      return Promise.resolve({
        ok: wlOk,
        json: () => Promise.resolve(wlOk ? WORKLIST : { error: "boom" }),
      });
    }
    return Promise.resolve({ ok: false, json: () => Promise.resolve({}) });
  });
}

describe("CapturaPage", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("auto-selects the first profile and renders its per-portal cards + open-search links", async () => {
    globalThis.fetch = mockFetch();
    render(<CapturaPage />);

    await waitFor(() => expect(screen.getByTestId("captura-profile-select")).toBeInTheDocument());

    // Both portals render as cards with a pre-filtered open link.
    await waitFor(() => expect(screen.getByTestId("captura-portal-idealista")).toBeInTheDocument());
    expect(screen.getByTestId("captura-portal-aliseda")).toBeInTheDocument();
    expect(screen.getByTestId("captura-open-aliseda")).toHaveAttribute(
      "href",
      "https://www.alisedainmobiliaria.com/venta?precioMax=200000",
    );

    // Aliseda's worklist progress + loosened flag surface.
    expect(screen.getByTestId("captura-captured-aliseda")).toHaveTextContent("5/10 capturadas");
    expect(screen.getByTestId("captura-loosened-aliseda")).toHaveTextContent("búsqueda ampliada");
    // Idealista has no worklist rows → "aún sin lista".
    expect(screen.getByTestId("captura-nolist-idealista")).toBeInTheDocument();

    // Totals strip.
    expect(screen.getByTestId("captura-totals")).toHaveTextContent("5 de 10 capturadas en 2 portales");

    // No error surface.
    expect(screen.queryByText("Detalles técnicos")).not.toBeInTheDocument();
  });

  it("shows an empty state with a link to Perfiles when there are no profiles", async () => {
    globalThis.fetch = mockFetch({ profilesOk: true });
    globalThis.fetch = vi.fn().mockImplementation((url: string) => {
      if (url === "/api/profiles") {
        return Promise.resolve({ ok: true, json: () => Promise.resolve([]) });
      }
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
    await waitFor(() =>
      expect(screen.getByText(/No se pudo cargar el progreso de captura/)).toBeInTheDocument(),
    );
  });

  it("re-fetches progress when 'Actualizar progreso' is clicked", async () => {
    const fetchSpy = mockFetch();
    globalThis.fetch = fetchSpy;
    render(<CapturaPage />);
    await waitFor(() => expect(screen.getByTestId("captura-refresh")).toBeInTheDocument());
    await waitFor(() => expect(screen.getByTestId("captura-portal-aliseda")).toBeInTheDocument());

    const callsBefore = fetchSpy.mock.calls.filter((c) => String(c[0]).startsWith("/api/etl/worklist")).length;
    fireEvent.click(screen.getByTestId("captura-refresh"));
    await waitFor(() => {
      const callsAfter = fetchSpy.mock.calls.filter((c) => String(c[0]).startsWith("/api/etl/worklist")).length;
      expect(callsAfter).toBeGreaterThan(callsBefore);
    });
  });
});
