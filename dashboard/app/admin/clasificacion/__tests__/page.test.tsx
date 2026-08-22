// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import type { PromotionCandidate } from "@/lib/db/redflag-candidates";

// ---------------------------------------------------------------------------
// Mocks — the page is a server component that reads Postgres; we mock the data
// layer so the test exercises rendering only (data / empty / error), not SQL.
// ---------------------------------------------------------------------------
const getPromotionCandidates = vi.fn();
const getCandidatePromotionThreshold = vi.fn(() => 5);

vi.mock("@/lib/db/redflag-candidates", () => ({
  getPromotionCandidates: (...args: unknown[]) => getPromotionCandidates(...args),
  getCandidatePromotionThreshold: () => getCandidatePromotionThreshold(),
}));

vi.mock("next/link", () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}));

// The DismissButton (client component) calls useRouter() at render, and
// <RevisionTabs/> (#642 P2, the Duplicados/Clasificación switcher this page
// now carries) calls usePathname().
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn() }),
  usePathname: () => "/admin/clasificacion",
}));

import AdminClasificacionPage from "../page";

/** Render the async server component: await it, then mount the returned tree. */
async function renderPage() {
  const ui = await AdminClasificacionPage();
  render(ui);
}

const SAMPLE: PromotionCandidate[] = [
  {
    candidateType: "servidumbre_de_paso",
    count: 8,
    definition: "Un tercero tiene derecho de paso por la finca.",
    evidence: ["existe una servidumbre de paso a favor del vecino", "el acceso es compartido"],
    properties: [
      { id: 101, address: "Calle Mayor 1", profileId: 3 },
      { id: 102, address: null, profileId: null },
    ],
  },
];

describe("AdminClasificacionPage", () => {
  beforeEach(() => {
    getPromotionCandidates.mockReset();
    getCandidatePromotionThreshold.mockReturnValue(5);
  });

  it("renders the candidate list with slug, definition, count, evidence and property links", async () => {
    getPromotionCandidates.mockResolvedValue(SAMPLE);
    await renderPage();

    expect(screen.getByText("servidumbre_de_paso")).toBeInTheDocument();
    expect(
      screen.getByText("Un tercero tiene derecho de paso por la finca."),
    ).toBeInTheDocument();
    expect(screen.getByText(/8 apariciones/)).toBeInTheDocument();
    expect(
      screen.getByText(/existe una servidumbre de paso a favor del vecino/),
    ).toBeInTheDocument();

    // Deep link when a profile is known; plain fallback ref when it is not.
    const link = screen.getByRole("link", { name: "Calle Mayor 1" });
    expect(link).toHaveAttribute("href", "/profiles/3/properties/101");
    expect(screen.getByText("Inmueble #102")).toBeInTheDocument();

    // The manual-promotion guarantee is always shown.
    expect(screen.getByText(/La promoción es manual/)).toBeInTheDocument();
  });

  it("renders a dismiss ('descartar') button per candidate", async () => {
    getPromotionCandidates.mockResolvedValue(SAMPLE);
    await renderPage();

    const btn = screen.getByTestId("dismiss-servidumbre_de_paso");
    expect(btn).toBeInTheDocument();
    expect(btn).toHaveTextContent("Descartar");
  });

  it("renders a clear empty state when nothing clears the threshold", async () => {
    getPromotionCandidates.mockResolvedValue([]);
    await renderPage();

    expect(screen.getByText(/Aún no hay candidatos sobre el umbral/)).toBeInTheDocument();
    // The threshold is surfaced in the empty message.
    expect(screen.getByText(/≥ 5/)).toBeInTheDocument();
  });

  it("surfaces a load error instead of crashing", async () => {
    getPromotionCandidates.mockRejectedValue(new Error("boom"));
    await renderPage();

    expect(screen.getByText("boom")).toBeInTheDocument();
  });
});
