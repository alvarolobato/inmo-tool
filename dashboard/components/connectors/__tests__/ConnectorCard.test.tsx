// @vitest-environment jsdom
/**
 * Unit tests for the compact connector row (issue #264) and the single
 * Activar/Desactivar toggle (issue #319 / D-055).
 *
 * Compact row (#264): the load-bearing behaviour is the collapse/expand — the
 * list must be browsable at a glance, so every row renders only its identity +
 * status + a one-line last-run summary until the operator clicks the chevron.
 * The full configuration (scope, filters, run-now, per-run detail) must NOT be
 * in the DOM while collapsed, and must appear on expand and disappear again on
 * a second click. The enable/disable toggle stays a basic action, visible
 * without expanding.
 *
 * Single toggle (#319): the owner collapsed the old two-toggle layout (crawl
 * `enabled` + capture `capture_enabled`) into ONE Activar/Desactivar button
 * per connector. For a normal (crawl) connector it maps to `enabled`; for a
 * capture-only connector (Idealista, Aliseda — no automated crawl) it maps to
 * `capture_enabled`, and NO separate crawl button is rendered. The user sees a
 * single Activo/Desactivado state; "solo captura" is a descriptive badge, not
 * a mode they toggle. These tests prove the mapping per connector type and
 * that no second toggle survives.
 */
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, within, act } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { ConnectorCard } from "../ConnectorCard";
import type { ConnectorView } from "@/lib/connectors-schema";

function makeConnector(overrides: Partial<ConnectorView> = {}): ConnectorView {
  return {
    name: "fotocasa",
    registered: true,
    rate_limit_per_minute: 3,
    discovers_full_inventory: false,
    supports_discovery: true,
    supported_filters: ["rooms"],
    overrideHostSuffix: "fotocasa.es",
    supportsSearchOverride: true,
    hasSearchUrlGrammar: true,
    usingDefaults: false,
    enabled: true,
    capture_enabled: true,
    geography_override: null,
    filters: {},
    scopeSource: "profiles",
    derivedFrom: [
      { profile_id: 1, profile_name: "Madrid centro", center: [40.4168, -3.7038], radius_km: 5 },
    ],
    freshness: {
      kind: "fresh",
      intervalHours: null,
      effectiveIntervalHours: 24,
      lastFreshAt: "2026-08-01T09:05:00.000Z",
      cycleStartedAt: null,
      targetScopeCount: null,
      coveredScopeCount: null,
      stuckAfterHours: 168,
    },
    lastRun: {
      run_id: 10,
      status: "success",
      started_at: "2026-08-01T09:00:00.000Z",
      finished_at: "2026-08-01T09:05:00.000Z",
      discovered_count: 30,
      fetched_count: 12,
      error_count: 0,
      error_msg: null,
    },
    activeSaleListingCount: 0,
    activeRentListingCount: 0,
    ...overrides,
  };
}

// A capture-only connector (Idealista/Aliseda): no discover(), crawl off,
// capture on — the exact shape #263 exists for.
function captureOnly(overrides: Partial<ConnectorView> = {}): ConnectorView {
  return makeConnector({
    name: "idealista",
    rate_limit_per_minute: 20,
    supports_discovery: false,
    supported_filters: [],
    overrideHostSuffix: null,
    supportsSearchOverride: false,
    hasSearchUrlGrammar: false,
    enabled: false,
    capture_enabled: true,
    scopeSource: "capture-only",
    derivedFrom: [],
    lastRun: null,
    ...overrides,
  });
}

const noop = vi.fn(async () => {});

describe("ConnectorCard — compact collapse/expand", () => {
  it("renders collapsed by default: identity + status visible, detail hidden", () => {
    render(<ConnectorCard connector={makeConnector()} onPatch={noop} />);

    // Identity band is always visible.
    expect(screen.getByTestId("connector-fotocasa")).toBeInTheDocument();
    expect(screen.getByTestId("status-fotocasa")).toHaveTextContent("activo");
    expect(screen.getByTestId("expand-fotocasa")).toHaveAttribute("aria-expanded", "false");

    // The full detail region and its contents are NOT mounted while collapsed.
    expect(screen.queryByTestId("connector-detail-fotocasa")).not.toBeInTheDocument();
    expect(screen.queryByTestId("scope-summary")).not.toBeInTheDocument();
    expect(screen.queryByTestId("rooms-fotocasa")).not.toBeInTheDocument();
    expect(screen.queryByTestId("lastrun-fotocasa")).not.toBeInTheDocument();
  });

  it("shows a one-line last-run summary in the collapsed row", () => {
    render(<ConnectorCard connector={makeConnector()} onPatch={noop} />);
    const summary = screen.getByTestId("lastrun-summary-fotocasa");
    expect(summary).toHaveTextContent("success");
    expect(summary).toHaveTextContent("12 descargados");
  });

  it("summarises a never-run connector without crashing", () => {
    render(<ConnectorCard connector={makeConnector({ lastRun: null })} onPatch={noop} />);
    expect(screen.getByTestId("lastrun-summary-fotocasa")).toHaveTextContent("Sin ejecuciones");
  });

  it("expands on click to reveal full detail, then collapses again", () => {
    render(<ConnectorCard connector={makeConnector()} onPatch={noop} />);
    const toggle = screen.getByTestId("expand-fotocasa");

    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    const detail = screen.getByTestId("connector-detail-fotocasa");
    expect(within(detail).getByTestId("scope-summary")).toBeInTheDocument();
    // Detail-only controls now present.
    expect(screen.getByTestId("rooms-fotocasa")).toBeInTheDocument();
    expect(screen.getByTestId("lastrun-fotocasa")).toBeInTheDocument();

    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByTestId("connector-detail-fotocasa")).not.toBeInTheDocument();
  });

  it("keeps enable/disable a basic action available without expanding", () => {
    const onPatch = vi.fn(async () => {});
    render(<ConnectorCard connector={makeConnector({ enabled: true })} onPatch={onPatch} />);

    // Toggle lives in the collapsed row (not behind the chevron).
    expect(screen.queryByTestId("connector-detail-fotocasa")).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId("toggle-fotocasa"));

    expect(onPatch).toHaveBeenCalledWith("fotocasa", { enabled: false });
  });
});

