// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ProfileForm, type ProfileFormValues } from "../ProfileForm";

// LocationPicker renders a Leaflet map, which jsdom can't back — mock it to
// a no-op so this suite can focus on the financing/rent-assumption fields
// without dragging in map/geocoding machinery unrelated to these fixes.
vi.mock("../LocationPicker", () => ({
  LocationPicker: () => <div data-testid="location-picker-stub" />,
}));

function baseValues(): ProfileFormValues {
  return {
    name: "Test profile",
    scope: {
      geography: { type: "radius", center: [40.4168, -3.7038], radius_km: 5 },
      property_types: ["piso"],
      hard_exclusions: {},
    },
    thesis_params: {},
  };
}

async function clickSubmit() {
  fireEvent.click(screen.getByRole("button", { name: /guardar/i }));
  // handleSubmit is async (awaits onSubmit) — flush the microtask queue.
  await new Promise((r) => setTimeout(r, 0));
}

describe("ProfileForm — financing field defaults (Opus review fix)", () => {
  // Opus review: setting ONLY down_payment_pct used to silently inject
  // rate_pct: 3 / term_years: 25 into thesis_params.financing, which then
  // made yield.ts's (old) single `financing_is_default` flag report those
  // untouched values as user-chosen. The fix: financing is no longer an
  // all-or-nothing object — untouched fields stay undefined.
  it("setting only the down-payment field does NOT silently populate rate_pct/term_years", async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    render(<ProfileForm initial={baseValues()} submitLabel="Guardar" onSubmit={onSubmit} />);

    fireEvent.change(screen.getByLabelText(/entrada/i), { target: { value: "30" } });
    await clickSubmit();

    expect(onSubmit).toHaveBeenCalledTimes(1);
    const submitted = onSubmit.mock.calls[0][0] as ProfileFormValues;
    expect(submitted.thesis_params.financing?.down_payment_pct).toBe(30);
    expect(submitted.thesis_params.financing?.rate_pct).toBeUndefined();
    expect(submitted.thesis_params.financing?.term_years).toBeUndefined();
  });

  it("clearing the only set financing field drops the whole financing key (matches rent_assumption's blank convention)", async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    render(<ProfileForm initial={baseValues()} submitLabel="Guardar" onSubmit={onSubmit} />);
    const input = screen.getByLabelText(/entrada/i);
    fireEvent.change(input, { target: { value: "30" } });
    fireEvent.change(input, { target: { value: "" } });
    await clickSubmit();

    const submitted = onSubmit.mock.calls[0][0] as ProfileFormValues;
    expect(submitted.thesis_params.financing).toBeUndefined();
  });
});

