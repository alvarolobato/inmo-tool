// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { ProfileOverviewRow } from "../ProfileOverviewRow";
import type { ProfileOverviewEntry, ProfileOverviewMetrics } from "@/lib/profile-overview-types";
import type { SearchProfileRow } from "@/lib/profiles-schema";

function profile(overrides: Partial<SearchProfileRow> = {}): SearchProfileRow {
  return {
    id: 1,
    name: "Piso Sevilla centro",
    scope: {
      geography: { type: "radius", center: [37.3891, -5.9845], radius_km: 5 },
      property_types: ["piso"],
      hard_exclusions: {},
    },
    thesis_params: {},
    archived_at: null,
    created_at: "2026-08-01T00:00:00.000Z",
    last_materialized_at: "2026-08-01T00:00:00.000Z",
    last_viewed_at: null,
    ...overrides,
  };
}

function metrics(overrides: Partial<ProfileOverviewMetrics> = {}): ProfileOverviewMetrics {
  return {
    matched_count: 24,
    new_count: 3,
    accepted_count: 0,
    rejected_count: 0,
    min_price: 142000,
    median_price: 198000,
    max_price: 310000,
    cold_start_count: 24,
    trained_count: 0,
    training_example_count: 8,
    model_trained: false,
    gross_yield_median_pct: null,
    flagged_count: 0,
    thumbnails: [],
    ...overrides,
  };
}

const noop = () => {};

