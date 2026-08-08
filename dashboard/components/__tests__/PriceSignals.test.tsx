// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { PriceSignals } from "../property/PriceSignals";

/**
 * Unit coverage for PriceSignals (#448 F): the below-market RATING is green
 * when below market / red when above, the BAJADA/SUBIDA direction shows only
 * when a move is badge-worthy, and the whole thing renders nothing when there
 * is no signal at all (the "no badge on every card" rule).
 */
describe("PriceSignals", () => {
  it("renders a GREEN 'bajo mercado' rating when the property is below market", () => {
    render(
      <PriceSignals
        belowMarketPct={0.2}
        priceChanged={false}
        priceDirection={null}
        priceDeltaPct={null}
      />,
    );
    const rating = screen.getByTestId("price-rating");
    expect(rating).toHaveAttribute("data-rating", "below");
    expect(rating).toHaveTextContent(/20% bajo mercado/);
  });

  it("renders a RED 'sobre mercado' rating when the property is above market", () => {
    render(
      <PriceSignals
        belowMarketPct={-0.12}
        priceChanged={false}
        priceDirection={null}
        priceDeltaPct={null}
      />,
    );
    const rating = screen.getByTestId("price-rating");
    expect(rating).toHaveAttribute("data-rating", "above");
    expect(rating).toHaveTextContent(/12% sobre mercado/);
  });

  it("shows a BAJADA direction chip only when a move is badge-worthy", () => {
    render(
      <PriceSignals
        belowMarketPct={null}
        priceChanged
        priceDirection="drop"
        priceDeltaPct={-0.05}
      />,
    );
    const dir = screen.getByTestId("price-direction");
    expect(dir).toHaveAttribute("data-direction", "drop");
    expect(dir).toHaveTextContent(/BAJADA/);
  });

  it("does NOT show a direction chip when the move is not badge-worthy", () => {
    render(
      <PriceSignals
        belowMarketPct={0.3}
        priceChanged={false}
        priceDirection={null}
        priceDeltaPct={-0.0005}
      />,
    );
    expect(screen.queryByTestId("price-direction")).toBeNull();
    // ...but the rating still renders.
    expect(screen.getByTestId("price-rating")).toBeInTheDocument();
  });

  it("renders nothing when there is no signal at all", () => {
    const { container } = render(
      <PriceSignals
        belowMarketPct={null}
        priceChanged={false}
        priceDirection={null}
        priceDeltaPct={null}
      />,
    );
    expect(container).toBeEmptyDOMElement();
  });
});
