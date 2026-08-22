/**
 * Unit tests for the pure prospective-site queue helpers (issue #705).
 *
 * The load-bearing property here is the MUTUAL EXCLUSION with the worklist
 * paste box: `addWorklistUrls` requires `portalForUrl` to resolve, and
 * `validateSpikeUrls` requires it NOT to. That is what makes "this is a new
 * site I'm evaluating" a structural choice rather than a checkbox — and what
 * stops a mistyped idealista link from quietly becoming a spike capture.
 */

import { describe, it, expect } from "vitest";
import {
  MAX_SPIKE_ATTEMPTS,
  SPIKE_STATUSES,
  SPIKE_UNIT_LIMIT,
  pendingSpikeOrigins,
  summarizeSpikeRequests,
  validateSpikeUrls,
  type SpikeRequestRow,
} from "@/lib/spike-queue";
import { portalForUrl } from "@/lib/worklist";

function row(over: Partial<SpikeRequestRow>): SpikeRequestRow {
  return {
    id: 1,
    url: "https://www.servihabitat.com/inmueble/1",
    host: "servihabitat.com",
    site_label: "Servihabitat",
    note: null,
    status: "pending",
    matched_diagnostic_id: null,
    attempts: 0,
    last_attempt_at: null,
    created_at: "2026-08-22T10:00:00.000Z",
    updated_at: "2026-08-22T10:00:00.000Z",
    ...over,
  };
}

describe("validateSpikeUrls — the mirror image of the worklist validator", () => {
  it("accepts a host that no capture connector claims", () => {
    const url = "https://www.servihabitat.com/es/inmueble/12345";
    expect(portalForUrl(url)).toBeNull(); // premise of this whole feature
    const { accepted, rejected } = validateSpikeUrls([url]);
    expect(rejected).toEqual([]);
    expect(accepted).toHaveLength(1);
    expect(accepted[0].host).toBe("servihabitat.com");
    expect(accepted[0].matchKey).toBe("servihabitat.com/es/inmueble/12345");
  });

  it("REFUSES a supported-portal host, naming the portal and where it belongs", () => {
    const { accepted, rejected } = validateSpikeUrls([
      "https://www.idealista.com/inmueble/98765/",
    ]);
    expect(accepted).toEqual([]);
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason).toContain("idealista");
    expect(rejected[0].reason).toContain("/admin/fuentes/idealista");
  });

  it("refuses every capture portal, not just idealista", () => {
    const supported = [
      "https://www.idealista.com/inmueble/1/",
      "https://www.alisedainmobiliaria.com/inmueble/2",
      "https://www.altamirainmuebles.com/inmueble/3",
      "https://realestate.hipoges.com/es/venta/4",
    ];
    const { accepted, rejected } = validateSpikeUrls(supported);
    expect(accepted).toEqual([]);
    expect(rejected).toHaveLength(supported.length);
  });

  it("refuses a subdomain of a supported portal too (the typo case)", () => {
    // A pasted `www.idealista.com` link is refused above; a subdomain must be
    // refused by the same host-suffix rule, or the guard is bypassable by
    // pasting a canonicalised variant.
    const { accepted } = validateSpikeUrls(["https://fotos.idealista.com/x/1"]);
    expect(accepted).toEqual([]);
  });

  it("refuses non-http(s) schemes", () => {
    const { accepted, rejected } = validateSpikeUrls([
      "javascript:alert(1)",
      "data:text/html,<b>x</b>",
      "ftp://example.com/a",
    ]);
    expect(accepted).toEqual([]);
    expect(rejected).toHaveLength(3);
  });

  it("reports an unparseable URL rather than dropping it silently", () => {
    const { accepted, rejected } = validateSpikeUrls(["not a url"]);
    expect(accepted).toEqual([]);
    expect(rejected[0].reason).toBe("URL inválida");
  });

  it("collapses in-batch duplicates by match key, ignoring cosmetic differences", () => {
    const { accepted } = validateSpikeUrls([
      "https://www.example-portal.es/inmueble/7",
      "http://example-portal.es/inmueble/7/?utm_source=x#frag",
    ]);
    expect(accepted).toHaveLength(1);
  });

  it("skips blank lines from a pasted blob without reporting them as invalid", () => {
    const { accepted, rejected } = validateSpikeUrls([
      "",
      "   ",
      "https://www.example-portal.es/inmueble/8",
    ]);
    expect(accepted).toHaveLength(1);
    expect(rejected).toEqual([]);
  });
});

describe("terminal states", () => {
  it("has no 'failed' state — a spike capture is never an ingestion error", () => {
    expect(SPIKE_STATUSES).not.toContain("failed");
    expect([...SPIKE_STATUSES].sort()).toEqual([
      "captured",
      "pending",
      "skipped",
      "unreachable",
    ]);
  });
});

describe("pendingSpikeOrigins — what the popup asks Chrome to grant", () => {
  it("returns one distinct origin per pending host, sorted", () => {
    const origins = pendingSpikeOrigins([
      row({ id: 1, url: "https://b.example.es/a" }),
      row({ id: 2, url: "https://b.example.es/other" }),
      row({ id: 3, url: "https://a.example.es/x" }),
    ]);
    expect(origins).toEqual(["https://a.example.es", "https://b.example.es"]);
  });

  it("ignores rows that are no longer pending — a granted permission is not needed for them", () => {
    expect(
      pendingSpikeOrigins([
        row({ id: 1, status: "captured", url: "https://done.example.es/a" }),
        row({ id: 2, status: "skipped", url: "https://nope.example.es/a" }),
        row({ id: 3, status: "unreachable", url: "https://gone.example.es/a" }),
      ]),
    ).toEqual([]);
  });

  it("skips a stored row whose URL no longer parses instead of throwing", () => {
    expect(pendingSpikeOrigins([row({ url: "::broken::" })])).toEqual([]);
  });
});

describe("summarizeSpikeRequests", () => {
  it("rolls up per operator-given site label", () => {
    const s = summarizeSpikeRequests([
      row({ id: 1, site_label: "Servihabitat", status: "captured" }),
      row({ id: 2, site_label: "Servihabitat", status: "pending" }),
      row({ id: 3, site_label: "Servihabitat", status: "unreachable" }),
      row({ id: 4, site_label: "Otro", status: "skipped" }),
    ]);
    expect(s).toHaveLength(2);
    const sh = s.find((x) => x.site_label === "Servihabitat")!;
    expect(sh).toMatchObject({
      total: 3,
      captured: 1,
      pending: 1,
      unreachable: 1,
      skipped: 0,
    });
  });
});

describe("bounds", () => {
  it("keeps the auto unit small enough that it can't stall the listing drain", () => {
    expect(SPIKE_UNIT_LIMIT).toBeLessThanOrEqual(10);
    expect(SPIKE_UNIT_LIMIT).toBeGreaterThan(0);
  });

  it("gives a request more than one chance before giving up on it", () => {
    expect(MAX_SPIKE_ATTEMPTS).toBeGreaterThan(1);
  });
});
