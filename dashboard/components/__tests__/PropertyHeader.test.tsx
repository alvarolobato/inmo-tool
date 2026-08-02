// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { PropertyHeader } from "@/components/property/PropertyHeader";
import type { PropertyDetail, PropertyListingDetail } from "@/lib/property-detail";

function listing(overrides: Partial<PropertyListingDetail> = {}): PropertyListingDetail {
  return {
    id: 1,
    source: "fotocasa",
    url: "https://x",
    listing_kind: "particular",
    status: "active",
    current_price: 285000,
    first_seen_at: "2026-07-01T00:00:00.000Z",
    last_seen_at: "2026-07-20T00:00:00.000Z",
    ...overrides,
  };
}

function property(overrides: Partial<PropertyDetail> = {}): PropertyDetail {
  return {
    id: 1,
    address: "Calle Trafalgar, Chamberí, Madrid",
    lat: 40.4324,
    lon: -3.7025,
    property_type: "piso",
    m2_built: 70,
    m2_useful: 65,
    rooms: 2,
    bathrooms: 1,
    floor: "3º",
    has_elevator: true,
    year_built: 1990,
    energy_rating: "D",
    photo_urls: [],
    listings: [listing()],
    price_history: [],
    status_events: [],
    ...overrides,
  };
}

describe("PropertyHeader", () => {
  it("does not flag disagreement for routine portal-to-portal rounding (<2.5% spread)", () => {
    render(
      <PropertyHeader
        property={property({
          listings: [
            listing({ id: 1, source: "fotocasa", current_price: 250000 }),
            listing({ id: 2, source: "milanuncios", current_price: 249000 }), // 0.4% spread
          ],
        })}
      />,
    );

    expect(screen.getByText("249.000 €")).toBeInTheDocument();
    expect(screen.queryByText(/precios significativamente distintos/i)).not.toBeInTheDocument();
  });

  it("flags a genuine disagreement (>2.5% spread) between active listings", () => {
    render(
      <PropertyHeader
        property={property({
          listings: [
            listing({ id: 1, source: "fotocasa", current_price: 300000 }),
            listing({ id: 2, source: "milanuncios", current_price: 279000 }), // ~7.5% spread
          ],
        })}
      />,
    );

    expect(screen.getByText("279.000 €")).toBeInTheDocument();
    expect(screen.getByText(/precios significativamente distintos/i)).toBeInTheDocument();
  });

  it("falls back to the min price across all listings, labelled as historical, when none are active", () => {
    render(
      <PropertyHeader
        property={property({
          listings: [
            listing({ id: 1, source: "fotocasa", status: "sold", current_price: 310000 }),
            listing({ id: 2, source: "milanuncios", status: "withdrawn", current_price: 305000 }),
          ],
        })}
      />,
    );

    expect(screen.getByText("305.000 €")).toBeInTheDocument();
    expect(screen.getByText(/último precio conocido/i)).toBeInTheDocument();
  });

  it("shows 'Precio no disponible' only when literally no listing has a price", () => {
    render(
      <PropertyHeader
        property={property({ listings: [listing({ current_price: null })] })}
      />,
    );

    expect(screen.getByText("Precio no disponible")).toBeInTheDocument();
  });
});
