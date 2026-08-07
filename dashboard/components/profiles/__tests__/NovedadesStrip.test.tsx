// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { NovedadesStrip } from "../NovedadesStrip";
import type { ProfileOverviewEntry, ProfileOverviewMetrics } from "@/lib/profile-overview-types";
import type { SearchProfileRow } from "@/lib/profiles-schema";

function profile(id: number): SearchProfileRow {
  return {
    id,
    name: `Perfil ${id}`,
    scope: {
      geography: { type: "radius", center: [40.4168, -3.7038], radius_km: 5 },
      property_types: ["piso"],
      hard_exclusions: {},
    },
    thesis_params: {},
    archived_at: null,
    created_at: "2026-08-01T00:00:00.000Z",
    last_materialized_at: "2026-08-01T00:00:00.000Z",
    last_viewed_at: null,
  };
}

function metrics(newCount: number): ProfileOverviewMetrics {
  return {
    matched_count: Math.max(newCount, 1),
    new_count: newCount,
    accepted_count: 0,
    rejected_count: 0,
    min_price: null,
    median_price: null,
    max_price: null,
    cold_start_count: 0,
    trained_count: 0,
    training_example_count: null,
    model_trained: false,
    gross_yield_median_pct: null,
    flagged_count: 0,
    thumbnails: [],
  };
}

function ok(id: number, newCount: number): ProfileOverviewEntry {
  return { ok: true, profile: profile(id), metrics: metrics(newCount) };
}

const noop = () => {};

describe("NovedadesStrip (issue #195)", () => {
  it("summarizes new candidates across profiles with pluralized copy", () => {
    render(<NovedadesStrip overviews={[ok(1, 3), ok(2, 9)]} onJumpToProfile={noop} />);
    const strip = screen.getByTestId("novedades-strip");
    expect(strip).toHaveTextContent("2 perfiles con candidatos nuevos");
    expect(strip).toHaveTextContent("12 nuevos en total");
    expect(strip).toHaveAttribute("data-total-new", "12");
    expect(strip).toHaveAttribute("data-profiles-with-new", "2");
  });

  it("uses singular copy for one profile / one new candidate", () => {
    render(<NovedadesStrip overviews={[ok(5, 1)]} onJumpToProfile={noop} />);
    const strip = screen.getByTestId("novedades-strip");
    expect(strip).toHaveTextContent("1 perfil con candidatos nuevos");
    expect(strip).toHaveTextContent("1 nuevo en total");
  });

  it("jumps to the busiest profile (most new candidates) on click", () => {
    const onJump = vi.fn();
    render(<NovedadesStrip overviews={[ok(1, 2), ok(2, 8)]} onJumpToProfile={onJump} />);
    fireEvent.click(screen.getByTestId("novedades-strip"));
    expect(onJump).toHaveBeenCalledWith(2);
  });

  it("renders a quiet empty state (not the clickable strip) when nothing is new", () => {
    render(<NovedadesStrip overviews={[ok(1, 0)]} onJumpToProfile={noop} />);
    expect(screen.queryByTestId("novedades-strip")).not.toBeInTheDocument();
    expect(screen.getByTestId("novedades-strip-empty")).toHaveTextContent("Sin novedades");
  });

  it("renders nothing in the degraded fallback (overviews null)", () => {
    const { container } = render(<NovedadesStrip overviews={null} onJumpToProfile={noop} />);
    expect(container).toBeEmptyDOMElement();
  });
});
