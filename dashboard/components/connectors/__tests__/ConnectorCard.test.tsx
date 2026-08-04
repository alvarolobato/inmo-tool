// @vitest-environment jsdom
/**
 * Unit tests for the compact connector row (issue #264).
 *
 * The load-bearing behaviour here is the collapse/expand: the list must be
 * browsable at a glance, so every row renders only its identity + status +
 * a one-line last-run summary until the operator clicks the chevron. The
 * full configuration (scope, filters, run-now, per-run detail) must NOT be
 * in the DOM while collapsed, and must appear on expand and disappear again
 * on a second click. The enable/disable toggle stays a basic action, visible
 * without expanding.
 */
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";
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
    usingDefaults: false,
    enabled: true,
    geography_override: null,
    filters: {},
    scopeSource: "profiles",
    derivedFrom: [
      { profile_id: 1, profile_name: "Madrid centro", center: [40.4168, -3.7038], radius_km: 5 },
    ],
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
    ...overrides,
  };
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
