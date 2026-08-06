/**
 * Guards issue #39's core invariant: every profile template is a VALID instance
 * of the same Scope / ThesisParams shapes ProfileForm and POST /api/profiles
 * already accept — no new schema, no template that would 400 on save. Parses
 * each template through the real Zod schemas; a drift breaks this test.
 */
import { describe, it, expect } from "vitest";
import { ScopeSchema, ThesisParamsSchema } from "@/lib/profiles-schema";
import {
  PROFILE_TEMPLATES,
  findTemplate,
  templateToFormValues,
} from "@/lib/profile-templates";

describe("profile templates", () => {
  it("ships at least the three seed theses", () => {
    const ids = PROFILE_TEMPLATES.map((t) => t.id);
    expect(ids).toEqual(
      expect.arrayContaining(["buy-to-let", "flip", "commercial"]),
    );
    expect(PROFILE_TEMPLATES.length).toBeGreaterThanOrEqual(3);
  });

  it("has unique ids and non-empty labels/descriptions", () => {
    const ids = PROFILE_TEMPLATES.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const t of PROFILE_TEMPLATES) {
      expect(t.label.trim().length).toBeGreaterThan(0);
      expect(t.description.trim().length).toBeGreaterThan(0);
    }
  });

  for (const t of PROFILE_TEMPLATES) {
    it(`template "${t.id}" defaultScope/defaultThesisParams are valid schema instances`, () => {
      expect(() => ScopeSchema.parse(t.defaultScope)).not.toThrow();
      expect(() =>
        ThesisParamsSchema.parse(t.defaultThesisParams),
      ).not.toThrow();
    });
  }

  it("buy-to-let seeds a sensible target yield the investor can adjust", () => {
    const t = findTemplate("buy-to-let")!;
    expect(t.defaultThesisParams.thesis_type).toBe("rent");
    expect(t.defaultThesisParams.target_yield_pct).toBeGreaterThan(0);
  });

  it("flip is distress-tolerant and flip-typed (no rental-yield target)", () => {
    const t = findTemplate("flip")!;
    expect(t.defaultThesisParams.thesis_type).toBe("flip");
    expect(t.defaultThesisParams.target_yield_pct).toBeUndefined();
  });

  it("commercial targets local comercial", () => {
    const t = findTemplate("commercial")!;
    expect(t.defaultScope.property_types).toContain("local");
  });

  it("findTemplate is null-safe", () => {
    expect(findTemplate(null)).toBeUndefined();
    expect(findTemplate(undefined)).toBeUndefined();
    expect(findTemplate("does-not-exist")).toBeUndefined();
  });

  it("templateToFormValues clones (never mutates the shared registry)", () => {
    const t = findTemplate("buy-to-let")!;
    const values = templateToFormValues(t);
    expect(values.name).toBe(t.label);
    values.scope.property_types.push("chalet");
    (values.thesis_params as { target_yield_pct?: number }).target_yield_pct =
      99;
    // Registry object untouched.
    expect(t.defaultScope.property_types).toEqual(["piso"]);
    expect(t.defaultThesisParams.target_yield_pct).toBe(7);
  });
});
