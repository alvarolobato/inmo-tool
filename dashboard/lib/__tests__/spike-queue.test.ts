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
  MAX_PENDING_SPIKE_REQUESTS,
  MAX_SPIKE_ATTEMPTS,
  SPIKE_STATUSES,
  SPIKE_UNIT_LIMIT,
  grantableSpikeOrigins,
  spikePermissionOrigin,
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
    // Keep `origin` consistent with an overridden `url` unless explicitly set,
    // the way the INSERT does.
    origin:
      over.origin ??
      (over.url ? spikePermissionOrigin(over.url) : "https://www.servihabitat.com"),
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
    expect(accepted[0].origin).toBe("https://www.servihabitat.com");
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

describe("grantableSpikeOrigins — what the popup asks Chrome to grant", () => {
  it("returns one distinct origin per pending host, sorted", () => {
    const origins = grantableSpikeOrigins([
      row({ id: 1, url: "https://b.example.es/a" }),
      row({ id: 2, url: "https://b.example.es/other" }),
      row({ id: 3, url: "https://a.example.es/x" }),
    ]);
    expect(origins).toEqual(["https://a.example.es", "https://b.example.es"]);
  });

  it("KEEPS unreachable rows — the grant button must not vanish exactly when a batch was given up on", () => {
    // Issue #705 review F2: listing only `pending` rows meant that the moment
    // a batch burned out, both the popup button and the panel banner
    // disappeared, leaving no affordance to grant the permission at all.
    expect(
      grantableSpikeOrigins([
        row({ id: 1, status: "unreachable", url: "https://gone.example.es/a" }),
      ]),
    ).toEqual(["https://gone.example.es"]);
  });

  it("ignores rows a grant could no longer help — captured and operator-skipped", () => {
    expect(
      grantableSpikeOrigins([
        row({ id: 1, status: "captured", url: "https://done.example.es/a" }),
        row({ id: 2, status: "skipped", url: "https://nope.example.es/a" }),
      ]),
    ).toEqual([]);
  });

  it("drops the port — a Chrome match pattern has none, and one with a port is rejected", () => {
    expect(grantableSpikeOrigins([row({ url: "https://x.example.es:8443/a" })])).toEqual([
      "https://x.example.es",
    ]);
  });

  it("skips a stored row whose URL no longer parses instead of throwing", () => {
    expect(grantableSpikeOrigins([row({ url: "::broken::", origin: "" })])).toEqual([]);
  });
});

describe("denylist — the queue must not be pointable at our own admin UI (review F3)", () => {
  it("refuses localhost on any port: manifest.json pre-grants it and match patterns ignore the port", () => {
    const { accepted, rejected } = validateSpikeUrls([
      "http://localhost:4000/admin/diagnostics",
      "http://127.0.0.1:4000/admin/diagnostics",
      "http://[::1]:4000/admin",
    ]);
    expect(accepted).toEqual([]);
    expect(rejected).toHaveLength(3);
    expect(rejected[0].reason).toContain("Host no permitido");
  });

  it("refuses private, link-local and CGNAT ranges — the intranet version of the same mistake", () => {
    const { accepted } = validateSpikeUrls([
      "http://10.0.0.5/x",
      "http://172.16.4.4/x",
      "http://192.168.1.10/x",
      "http://169.254.1.1/x",
      "http://100.64.0.1/x",
      "http://nas.local/x",
      "http://build.internal/x",
    ]);
    expect(accepted).toEqual([]);
  });

  it("refuses the dashboard's own host when the route passes it in", () => {
    const { accepted, rejected } = validateSpikeUrls(["https://panel.example.com/admin/ia"], {
      deniedHosts: ["panel.example.com:4000"],
    });
    expect(accepted).toEqual([]);
    expect(rejected[0].reason).toContain("Host no permitido");
  });

  it("still accepts an ordinary public candidate host", () => {
    const { accepted } = validateSpikeUrls(["https://www.servihabitat.com/inmueble/1"], {
      deniedHosts: ["panel.example.com"],
    });
    expect(accepted).toHaveLength(1);
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

describe("bounds — the stall the spike unit can impose on the listing drain", () => {
  it("keeps the auto unit small", () => {
    expect(SPIKE_UNIT_LIMIT).toBeLessThanOrEqual(10);
    expect(SPIKE_UNIT_LIMIT).toBeGreaterThan(0);
  });

  it("gives a request more than one chance before giving up on it", () => {
    expect(MAX_SPIKE_ATTEMPTS).toBeGreaterThan(1);
  });

  it("caps the worst-case zero-drain window at 30 ticks (~30 min), not 'a couple'", () => {
    // Issue #705 review F4: the PR originally claimed "a couple of ticks" while
    // the real figure with a 200-row cap was 120 ticks ≈ 2 h. Pin the
    // arithmetic so lifting the cap has to lift this number in the same commit.
    const worstCaseTicks =
      Math.ceil(MAX_PENDING_SPIKE_REQUESTS / SPIKE_UNIT_LIMIT) * MAX_SPIKE_ATTEMPTS;
    expect(worstCaseTicks).toBe(30);
    expect(worstCaseTicks * 60).toBeLessThanOrEqual(60 * 60); // ≤ 1 h of ticks
  });
});
