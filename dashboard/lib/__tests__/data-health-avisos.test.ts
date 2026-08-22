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

function episode(
  portal: string,
  h: number,
  signature = "captcha_wall",
  resolvedHoursAgo: number | null = null,
): ExtensionBlockEpisode {
  return {
    portal,
    signature,
    detected_at: hoursAgo(h),
    resolved_at: resolvedHoursAgo === null ? null : hoursAgo(resolvedHoursAgo),
  };
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
      resolved_at: null,
    };
    expect(activeBlocksByPortal([bad], NOW).size).toBe(0);
  });

  it("treats the window boundary as still active", () => {
    // Exactly at the cutoff is inside: the alternative is a chip that blinks
    // out mid-second on a value nobody can act on that precisely.
    const at = activeBlocksByPortal([episode("idealista", ACTIVE_BLOCK_WINDOW_HOURS)], NOW);
    expect(at.size).toBe(1);
  });

  // ── Resolution (issue #711, D-169) ────────────────────────────────────────
  //
  // The live false alarm this fixes: episode at 14:53, idealista ingesting
  // again by 17:39, board still saying "pausada por bloqueo" at 17:45. Recency
  // alone said active; the capture ledger said otherwise, and the ledger wins.

  it("drops a RESOLVED episode even though it is well inside the window", () => {
    // The production shape, to scale: detected 3h ago, portal serving again
    // since 5 minutes later.
    const resolved = episode("idealista", 3, "captcha_wall", 2.9);
    expect(activeBlocksByPortal([resolved], NOW).size).toBe(0);
  });

  it("keeps an UNRESOLVED episode inside the window", () => {
    // The control for the test above — same episode, no clearing evidence.
    const active = activeBlocksByPortal([episode("idealista", 3)], NOW);
    expect([...active.keys()]).toEqual(["idealista"]);
  });

  it("resolves per portal — one portal's recovery never clears another's", () => {
    const active = activeBlocksByPortal(
      [episode("idealista", 3, "captcha_wall", 2), episode("hipoges", 3)],
      NOW,
    );
    expect([...active.keys()]).toEqual(["hipoges"]);
  });

  it("falls back to ALARMING when resolution is absent from the payload", () => {
    // A field that is missing, empty, or otherwise not a real timestamp is NO
    // clearing evidence, and must never be read as "resolved". Every ambiguity
    // in this derivation has to fail toward keeping the alarm up: a stale chip
    // is visibly wrong, a missing one is silent.
    const noField = { portal: "idealista", signature: "captcha_wall", detected_at: hoursAgo(3) };
    expect(activeBlocksByPortal([noField as ExtensionBlockEpisode], NOW).size).toBe(1);
    const empty = { ...episode("idealista", 3), resolved_at: "" };
    expect(activeBlocksByPortal([empty], NOW).size).toBe(1);
  });

  it("a RESOLVED newest episode does not resurrect an older unresolved one", () => {
    // Per-portal the derivation keeps the newest; if that one is resolved the
    // portal is clear, full stop. An older episode is older evidence about the
    // same wall, and a wall that has since been served through is over — the
    // alternative would pin the chip on the oldest episode in the window and
    // never let the portal go green.
    const older = episode("idealista", 10, "datadome");
    const newer = episode("idealista", 2, "captcha_wall", 1);
    expect(activeBlocksByPortal([older, newer], NOW).size).toBe(0);
    expect(activeBlocksByPortal([newer, older], NOW).size).toBe(0);
  });
});

describe("zeroResultsByConnector", () => {
  const row = (connector: string, scope: string, zeros: number): ZeroResultRegression => ({
    connector,
    scope_key: scope,
    consecutive_zeros: zeros,
    last_nonzero_count: 12,
    drift_started_at: hoursAgo(48),
    last_observed_at: hoursAgo(1),
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
