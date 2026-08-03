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