describe("ConnectorCard — single toggle (issue #319 / D-055)", () => {
  it("a capture-only connector shows ONE toggle mapped to capture_enabled, and no crawl button", () => {
    render(<ConnectorCard connector={captureOnly()} onPatch={vi.fn()} />);

    // Exactly one Activar/Desactivar toggle, usable without expanding.
    expect(screen.queryByTestId("connector-detail-idealista")).not.toBeInTheDocument();
    expect(screen.getByTestId("toggle-idealista")).toHaveTextContent("Desactivar");

    // The old second controls (crawl toggle / capture toggle / capture pill)
    // must be gone — the whole point of #319 is a single lever.
    expect(screen.queryByTestId("capture-toggle-idealista")).not.toBeInTheDocument();
    expect(screen.queryByTestId("capture-status-idealista")).not.toBeInTheDocument();

    // Status reads from capture_enabled (active here) and "solo captura" stays
    // a descriptive badge.
    expect(screen.getByTestId("status-idealista")).toHaveTextContent("activo");
    expect(screen.getByText("solo captura")).toBeInTheDocument();
  });

  it("the capture-only toggle PATCHes capture_enabled, never enabled", async () => {
    const onPatch = vi.fn().mockResolvedValue(undefined);
    render(<ConnectorCard connector={captureOnly()} onPatch={onPatch} />);

    await act(async () => {
      fireEvent.click(screen.getByTestId("toggle-idealista"));
    });

    expect(onPatch).toHaveBeenCalledTimes(1);
    expect(onPatch).toHaveBeenCalledWith("idealista", { capture_enabled: false });
  });

  it("a disabled capture-only connector reads as 'desactivado' and re-enables via capture_enabled", async () => {
    const onPatch = vi.fn().mockResolvedValue(undefined);
    render(<ConnectorCard connector={captureOnly({ capture_enabled: false })} onPatch={onPatch} />);

    expect(screen.getByTestId("status-idealista")).toHaveTextContent("desactivado");
    const toggle = screen.getByTestId("toggle-idealista");
    expect(toggle).toHaveTextContent("Activar");

    await act(async () => {
      fireEvent.click(toggle);
    });
    expect(onPatch).toHaveBeenCalledWith("idealista", { capture_enabled: true });
  });

  it("a normal connector's toggle maps to enabled, never capture_enabled", () => {
    const onPatch = vi.fn(async () => {});
    render(<ConnectorCard connector={makeConnector({ enabled: true })} onPatch={onPatch} />);

    fireEvent.click(screen.getByTestId("toggle-fotocasa"));
    expect(onPatch).toHaveBeenCalledWith("fotocasa", { enabled: false });
    // No capture controls on a discovery connector.
    expect(screen.queryByTestId("capture-toggle-fotocasa")).not.toBeInTheDocument();
    expect(screen.queryByTestId("capture-status-fotocasa")).not.toBeInTheDocument();
  });

  it("disables the single toggle for a deregistered connector", () => {
    render(<ConnectorCard connector={captureOnly({ registered: false })} onPatch={vi.fn()} />);
    expect(screen.getByTestId("toggle-idealista")).toBeDisabled();
  });

  it("describes 'solo captura' in the expanded detail, not a two-toggle explanation", () => {
    render(<ConnectorCard connector={captureOnly()} onPatch={vi.fn()} />);

    // The note lives behind the chevron, not in the narrow collapsed row.
    expect(screen.queryByTestId("capture-note-idealista")).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId("expand-idealista"));
    expect(screen.getByTestId("capture-note-idealista")).toHaveTextContent("extensión");
  });
});

