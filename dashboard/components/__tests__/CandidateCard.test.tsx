// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { CandidateCard } from "@/components/candidates/CandidateCard";
import type { CandidateRow } from "@/lib/candidates";

function candidate(overrides: Partial<CandidateRow> = {}): CandidateRow {
  return {
    property_id: 1,
    address: "Calle Trafalgar, Chamberí, Madrid",
    lat: 40.4324,
    lon: -3.7025,
    property_type: "piso",
    m2_built: 70,
    rooms: 2,
    min_price: 279000,
    first_seen_at: "2026-07-01T00:00:00.000Z",
    listings: [{ id: 10, source: "fotocasa", url: "https://x", current_price: 285000 }],
    ...overrides,
  };
}

describe("CandidateCard", () => {
  it("renders address, price, type/size/rooms, and a single source badge", () => {
    render(<CandidateCard candidate={candidate()} />);
    expect(screen.getByText("Calle Trafalgar, Chamberí, Madrid")).toBeInTheDocument();
    expect(screen.getByText("279.000 €")).toBeInTheDocument();
    expect(screen.getByText(/Piso.*70 m².*2 hab\./)).toBeInTheDocument();
    expect(screen.getByText("fotocasa")).toBeInTheDocument();
  });

  it("shows one badge per distinct source for a deduplicated property with multiple listings", () => {
    render(
      <CandidateCard
        candidate={candidate({
          listings: [
            { id: 10, source: "fotocasa", url: "https://x", current_price: 285000 },
            { id: 11, source: "milanuncios", url: "https://y", current_price: 279000 },
          ],
        })}
      />,
    );
    expect(screen.getByText("fotocasa")).toBeInTheDocument();
    expect(screen.getByText("milanuncios")).toBeInTheDocument();
  });

  it("falls back to placeholder text for missing fields instead of rendering blank/undefined", () => {
    render(
      <CandidateCard
        candidate={candidate({
          address: null,
          property_type: null,
          m2_built: null,
          rooms: null,
          min_price: null,
          first_seen_at: null,
        })}
      />,
    );
    expect(screen.getByText("Dirección no disponible")).toBeInTheDocument();
    expect(screen.getByText("Precio no disponible")).toBeInTheDocument();
    expect(screen.getByText("Tipo no disponible")).toBeInTheDocument();
  });
});
