// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import {
  PropertyDescription,
  pickDescriptions,
} from "@/components/property/PropertyDescription";
import type { PropertyListingDetail } from "@/lib/property-detail";

function listing(overrides: Partial<PropertyListingDetail> = {}): PropertyListingDetail {
  return {
    id: 1,
    source: "fotocasa",
    url: null,
    listing_kind: null,
    status: "active",
    current_price: 250000,
    operation: "sale",
    reference_code: null,
    first_seen_at: null,
    last_seen_at: null,
    description: null,
    extraction_quality: null,
    ...overrides,
  };
}

describe("pickDescriptions", () => {
  it("returns nothing when no listing has a description", () => {
    expect(pickDescriptions([listing(), listing({ description: "   " })])).toEqual([]);
  });

  it("returns the single longest when only one has text", () => {
    const picked = pickDescriptions([
      listing({ source: "fotocasa", description: "Piso reformado con mucha luz." }),
      listing({ source: "milanuncios", description: "" }),
    ]);
    expect(picked).toHaveLength(1);
    expect(picked[0].text).toBe("Piso reformado con mucha luz.");
  });

  it("collapses a truncated/near-duplicate copy into the longest", () => {
    const long = "Piso reformado con mucha luz natural y tres dormitorios amplios.";
    const short = "Piso reformado con mucha luz"; // substring of `long`
    const picked = pickDescriptions([
      listing({ source: "fotocasa", description: short }),
      listing({ source: "idealista", description: long }),
    ]);
    expect(picked).toHaveLength(1);
    expect(picked[0].text).toBe(long);
  });

  it("keeps materially-different bodies per source, longest first", () => {
    const a = "Amplio piso exterior en Chamberí, listo para entrar a vivir.";
    const b = "Inmueble en construcción; la edificación se encuentra parcialmente ejecutada.";
    const picked = pickDescriptions([
      listing({ source: "fotocasa", description: a }),
      listing({ source: "servihabitat", description: b }),
    ]);
    expect(picked).toHaveLength(2);
    // longest first
    expect(picked[0].text.length).toBeGreaterThanOrEqual(picked[1].text.length);
    expect(picked.map((d) => d.source).sort()).toEqual(["fotocasa", "servihabitat"]);
  });
});

describe("PropertyDescription", () => {
  it("renders nothing when there is no description", () => {
    const { container } = render(<PropertyDescription listings={[listing()]} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("renders a single body without per-source labels", () => {
    render(
      <PropertyDescription
        listings={[listing({ description: "Piso reformado con mucha luz." })]}
      />,
    );
    expect(screen.getByTestId("property-description")).toBeInTheDocument();
    expect(screen.queryByTestId("property-description-source")).not.toBeInTheDocument();
    expect(screen.getByText(/Piso reformado con mucha luz\./)).toBeInTheDocument();
  });

  it("renders per-source blocks when bodies differ materially", () => {
    render(
      <PropertyDescription
        listings={[
          listing({ source: "fotocasa", description: "Amplio piso exterior en Chamberí." }),
          listing({
            source: "servihabitat",
            description: "Inmueble en construcción, parcialmente ejecutado.",
          }),
        ]}
      />,
    );
    const blocks = screen.getAllByTestId("property-description-source");
    expect(blocks).toHaveLength(2);
    const sources = blocks.map((b) => b.getAttribute("data-source")).sort();
    expect(sources).toEqual(["fotocasa", "servihabitat"]);
  });
});
