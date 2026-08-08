// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { PriceSignals } from "../property/PriceSignals";

/**
 * Unit coverage for PriceSignals (#448 F, redesigned #460): the below-market
 * RATING is green when below market / red when above and shows the SIGNED % with
 * a 🏷 glyph and NO "bajo/sobre mercado" words (#460, compact form); the
 * BAJADA/SUBIDA direction shows only when a move is badge-worthy, and the whole
 * thing renders nothing when there is no signal at all (the "no badge" rule).
 * The (optional) comparison-base tooltip is forward-compatible with #461.
 */
describe("PriceSignals", () => {
  it("renders a GREEN rating with the signed % and NO 'bajo mercado' words when below market", () => {
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
    // #460: short form — signed percent, no descriptive words.
    expect(rating).toHaveTextContent(/−20%/);
    expect(rating).not.toHaveTextContent(/bajo mercado/i);
  });

  it("renders a RED rating with a +% and NO 'sobre mercado' words when above market", () => {
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
    expect(rating).toHaveTextContent(/\+12%/);
    expect(rating).not.toHaveTextContent(/sobre mercado/i);
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
    expect(dir).toHaveTextContent(/▼/);
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

  it("names the comparison base in the tooltip when provided (forward-compatible with #461)", () => {
    render(
      <PriceSignals
        belowMarketPct={0.2}
        belowMarketBase="segment"
        belowMarketComparables={7}
        priceChanged={false}
        priceDirection={null}
        priceDeltaPct={null}
      />,
    );
    const rating = screen.getByTestId("price-rating");
    expect(rating).toHaveAttribute("data-base", "segment");
    expect(rating.getAttribute("title")).toMatch(/7 inmuebles similares/);
  });

  it("falls back to the generic tooltip wording when no base is provided", () => {
    render(
      <PriceSignals
        belowMarketPct={0.2}
        priceChanged={false}
        priceDirection={null}
        priceDeltaPct={null}
      />,
    );
    const rating = screen.getByTestId("price-rating");
    expect(rating.getAttribute("title")).toMatch(/mediana de precio\/m²/);
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
