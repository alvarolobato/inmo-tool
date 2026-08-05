/**
 * Unit tests for the search-task label helpers (issue #277).
 */

import { describe, it, expect } from "vitest";
import {
  portalDisplayName,
  typesLabel,
  locationLabel,
  priceLabel,
  taskLabel,
} from "@/lib/search-url/labels";

describe("portalDisplayName", () => {
  it("names the known portals and title-cases unknown ones", () => {
    expect(portalDisplayName("idealista")).toBe("Idealista");
    expect(portalDisplayName("aliseda")).toBe("Aliseda");
    expect(portalDisplayName("fotocasa")).toBe("Fotocasa");
    expect(portalDisplayName("")).toBe("");
  });
});

describe("typesLabel", () => {
  it("joins accented Spanish plurals", () => {
    expect(typesLabel(["piso"])).toBe("pisos");
    expect(typesLabel(["piso", "atico"])).toBe("pisos, áticos");
  });
});

describe("locationLabel", () => {
  it("title-cases the first slug token", () => {
    expect(locationLabel("estepona-malaga")).toBe("Estepona");
    expect(locationLabel("andalucia/malaga")).toBe("Andalucia");
  });
  it("labels an empty slug as national", () => {
    expect(locationLabel("")).toBe("toda España");
  });
});

describe("priceLabel", () => {
  it("formats each price-bound shape with es-ES thousands", () => {
    expect(priceLabel(undefined, 200000)).toBe(" ≤200.000 €");
    expect(priceLabel(50000, undefined)).toBe(" ≥50.000 €");
    expect(priceLabel(50000, 200000)).toBe(" 50.000–200.000 €");
    expect(priceLabel(undefined, undefined)).toBe("");
  });
});

describe("taskLabel", () => {
  it("assembles portal — types en location price", () => {
    expect(taskLabel("idealista", ["piso"], "estepona-malaga", undefined, 200000)).toBe(
      "Idealista — pisos en Estepona ≤200.000 €",
    );
  });
});