describe("ConnectorCard — freshness cadence (issue #295 / D-050)", () => {
  it("shows the freshness state and interval control in the expanded detail", () => {
    render(<ConnectorCard connector={makeConnector()} onPatch={noop} />);
    // Freshness lives behind the chevron, like the rest of the detail.
    expect(screen.queryByTestId("freshness-fotocasa")).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId("expand-fotocasa"));
    expect(screen.getByTestId("freshness-state-fotocasa")).toHaveTextContent("fresco");
    expect(screen.getByTestId("freshness-interval-fotocasa")).toBeInTheDocument();
  });

  it("renders each cadence state distinctly", () => {
    const refreshing = makeConnector({
      freshness: {
        kind: "refreshing",
        intervalHours: null,
        effectiveIntervalHours: 24,
        lastFreshAt: null,
        cycleStartedAt: new Date().toISOString(),
        targetScopeCount: 4,
        coveredScopeCount: 1,
        stuckAfterHours: 168,
      },
    });
    const { rerender } = render(<ConnectorCard connector={refreshing} onPatch={noop} />);
    fireEvent.click(screen.getByTestId("expand-fotocasa"));
    expect(screen.getByTestId("freshness-state-fotocasa")).toHaveTextContent(
      "refrescando… (1/4 ámbitos)",
    );

    const stuck = makeConnector({
      freshness: { ...refreshing.freshness, kind: "stuck" },
    });
    rerender(<ConnectorCard connector={stuck} onPatch={noop} />);
    expect(screen.getByTestId("freshness-state-fotocasa")).toHaveTextContent(
      "atascado — lleva más de 168h",
    );

    const due = makeConnector({
      freshness: { ...refreshing.freshness, kind: "due", cycleStartedAt: null },
    });
    rerender(<ConnectorCard connector={due} onPatch={noop} />);
    expect(screen.getByTestId("freshness-state-fotocasa")).toHaveTextContent(
      "obsoleto, sin ciclo iniciado",
    );
  });

  it("changing the interval PATCHes freshness_interval_hours (null = default)", () => {
    const onPatch = vi.fn(async () => {});
    render(<ConnectorCard connector={makeConnector()} onPatch={onPatch} />);
    fireEvent.click(screen.getByTestId("expand-fotocasa"));

    fireEvent.change(screen.getByTestId("freshness-interval-fotocasa"), {
      target: { value: "6" },
    });
    expect(onPatch).toHaveBeenCalledWith("fotocasa", { freshness_interval_hours: 6 });

    fireEvent.change(screen.getByTestId("freshness-interval-fotocasa"), {
      target: { value: "" },
    });
    expect(onPatch).toHaveBeenCalledWith("fotocasa", { freshness_interval_hours: null });
  });

  it("offers the freshness control on capture-only connectors too", () => {
    // Unlike scope/filters, the cadence is a valid knob for capture-only
    // portals (it's #289's manual-capture staleness window).
    render(<ConnectorCard connector={captureOnly()} onPatch={noop} />);
    fireEvent.click(screen.getByTestId("expand-idealista"));
    expect(screen.getByTestId("freshness-interval-idealista")).toBeInTheDocument();
    // …but still no scope/filter controls.
    expect(screen.queryByTestId("edit-scope-idealista")).not.toBeInTheDocument();
  });
});

describe("ConnectorCard — capability badges (issue #513)", () => {
  it("shows grammar / preview / pin badges for a tunable HTTP connector", () => {
    render(<ConnectorCard connector={makeConnector()} onPatch={noop} />);
    const strip = screen.getByTestId("capabilities-fotocasa");
    const caps = within(strip)
      .getAllByTestId("capability-badge")
      .map((b) => b.getAttribute("data-capability"));
    expect(caps).toContain("grammar");
    expect(caps).toContain("preview");
    expect(caps).toContain("pin");
    // A tunable connector is NOT "filtrado por datos".
    expect(caps).not.toContain("data-filter");
  });

  it("shows 'filtrado por datos' (not pin) for a structural connector", () => {
    // cimenta2-style: discovers, has no pinnable URL, no grammar.
    render(
      <ConnectorCard
        connector={makeConnector({
          name: "cimenta2",
          overrideHostSuffix: null,
          supportsSearchOverride: false,
          hasSearchUrlGrammar: false,
        })}
        onPatch={noop}
      />,
    );
    const caps = within(screen.getByTestId("capabilities-cimenta2"))
      .getAllByTestId("capability-badge")
      .map((b) => b.getAttribute("data-capability"));
    expect(caps).toContain("data-filter");
    expect(caps).toContain("preview");
    expect(caps).not.toContain("pin");
    expect(caps).not.toContain("grammar");
  });

  it("shows 'captura extensión' for a capture-only connector", () => {
    render(<ConnectorCard connector={captureOnly()} onPatch={noop} />);
    const caps = within(screen.getByTestId("capabilities-idealista"))
      .getAllByTestId("capability-badge")
      .map((b) => b.getAttribute("data-capability"));
    expect(caps).toContain("harvest");
    expect(caps).not.toContain("preview");
    expect(caps).not.toContain("data-filter");
  });
});
