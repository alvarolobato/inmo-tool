// @vitest-environment jsdom
//
// The Estado "Avisos" band (issue #642 P2) — the surface that let `/etl/salud`
// be deleted. Two behaviours matter enough to pin here rather than only in
// e2e: what it renders, and what it refuses to render.
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { avisosFrom, AvisoBand } from "../AvisoBand";
import type { DataHealthResponse } from "@/lib/data-health";

vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

const NOW = Date.parse("2026-08-22T12:00:00Z");

function payload(over: Partial<DataHealthResponse> = {}): DataHealthResponse {
  return {
    connectors: [],
    portals: [],
    sources: [],
    stale_profiles: [],
    zero_result_regressions: [],
    sweep_in_progress: false,
    extension_blocks: [],
    generated_at: new Date(NOW).toISOString(),
    ...over,
  };
}

describe("avisosFrom", () => {
  it("returns nothing when nothing is wrong", () => {
    expect(avisosFrom(payload(), NOW)).toEqual([]);
  });

  it("ranks an active block above a zero-result regression", () => {
    // Capture is STOPPED until a human acts; a search that quietly went empty
    // can wait. Order is the only ranking this band has.
    const avisos = avisosFrom(
      payload({
        extension_blocks: [
          {
            portal: "idealista",
            signature: "captcha_wall",
            detected_at: new Date(NOW - 3600_000).toISOString(),
          },
        ],
        zero_result_regressions: [
          {
            connector: "fotocasa",
            scope_key: "madrid",
            consecutive_zeros: 4,
            last_nonzero_count: 30,
            drift_started_at: new Date(NOW - 86_400_000).toISOString(),
            last_observed_at: new Date(NOW - 3_600_000).toISOString(),
          },
        ],
      }),
      NOW,
    );
    expect(avisos.map((a) => a.source)).toEqual(["idealista", "fotocasa"]);
    expect(avisos[0].tone).toBe("alarm");
    expect(avisos[0].href).toBe("/admin/fuentes/idealista");
    expect(avisos[1].href).toBe("/admin/fuentes/fotocasa");
  });

  it("does not restate the scopes Fuentes/<name> already lists — it counts them", () => {
    // #702's hand-off claimed Fuentes did not cover D-092; a re-read showed it
    // does (fuentes/[[...name]]/page.tsx, "Busquedas que dejaron de devolver
    // resultados"). So this band links there and names the WORST streak; it
    // must not become a second copy of the list.
    const avisos = avisosFrom(
      payload({
        zero_result_regressions: [
          {
            connector: "fotocasa",
            scope_key: "madrid",
            consecutive_zeros: 4,
            last_nonzero_count: 30,
            drift_started_at: new Date(NOW - 86_400_000).toISOString(),
            last_observed_at: new Date(NOW - 3_600_000).toISOString(),
          },
          {
            connector: "fotocasa",
            scope_key: "barcelona",
            consecutive_zeros: 9,
            last_nonzero_count: 12,
            drift_started_at: new Date(NOW - 86_400_000).toISOString(),
            last_observed_at: new Date(NOW - 3_600_000).toISOString(),
          },
        ],
      }),
      NOW,
    );
    expect(avisos).toHaveLength(1);
    expect(avisos[0].text).toContain("2 búsquedas");
    expect(avisos[0].text).toContain("9");
    expect(avisos[0].text).not.toContain("madrid");
  });

  it("uses the singular phrasing for exactly one scope", () => {
    const avisos = avisosFrom(
      payload({
        zero_result_regressions: [
          {
            connector: "fotocasa",
            scope_key: "madrid",
            consecutive_zeros: 4,
            last_nonzero_count: 30,
            drift_started_at: new Date(NOW - 86_400_000).toISOString(),
            last_observed_at: new Date(NOW - 3_600_000).toISOString(),
          },
        ],
      }),
      NOW,
    );
    expect(avisos[0].text).toBe("una búsqueda lleva 4 ejecuciones sin resultados");
  });
});

describe("<AvisoBand/>", () => {
  function mockFetch(body: unknown, ok = true) {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok, json: async () => body } as Response),
    );
  }

  it("renders nothing at all when there are no avisos", async () => {
    mockFetch(payload());
    const { container } = render(<AvisoBand />);
    await vi.waitFor(() => expect(container.querySelector("section")).toBeNull());
  });

  it("renders nothing — not a false 'no hay avisos' — when the read fails", async () => {
    // A failed read is UNKNOWN. Claiming "sin avisos" here would be the exact
    // class of lie #638's review found on the board above (a DB error
    // rendering as a confident "no hay fuentes").
    mockFetch(null, false);
    const { container } = render(<AvisoBand />);
    await vi.waitFor(() => expect(container.querySelector("section")).toBeNull());
    expect(container.textContent).not.toMatch(/sin avisos/i);
  });

  it("renders one linked row per aviso", async () => {
    mockFetch(
      payload({
        extension_blocks: [
          { portal: "idealista", signature: "captcha_wall", detected_at: new Date().toISOString() },
        ],
      }),
    );
    render(<AvisoBand />);
    const row = await screen.findByTestId("estado-aviso-bloqueo:idealista");
    expect(row.getAttribute("href")).toBe("/admin/fuentes/idealista");
    expect(row.textContent).toContain("idealista");
  });
});
