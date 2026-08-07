// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { CandidateCard } from "@/components/candidates/CandidateCard";
import type { CandidateRow } from "@/lib/candidates";
import { COLD_START_EXPLANATION } from "@/lib/scoring/cold-start";

function candidate(overrides: Partial<CandidateRow> = {}): CandidateRow {
  return {
    property_id: 1,
    address: "Calle Trafalgar, Chamberí, Madrid",
    lat: 40.4324,
    lon: -3.7025,
    property_type: "piso",
    m2_built: 70,
    rooms: 2,
    bathrooms: 1,
    floor: "3",
    photos: ["https://img.example/1.jpg"],
    flags: [],
    min_price: 279000,
    first_seen_at: "2026-07-01T00:00:00.000Z",
    // Null by default so the staleness badge is opt-in per test (its band is
    // relative to `now`, so a hard-coded ISO here would drift bands as real
    // time passes) — the dedicated staleness tests below set it explicitly
    // with dates relative to Date.now().
    last_seen_at: null,
    is_new: false,
    listings: [{ id: 10, source: "fotocasa", url: "https://x", current_price: 285000 }],
    score: null,
    rank_explanation: null,
    score_kind: null,
    ...overrides,
  };
}

describe("CandidateCard", () => {
  it("#416: marks a new candidate — NUEVO badge + data-novelty hook — and stays unmarked otherwise", () => {
    const { rerender } = render(<CandidateCard candidate={candidate({ is_new: true })} profileId={5} />);
    const card = screen.getByTestId("candidate-card");
    expect(card).toHaveAttribute("data-novelty", "new");
    const badge = screen.getByTestId("candidate-novelty");
    expect(badge).toHaveTextContent(/nuevo/i);
    expect(badge).toHaveAttribute("data-novelty", "new");

    // Not new → no badge and no root hook (mirrors the data-rejected default).
    rerender(<CandidateCard candidate={candidate({ is_new: false })} profileId={5} />);
    expect(screen.getByTestId("candidate-card")).not.toHaveAttribute("data-novelty");
    expect(screen.queryByTestId("candidate-novelty")).toBeNull();
  });

  it("renders address, price, the full fact line, and a single source badge", () => {
    render(<CandidateCard candidate={candidate()} profileId={5} />);
    expect(screen.getByText("Calle Trafalgar, Chamberí, Madrid")).toBeInTheDocument();
    expect(screen.getByText("279.000 €")).toBeInTheDocument();
    expect(screen.getByText(/Piso.*70 m².*2 hab\..*1 baño.*Planta 3/)).toBeInTheDocument();
    expect(screen.getByText("fotocasa")).toBeInTheDocument();
  });

  it("leads with the first photo, falling back to a placeholder when the property has none", () => {
    const { rerender } = render(<CandidateCard candidate={candidate()} profileId={5} />);
    expect(screen.getByTestId("candidate-photo-img")).toHaveAttribute("src", "https://img.example/1.jpg");

    rerender(<CandidateCard candidate={candidate({ photos: [] })} profileId={5} />);
    expect(screen.getByTestId("candidate-photo-placeholder")).toBeInTheDocument();
  });

  it("#167: renders no ticker for zero or one photo — only 2+ photos get prev/next controls", () => {
    const { rerender } = render(<CandidateCard candidate={candidate({ photos: [] })} profileId={5} />);
    expect(screen.queryByTestId("candidate-photo-ticker")).not.toBeInTheDocument();

    rerender(<CandidateCard candidate={candidate({ photos: ["https://img.example/1.jpg"] })} profileId={5} />);
    expect(screen.queryByTestId("candidate-photo-ticker")).not.toBeInTheDocument();

    rerender(
      <CandidateCard
        candidate={candidate({ photos: ["https://img.example/1.jpg", "https://img.example/2.jpg"] })}
        profileId={5}
      />,
    );
    expect(screen.getByTestId("candidate-photo-ticker")).toBeInTheDocument();
  });

  it("#167: ticker prev/next cycle the displayed photo and wrap at both ends, without navigating", () => {
    render(
      <CandidateCard
        candidate={candidate({
          photos: ["https://img.example/1.jpg", "https://img.example/2.jpg", "https://img.example/3.jpg"],
        })}
        profileId={5}
      />,
    );
    const img = () => screen.getByTestId("candidate-photo-img");
    expect(img()).toHaveAttribute("src", "https://img.example/1.jpg");

    fireEvent.click(screen.getByTestId("candidate-photo-next"));
    expect(img()).toHaveAttribute("src", "https://img.example/2.jpg");

    fireEvent.click(screen.getByTestId("candidate-photo-next"));
    expect(img()).toHaveAttribute("src", "https://img.example/3.jpg");

    // Wraps forward past the last photo back to the first.
    fireEvent.click(screen.getByTestId("candidate-photo-next"));
    expect(img()).toHaveAttribute("src", "https://img.example/1.jpg");

    // Wraps backward past the first photo to the last.
    fireEvent.click(screen.getByTestId("candidate-photo-prev"));
    expect(img()).toHaveAttribute("src", "https://img.example/3.jpg");

    // Only proves the ticker's index state doesn't leak into mutating the
    // link's own target — NOT that clicking the ticker "never navigates".
    // jsdom's <a> elements don't perform real navigation on click at all
    // (there is nothing here for a click to navigate away FROM), and
    // fireEvent.click bypasses the actual DOM event dispatch/propagation path
    // a real browser click takes, so this assertion would pass identically
    // even if the ticker buttons were (incorrectly) nested inside the
    // <Link>. "Never navigates" is actually proven two other ways: the
    // sibling-not-child DOM structure test right below (a click physically
    // can't reach an ancestor <a> it isn't inside), and
    // e2e/card-detail-ux.spec.ts's real-browser test ("the whole point:
    // flicking through photos must never leave the list"), which asserts
    // the page's actual URL after real clicks in real Chromium.
    expect(screen.getByRole("link")).toHaveAttribute("href", "/profiles/5/properties/1");
  });

  it("#167: the ticker controls are outside the detail <Link>, mirroring the feedback bar's sibling-not-child layout", () => {
    render(
      <CandidateCard
        candidate={candidate({ photos: ["https://img.example/1.jpg", "https://img.example/2.jpg"] })}
        profileId={5}
      />,
    );
    const link = screen.getByRole("link");
    const ticker = screen.getByTestId("candidate-photo-ticker");
    expect(link.contains(ticker)).toBe(false);
  });

  it("#167: ticker buttons have accessible labels", () => {
    render(
      <CandidateCard
        candidate={candidate({ photos: ["https://img.example/1.jpg", "https://img.example/2.jpg"] })}
        profileId={5}
      />,
    );
    expect(screen.getByTestId("candidate-photo-prev")).toHaveAttribute("aria-label", "Foto anterior");
    expect(screen.getByTestId("candidate-photo-next")).toHaveAttribute("aria-label", "Foto siguiente");
  });

  it("renders one badge per AI flag, colouring only the ones that change what you're buying", () => {
    render(
      <CandidateCard
        candidate={candidate({
          flags: [
            { kind: "occupancy", label: "Ocupado", tone: "warn" },
            { kind: "condition", label: "A reformar", tone: "neutral" },
          ],
        })}
        profileId={5}
      />,
    );
    const flags = screen.getAllByTestId("candidate-flag");
    expect(flags.map((f) => f.textContent)).toEqual(["Ocupado", "A reformar"]);
  });

  it("links to the property detail page for this profile", () => {
    render(<CandidateCard candidate={candidate({ property_id: 42 })} profileId={5} />);
    expect(screen.getByRole("link")).toHaveAttribute("href", "/profiles/5/properties/42");
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
        profileId={5}
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
          bathrooms: null,
          floor: null,
          min_price: null,
          first_seen_at: null,
        })}
        profileId={5}
      />,
    );
    expect(screen.getByText("Dirección no disponible")).toBeInTheDocument();
    expect(screen.getByText("Precio no disponible")).toBeInTheDocument();
    expect(screen.getByText("Sin datos estructurados")).toBeInTheDocument();
  });

  it("omits unknown facts rather than padding the line with 'no disponible' placeholders", () => {
    render(<CandidateCard candidate={candidate({ bathrooms: null, floor: null })} profileId={5} />);
    const facts = screen.getByTestId("candidate-facts").textContent ?? "";
    expect(facts).toContain("70 m²");
    expect(facts).not.toContain("baños");
    expect(facts).not.toContain("Planta");
  });

  it("pluralises baños and only prefixes 'Planta' when the floor is a bare number", () => {
    const { rerender } = render(
      <CandidateCard candidate={candidate({ bathrooms: 2, floor: "Bajo" })} profileId={5} />,
    );
    let facts = screen.getByTestId("candidate-facts").textContent ?? "";
    expect(facts).toContain("2 baños");
    expect(facts).toContain("Bajo");
    expect(facts).not.toContain("Planta Bajo");

    rerender(<CandidateCard candidate={candidate({ bathrooms: 1, floor: "3" })} profileId={5} />);
    facts = screen.getByTestId("candidate-facts").textContent ?? "";
    expect(facts).toContain("1 baño ");
    expect(facts).toContain("Planta 3");
  });

  it("renders rank_explanation when present, and renders nothing for it when null", () => {
    const { rerender } = render(
      <CandidateCard candidate={candidate({ rank_explanation: "Encaja bien con tu perfil: precio un 8% por debajo de tu banda de precio." })} profileId={5} />,
    );
    expect(screen.getByTestId("rank-explanation")).toHaveTextContent("Encaja bien con tu perfil: precio un 8% por debajo de tu banda de precio.");

    rerender(<CandidateCard candidate={candidate({ rank_explanation: null })} profileId={5} />);
    expect(screen.queryByTestId("rank-explanation")).not.toBeInTheDocument();
  });

  it("#152: suppresses the cold-start explanation on the card — CandidateList shows it once for the whole profile", () => {
    render(
      <CandidateCard
        candidate={candidate({ rank_explanation: COLD_START_EXPLANATION, score_kind: "cold_start" })}
        profileId={5}
      />,
    );
    expect(screen.queryByTestId("rank-explanation")).not.toBeInTheDocument();
  });

  it("#152 review: suppression is driven by score_kind, not by string-matching rank_explanation against the constant", () => {
    // Same guarding value the cold-start writer actually uses, but tagged
    // with a *different* score_kind than the writer would ever pair it
    // with — proves the card reads the durable marker, not the string.
    render(
      <CandidateCard
        candidate={candidate({ rank_explanation: "cualquier texto, aunque no coincida con la constante", score_kind: "cold_start" })}
        profileId={5}
      />,
    );
    expect(screen.queryByTestId("rank-explanation")).not.toBeInTheDocument();
  });

  it("#152 review: a real explanation still renders even if its text happens to equal the cold-start sentence, as long as score_kind is 'trained'", () => {
    // Regression guard: comparing rank_explanation against
    // COLD_START_EXPLANATION by string equality would wrongly suppress this
    // — a purely cosmetic edit to the constant could otherwise silently
    // un-suppress every already-written cold-start row (#152 review).
    render(
      <CandidateCard
        candidate={candidate({ rank_explanation: COLD_START_EXPLANATION, score_kind: "trained" })}
        profileId={5}
      />,
    );
    expect(screen.getByTestId("rank-explanation")).toHaveTextContent(COLD_START_EXPLANATION);
  });

  // Listing staleness (#243). `daysAgo` builds an ISO relative to the real
  // `now` the badge reads, so a band assertion stays stable as time passes.
  const daysAgo = (n: number) => new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString();

  it("#243: renders the staleness age with the fresh band for a recently-seen listing", () => {
    render(<CandidateCard candidate={candidate({ last_seen_at: daysAgo(3) })} profileId={5} />);
    const badge = screen.getByTestId("candidate-staleness");
    expect(badge).toHaveTextContent("visto hace 3 días");
    expect(badge).toHaveAttribute("data-staleness-band", "fresh");
  });

  it("#243: escalates the band to aging, then stale, as the last-seen age grows", () => {
    const { rerender } = render(
      <CandidateCard candidate={candidate({ last_seen_at: daysAgo(14) })} profileId={5} />,
    );
    expect(screen.getByTestId("candidate-staleness")).toHaveAttribute("data-staleness-band", "aging");

    rerender(<CandidateCard candidate={candidate({ last_seen_at: daysAgo(30) })} profileId={5} />);
    const badge = screen.getByTestId("candidate-staleness");
    expect(badge).toHaveAttribute("data-staleness-band", "stale");
    expect(badge).toHaveTextContent("visto hace 30 días");
  });

  it("#243: renders no staleness badge when last_seen_at is unknown (never claims 'visto hoy')", () => {
    render(<CandidateCard candidate={candidate({ last_seen_at: null })} profileId={5} />);
    expect(screen.queryByTestId("candidate-staleness")).not.toBeInTheDocument();
  });

  it("#152: keeps the feedback controls outside the detail <Link> so acting on a card can't navigate", () => {
    render(<CandidateCard candidate={candidate()} profileId={5} />);
    const link = screen.getByRole("link");
    const actions = screen.getByTestId("candidate-card-actions");
    expect(link.contains(actions)).toBe(false);
  });
});
