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
    reference_code: null,
    first_seen_at: "2026-07-01T00:00:00.000Z",
    last_seen_at: "2026-07-20T00:00:00.000Z",
    operation: "sale",
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

  // Listing staleness (#243). `daysAgo` builds an ISO relative to the real
  // `now` the badge reads, so band assertions stay stable over time.
  const daysAgo = (n: number) => new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString();

  it("#243: shows the freshest active listing's staleness age", () => {
    render(
      <PropertyHeader
        property={property({ listings: [listing({ last_seen_at: daysAgo(2) })] })}
      />,
    );
    const badge = screen.getByTestId("property-staleness");
    expect(badge).toHaveTextContent("visto hace 2 días");
    expect(badge).toHaveAttribute("data-staleness-band", "fresh");
  });

  it("#243: reflects the FRESHEST of a deduplicated property's active listings, not the oldest (mutation guard for freshest-of-linked)", () => {
    // One active listing was last confirmed 30 days ago (stale in isolation),
    // the other only 2 days ago. The property is NOT stale — a MIN/oldest
    // implementation would wrongly show the 30-day band. This is the exact
    // freshest-of-linked rule issue #243 calls out.
    render(
      <PropertyHeader
        property={property({
          listings: [
            listing({ id: 1, source: "fotocasa", status: "active", last_seen_at: daysAgo(30) }),
            listing({ id: 2, source: "milanuncios", status: "active", last_seen_at: daysAgo(2) }),
          ],
        })}
      />,
    );
    const badge = screen.getByTestId("property-staleness");
    expect(badge).toHaveAttribute("data-staleness-band", "fresh");
    expect(badge).toHaveTextContent("visto hace 2 días");
  });

  it("#243: ignores a withdrawn listing's timestamp — a withdrawn sibling never rescues nor is confirmed", () => {
    // Withdrawn listing seen 1 day ago must NOT make the property look fresh;
    // only the active listing (30 days) drives the age.
    render(
      <PropertyHeader
        property={property({
          listings: [
            listing({ id: 1, source: "fotocasa", status: "active", last_seen_at: daysAgo(30) }),
            listing({ id: 2, source: "milanuncios", status: "withdrawn", last_seen_at: daysAgo(1) }),
          ],
        })}
      />,
    );
    const badge = screen.getByTestId("property-staleness");
    expect(badge).toHaveAttribute("data-staleness-band", "stale");
  });

  it("#243: renders no staleness badge when no listing is active", () => {
    render(
      <PropertyHeader
        property={property({
          listings: [
            listing({ id: 1, status: "sold", last_seen_at: daysAgo(3) }),
            listing({ id: 2, status: "withdrawn", last_seen_at: daysAgo(3) }),
          ],
        })}
      />,
    );
    expect(screen.queryByTestId("property-staleness")).not.toBeInTheDocument();
  });
});
