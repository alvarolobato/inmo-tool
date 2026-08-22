// @vitest-environment node
//
// Pure derivations behind the Estado "Avisos" band and the Fuentes
// active-block notice (issue #642 P2). Both surfaces are the reason
// `/etl/salud` could be deleted, so what they derive is pinned here rather
// than only being exercised through a rendered page.
import { describe, it, expect } from "vitest";
import {
  ACTIVE_BLOCK_WINDOW_HOURS,
  activeBlocksByPortal,
  zeroResultsByConnector,
  type ExtensionBlockEpisode,
} from "../data-health";
import type { ZeroResultRegression } from "../zero-result-regression";

const NOW = Date.parse("2026-08-22T12:00:00Z");
const hoursAgo = (h: number) => new Date(NOW - h * 3600_000).toISOString();

function episode(portal: string, h: number, signature = "captcha_wall"): ExtensionBlockEpisode {
  return { portal, signature, detected_at: hoursAgo(h) };
}

describe("activeBlocksByPortal", () => {
  it("keeps an episode inside the window and drops one outside it", () => {
    const active = activeBlocksByPortal(
      [episode("idealista", 2), episode("pisos", ACTIVE_BLOCK_WINDOW_HOURS + 1)],
      NOW,
    );
    expect([...active.keys()]).toEqual(["idealista"]);
  });

  it("keeps the NEWEST episode per portal regardless of input order", () => {
    // getRecentBlockEpisodes returns newest-first, but the derivation must not
    // depend on that — a caller that re-sorts must get the same answer.
    const oldest = episode("idealista", 20, "datadome");
    const newest = episode("idealista", 1, "captcha_wall");
    expect(activeBlocksByPortal([oldest, newest], NOW).get("idealista")).toBe(newest);
    expect(activeBlocksByPortal([newest, oldest], NOW).get("idealista")).toBe(newest);
  });

  it("is empty for an empty history, and never throws on a malformed timestamp", () => {
    expect(activeBlocksByPortal([], NOW).size).toBe(0);
    const bad: ExtensionBlockEpisode = {
      portal: "x",
      signature: "s",
      detected_at: "not-a-date",
    };
    expect(activeBlocksByPortal([bad], NOW).size).toBe(0);
  });

  it("treats the window boundary as still active", () => {
    // Exactly at the cutoff is inside: the alternative is a chip that blinks
    // out mid-second on a value nobody can act on that precisely.
    const at = activeBlocksByPortal([episode("idealista", ACTIVE_BLOCK_WINDOW_HOURS)], NOW);
    expect(at.size).toBe(1);
  });
});

describe("zeroResultsByConnector", () => {
  const row = (connector: string, scope: string, zeros: number): ZeroResultRegression => ({
    connector,
    scope_key: scope,
    consecutive_zeros: zeros,
    last_nonzero_count: 12,
    drift_started_at: hoursAgo(48),
  });

  it("groups by connector and preserves input order within a group", () => {
    const grouped = zeroResultsByConnector([
      row("fotocasa", "madrid", 3),
      row("milanuncios", "valencia", 5),
      row("fotocasa", "barcelona", 4),
    ]);
    expect([...grouped.keys()]).toEqual(["fotocasa", "milanuncios"]);
    expect(grouped.get("fotocasa")!.map((r) => r.scope_key)).toEqual(["madrid", "barcelona"]);
  });

  it("is empty for the healthy state", () => {
    expect(zeroResultsByConnector([]).size).toBe(0);
  });
});