describe("ProfileForm — rent assumption input (Opus review fix)", () => {
  // The placeholder used to say "p. ej. 12,5" (comma decimal), but a
  // native <input type="number"> only accepts a period decimal — typing a
  // comma could make Number("12,5") return NaN or silently clear the
  // field. parseFormNumber now tolerates a comma by normalizing it first.
  it("accepts a comma-decimal value (matching what the old placeholder implied) without clearing the assumption", async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    render(<ProfileForm initial={baseValues()} submitLabel="Guardar" onSubmit={onSubmit} />);
    fireEvent.change(screen.getByLabelText(/asunci.n de alquiler/i), { target: { value: "12,5" } });
    await clickSubmit();

    const submitted = onSubmit.mock.calls[0][0] as ProfileFormValues;
    expect(submitted.thesis_params.rent_assumption?.eur_per_m2_month).toBe(12.5);
  });

  it("accepts a period-decimal value (the native number input's own format)", async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    render(<ProfileForm initial={baseValues()} submitLabel="Guardar" onSubmit={onSubmit} />);
    fireEvent.change(screen.getByLabelText(/asunci.n de alquiler/i), { target: { value: "12.5" } });
    await clickSubmit();

    const submitted = onSubmit.mock.calls[0][0] as ProfileFormValues;
    expect(submitted.thesis_params.rent_assumption?.eur_per_m2_month).toBe(12.5);
  });

  it("blanking the field clears the assumption entirely (not a fabricated 0)", async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    const initial = baseValues();
    initial.thesis_params = { rent_assumption: { eur_per_m2_month: 10 } };
    render(<ProfileForm initial={initial} submitLabel="Guardar" onSubmit={onSubmit} />);
    fireEvent.change(screen.getByLabelText(/asunci.n de alquiler/i), { target: { value: "" } });
    await clickSubmit();

    const submitted = onSubmit.mock.calls[0][0] as ProfileFormValues;
    expect(submitted.thesis_params.rent_assumption).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Issue #660 / PR #674 review — the connector picker.
// ---------------------------------------------------------------------------

function connectorFixture(over: Partial<Record<string, unknown>> = {}) {
  return {
    name: "fotocasa",
    registered: true,
    supports_discovery: true,
    enabled: true,
    capture_enabled: true,
    activeSaleListingCount: 100,
    activeRentListingCount: 0,
    ...over,
  };
}

/** Install a `fetch` stub for /api/etl/connectors and return a restore fn. */
function stubConnectorFetch(impl: () => Promise<unknown>) {
  const original = global.fetch;
  global.fetch = vi.fn(impl) as unknown as typeof fetch;
  return () => {
    global.fetch = original;
  };
}

async function flush() {
  await new Promise((r) => setTimeout(r, 0));
}

describe("ProfileForm — connector picker (#674 review H2)", () => {
  it("master toggle stays enabled when the connector roster fetch FAILS, so unticking is recoverable", async () => {
    // The bug: `disabled={connectorList === null && !isAllConnectors}` is
    // inverted. While the roster loads the toggle is enabled; unticking makes
    // `connectors: []`, which flips `isAllConnectors` false, which DISABLES
    // the toggle. With a failed fetch `connectorList` stays null forever, so
    // there are no checkboxes either — the form is stuck in a state that
    // cannot be submitted and cannot be undone without losing it to a reload.
    const restore = stubConnectorFetch(() =>
      Promise.reject(new Error("network down")),
    );
    try {
      const onSubmit = vi.fn().mockResolvedValue(undefined);
      render(
        <ProfileForm
          initial={baseValues()}
          submitLabel="Guardar"
          onSubmit={onSubmit}
        />,
      );
      await flush();

      const toggle = screen.getByTestId(
        "scope-all-connectors-toggle",
      ) as HTMLInputElement;
      expect(toggle).toBeChecked();
      expect(toggle).toBeEnabled();

      // Untick — this is the move that used to trap the form.
      fireEvent.click(toggle);
      await flush();
      expect(toggle).not.toBeChecked();
      // The whole point: still operable with no roster at all.
      expect(toggle).toBeEnabled();

      // And re-ticking genuinely restores "all" — it needs no roster.
      fireEvent.click(toggle);
      await flush();
      expect(toggle).toBeChecked();
      await clickSubmit();
      const submitted = onSubmit.mock.calls[0][0] as ProfileFormValues;
      expect(submitted.scope.connectors).toBe("all");
    } finally {
      restore();
    }
  });

  it("unticking starts from an EMPTY selection, and a round-trip restores what was there", async () => {
    // The old `lastConnectorSelection` initializer had a
    // `: orderedConnectors.map(...)` branch that could only ever evaluate to
    // `[]` (the roster is null on first render; a useState initializer runs
    // once). It was deleted rather than implemented: unticking "Todas las
    // fuentes" is a narrowing gesture, so an empty picker to fill in beats
    // 18 pre-ticked rows to subtract from on a phone.
    const restore = stubConnectorFetch(() =>
      Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve({
            connectors: [
              connectorFixture({
                name: "fotocasa",
                activeSaleListingCount: 300,
              }),
              connectorFixture({ name: "pisos", activeSaleListingCount: 100 }),
            ],
          }),
      }),
    );
    try {
      const onSubmit = vi.fn().mockResolvedValue(undefined);
      render(
        <ProfileForm
          initial={baseValues()}
          submitLabel="Guardar"
          onSubmit={onSubmit}
        />,
      );
      await flush();

      fireEvent.click(screen.getByTestId("scope-all-connectors-toggle"));
      await flush();
      // Nothing pre-ticked.
      expect(
        (
          screen
            .getByTestId("scope-connector-fotocasa")
            .querySelector("input") as HTMLInputElement
        ).checked,
      ).toBe(false);

      // Tick one, round-trip through "all", and get it back.
      fireEvent.click(
        screen.getByTestId("scope-connector-fotocasa").querySelector("input")!,
      );
      await flush();
      fireEvent.click(screen.getByTestId("scope-all-connectors-toggle"));
      await flush();
      fireEvent.click(screen.getByTestId("scope-all-connectors-toggle"));
      await flush();

      await clickSubmit();
      const submitted = onSubmit.mock.calls[0][0] as ProfileFormValues;
      expect(submitted.scope.connectors).toEqual(["fotocasa"]);
    } finally {
      restore();
    }
  });

  it("a rental-only connector is not offered, but IS shown when already selected", async () => {
    // #674 review L3: a `search_profile` is a sale thesis (D-016), so picking
    // a rental-only source yields a permanently-empty profile with nothing
    // explaining why. Hiding it outright would turn an existing selection
    // into invisible state, hence the already-selected escape hatch.
    const restore = stubConnectorFetch(() =>
      Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve({
            connectors: [
              connectorFixture({
                name: "fotocasa",
                activeSaleListingCount: 300,
              }),
              connectorFixture({
                name: "fotocasa_rental",
                activeSaleListingCount: 0,
                activeRentListingCount: 283,
              }),
              // Brand-new sale connector: no listings at all. Must stay
              // offerable — "0 sale" alone would have wrongly binned it.
              connectorFixture({
                name: "brandnew",
                activeSaleListingCount: 0,
                activeRentListingCount: 0,
              }),
            ],
          }),
      }),
    );
    try {
      const initial = baseValues();
      initial.scope.connectors = ["fotocasa"];
      const { unmount } = render(
        <ProfileForm
          initial={initial}
          submitLabel="Guardar"
          onSubmit={vi.fn()}
        />,
      );
      await flush();

      expect(
        screen.getByTestId("scope-connector-fotocasa"),
      ).toBeInTheDocument();
      expect(
        screen.getByTestId("scope-connector-brandnew"),
      ).toBeInTheDocument();
      expect(
        screen.queryByTestId("scope-connector-fotocasa_rental"),
      ).toBeNull();
      unmount();

      const selected = baseValues();
      selected.scope.connectors = ["fotocasa_rental"];
      render(
        <ProfileForm
          initial={selected}
          submitLabel="Guardar"
          onSubmit={vi.fn()}
        />,
      );
      await flush();
      expect(
        screen.getByTestId("scope-connector-fotocasa_rental"),
      ).toBeInTheDocument();
    } finally {
      restore();
    }
  });

  it("a globally-disabled connector's row is actually greyed, not just badged (#674 review L1)", async () => {
    const restore = stubConnectorFetch(() =>
      Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve({
            connectors: [
              connectorFixture({ name: "fotocasa" }),
              connectorFixture({ name: "pisos", enabled: false }),
            ],
          }),
      }),
    );
    try {
      const initial = baseValues();
      initial.scope.connectors = ["fotocasa"];
      render(
        <ProfileForm
          initial={initial}
          submitLabel="Guardar"
          onSubmit={vi.fn()}
        />,
      );
      await flush();

      const on = screen.getByTestId("scope-connector-fotocasa");
      const off = screen.getByTestId("scope-connector-pisos");
      expect(on.style.color).toBe("var(--fg)");
      expect(off.style.color).toBe("var(--fg-muted)");
      expect(Number(off.style.opacity)).toBeLessThan(1);
      // Greyed, never hidden or inert (D-055/D-152).
      expect(off).toBeInTheDocument();
      expect(off.querySelector("input")).toBeEnabled();
    } finally {
      restore();
    }
  });
});