describe("ProfileOverviewRow (issue #193)", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("renders candidatos/nuevos/precio/estado del modelo metrics from the entry, no per-row fetch", () => {
    const entry: ProfileOverviewEntry = { ok: true, profile: profile(), metrics: metrics() };
    render(<ProfileOverviewRow entry={entry} onEdit={noop} onClone={noop} onArchive={noop} busy={false} />);
    expect(screen.getByTestId("profile-metric-matched")).toHaveTextContent("24");
    expect(screen.getByTestId("profile-metric-new")).toHaveTextContent("3");
    expect(screen.getByTestId("profile-metric-price")).toHaveTextContent("142.000");
    expect(screen.getByTestId("profile-metric-price")).toHaveTextContent("310.000");
    expect(screen.getByTestId("profile-metric-price")).toHaveTextContent("198.000");
    expect(screen.getByTestId("profile-metric-model")).toHaveTextContent("cold-start");
    expect(screen.getByTestId("profile-metric-model")).toHaveTextContent("8/32");
  });

  it("never renders a yield chip when gross_yield_median_pct is null (no fabricated 0%)", () => {
    const entry: ProfileOverviewEntry = {
      ok: true,
      profile: profile(),
      metrics: metrics({ gross_yield_median_pct: null }),
    };
    render(<ProfileOverviewRow entry={entry} onEdit={noop} onClone={noop} onArchive={noop} busy={false} />);
    expect(screen.queryByTestId("profile-metric-yield")).not.toBeInTheDocument();
    // Belt-and-suspenders: "0,0 %" and "0%" must never appear anywhere in the row.
    expect(screen.queryByText(/0,0\s*%/)).not.toBeInTheDocument();
  });

  it("renders the yield chip, labelled bruto/estimado, when gross_yield_median_pct is set", () => {
    const entry: ProfileOverviewEntry = {
      ok: true,
      profile: profile(),
      metrics: metrics({ gross_yield_median_pct: 5.13 }),
    };
    render(<ProfileOverviewRow entry={entry} onEdit={noop} onClone={noop} onArchive={noop} busy={false} />);
    const chip = screen.getByTestId("profile-metric-yield");
    expect(chip).toHaveTextContent("5,1");
    expect(chip).toHaveTextContent("bruto");
    expect(chip).toHaveTextContent("estimado");
  });

  it("never renders an alertas chip when flagged_count is 0", () => {
    const entry: ProfileOverviewEntry = { ok: true, profile: profile(), metrics: metrics({ flagged_count: 0 }) };
    render(<ProfileOverviewRow entry={entry} onEdit={noop} onClone={noop} onArchive={noop} busy={false} />);
    expect(screen.queryByTestId("profile-metric-flags")).not.toBeInTheDocument();
  });

  it("renders the alertas chip when flagged_count > 0, as a link to the ?alerts=1 filtered feed (#467)", () => {
    const entry: ProfileOverviewEntry = {
      ok: true,
      profile: profile({ id: 13 }),
      metrics: metrics({ flagged_count: 2 }),
    };
    render(<ProfileOverviewRow entry={entry} onEdit={noop} onClone={noop} onArchive={noop} busy={false} />);
    const flags = screen.getByTestId("profile-metric-flags");
    expect(flags).toHaveTextContent("2");
    // #467: the count is clickable and lands on the profile's feed with the
    // "Con alertas" filter already active (F2 URL-state reads ?alerts=1).
    expect(flags.tagName).toBe("A");
    expect(flags).toHaveAttribute("href", "/profiles/13?alerts=1");
  });

  it("omits the price chip entirely when no matched property has a priced active listing (absence, not 0 EUR)", () => {
    const entry: ProfileOverviewEntry = {
      ok: true,
      profile: profile(),
      metrics: metrics({ min_price: null, median_price: null, max_price: null }),
    };
    render(<ProfileOverviewRow entry={entry} onEdit={noop} onClone={noop} onArchive={noop} busy={false} />);
    expect(screen.queryByTestId("profile-metric-price")).not.toBeInTheDocument();
  });

  it("shows a '¿Por qué 0?' toggle only when matched_count is 0, and it expands the shared diagnostic", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, json: async () => ({ kind: "never_materialized" }) }),
    );
    const entry: ProfileOverviewEntry = { ok: true, profile: profile(), metrics: metrics({ matched_count: 0 }) };
    render(<ProfileOverviewRow entry={entry} onEdit={noop} onClone={noop} onArchive={noop} busy={false} />);
    const toggle = screen.getByTestId("profile-zero-why-link");
    expect(screen.queryByTestId("zero-diagnostic-loading")).not.toBeInTheDocument();
    fireEvent.click(toggle);
    expect(await screen.findByTestId("zero-diagnostic")).toBeInTheDocument();
  });

  it("does not show '¿Por qué 0?' when matched_count > 0", () => {
    const entry: ProfileOverviewEntry = { ok: true, profile: profile(), metrics: metrics({ matched_count: 5 }) };
    render(<ProfileOverviewRow entry={entry} onEdit={noop} onClone={noop} onArchive={noop} busy={false} />);
    expect(screen.queryByTestId("profile-zero-why-link")).not.toBeInTheDocument();
  });

  it("exposes a stable row anchor id and reflects the highlighted prop (issue #195 novedades jump-to)", () => {
    const entry: ProfileOverviewEntry = { ok: true, profile: profile({ id: 7 }), metrics: metrics() };
    const { rerender } = render(
      <ProfileOverviewRow entry={entry} onEdit={noop} onClone={noop} onArchive={noop} busy={false} />,
    );
    const row = screen.getByTestId("profile-row");
    expect(row).toHaveAttribute("id", "profile-row-7");
    expect(row).not.toHaveAttribute("data-highlighted");

    rerender(
      <ProfileOverviewRow entry={entry} onEdit={noop} onClone={noop} onArchive={noop} busy={false} highlighted />,
    );
    expect(screen.getByTestId("profile-row")).toHaveAttribute("data-highlighted", "true");
  });

  it("renders 4 thumbnail slots, real photos where present and placeholders where absent — never an empty gap", () => {
    const entry: ProfileOverviewEntry = {
      ok: true,
      profile: profile(),
      metrics: metrics({
        thumbnails: [
          { property_id: 1, photo_url: "https://img.example/1.jpg" },
          { property_id: 2, photo_url: null },
        ],
      }),
    };
    render(<ProfileOverviewRow entry={entry} onEdit={noop} onClone={noop} onArchive={noop} busy={false} />);
    const container = screen.getByTestId("profile-thumbnails");
    expect(container.children).toHaveLength(4);
    expect(screen.getAllByTestId("profile-thumb-img")).toHaveLength(1);
    expect(screen.getAllByTestId("profile-thumb-placeholder")).toHaveLength(3);
  });

  it("Entrar button navigates to /profiles/[id]", () => {
    const entry: ProfileOverviewEntry = { ok: true, profile: profile({ id: 42 }), metrics: metrics() };
    render(<ProfileOverviewRow entry={entry} onEdit={noop} onClone={noop} onArchive={noop} busy={false} />);
    expect(screen.getByTestId("profile-enter-button")).toHaveAttribute("href", "/profiles/42");
    expect(screen.getByTestId("profile-row-link")).toHaveAttribute("href", "/profiles/42");
  });

  it("malformed-scope (ok: false) row renders visibly broken: name, red badge, issues — never absent from the DOM", () => {
    const entry: ProfileOverviewEntry = {
      ok: false,
      id: 99,
      name: "Perfil roto",
      issues: ["scope.geography: Required"],
    };
    render(<ProfileOverviewRow entry={entry} onEdit={noop} onClone={noop} onArchive={noop} busy={false} />);
    expect(screen.getByTestId("profile-row-broken")).toBeInTheDocument();
    expect(screen.getByText("Perfil roto")).toBeInTheDocument();
    expect(screen.getByTestId("profile-invalid-badge")).toHaveTextContent("Configuración inválida");
    expect(screen.getByText("scope.geography: Required")).toBeInTheDocument();
    // No Entrar button, no thumbnails, no metrics for a row with no
    // parseable scope to compute any of that from.
    expect(screen.queryByTestId("profile-enter-button")).not.toBeInTheDocument();
    expect(screen.queryByTestId("profile-metric-matched")).not.toBeInTheDocument();
  });

  it("malformed-scope row disables Clonar in the overflow menu, with a reason", () => {
    const entry: ProfileOverviewEntry = { ok: false, id: 99, name: "Perfil roto", issues: [] };
    render(<ProfileOverviewRow entry={entry} onEdit={noop} onClone={noop} onArchive={noop} busy={false} />);
    fireEvent.click(screen.getByRole("button", { name: "Más acciones para este perfil" }));
    const cloneItem = screen.getByRole("menuitem", { name: "Clonar" });
    expect(cloneItem).toBeDisabled();
  });

  it("kebab menu is keyboard-reachable and labelled for screen readers", () => {
    const entry: ProfileOverviewEntry = { ok: true, profile: profile(), metrics: metrics() };
    render(<ProfileOverviewRow entry={entry} onEdit={noop} onClone={noop} onArchive={noop} busy={false} />);
    const button = screen.getByRole("button", { name: "Más acciones para este perfil" });
    expect(button).toHaveAttribute("aria-label", "Más acciones para este perfil");
    // Real, focusable <button> — not a div/span with an onClick, which would
    // be invisible to keyboard/screen-reader users (the regression class
    // this project has already hit once on a card control).
    expect(button.tagName).toBe("BUTTON");
  });

  it("Editar/Clonar/Archivar are reachable only via the overflow menu, not as top-level buttons sharing the row's visual weight", () => {
    const entry: ProfileOverviewEntry = { ok: true, profile: profile(), metrics: metrics() };
    render(<ProfileOverviewRow entry={entry} onEdit={noop} onClone={noop} onArchive={noop} busy={false} />);
    // Before opening the menu, none of these labels should be visible as
    // standalone top-level controls.
    expect(screen.queryByText("Editar")).not.toBeInTheDocument();
    expect(screen.queryByText("Clonar")).not.toBeInTheDocument();
    expect(screen.queryByText("Archivar")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Más acciones para este perfil" }));
    expect(screen.getByRole("menuitem", { name: "Editar" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Clonar" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Archivar" })).toBeInTheDocument();
  });
});
