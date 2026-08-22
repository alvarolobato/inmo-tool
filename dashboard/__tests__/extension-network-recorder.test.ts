/**
 * Unit tests for browser-extension/network-recorder.js's pure
 * redaction/truncation/shaping helpers (issue #671 follow-up: opt-in
 * XHR/fetch capture for the "forzar captura + diagnóstico" reload flow).
 *
 * This is the SECURITY-CRITICAL half of network capture — it decides what
 * ever leaves the page at all — so it's tested in isolation from the
 * MAIN-world wiring (network-recorder-main.js), which needs a real
 * window/fetch/XMLHttpRequest and isn't unit-testable in-process the same
 * way content-script.js isn't (see extension-detect.test.ts's own note).
 *
 * D-033 ruled Cimenta2 not-buildable specifically because its only data path
 * over-exposed confidential/personal fields — "even scoped". These tests
 * exist to prove this module can't become that back door: credentials are
 * REMOVED (not masked-but-present), bodies are capped with truncation always
 * visible, and nothing here fabricates or replays a request.
 */

import { describe, it, expect } from "vitest";
import * as mod from "../../browser-extension/network-recorder.js";

const NR = (mod as unknown as { default?: Record<string, unknown> }).default ?? mod;

interface RedactResult {
  headers: Record<string, string>;
  redactedCount: number;
}
interface UrlRedactResult {
  url: string;
  redactedCount: number;
}
interface TruncateResult {
  body: string;
  truncated: boolean;
  originalLength: number;
}
interface SummarizedEntry {
  url: string;
  method: string;
  status: number | null;
  type: "fetch" | "xhr";
  requestHeaders: Record<string, string>;
  responseHeaders: Record<string, string>;
  redactedHeaderCount: number;
  redactedUrlPartCount: number;
  redactedBodyValueCount: number;
  body: string | null;
  bodyTruncated: boolean;
  bodyOriginalLength: number;
  bodyReadable: boolean;
  startedAtMs: number | null;
  finishedAtMs: number | null;
}

const api = NR as unknown as {
  MAX_BODY_BYTES: number;
  MAX_ENTRIES: number;
  redactHeaders: (headers: unknown) => RedactResult;
  redactUrl: (url: string) => UrlRedactResult;
  redactBodyText: (text: string) => { body: string; redactedCount: number };
  truncateBody: (text: string) => TruncateResult;
  summarizeEntry: (raw: Record<string, unknown>) => SummarizedEntry;
  capEntries: (entries: unknown[]) => { entries: unknown[]; droppedCount: number };
};

describe("redactHeaders — credential headers are REMOVED, not masked", () => {
  it("strips Authorization, Cookie, and Set-Cookie case-insensitively", () => {
    const result = api.redactHeaders([
      ["Authorization", "Bearer secret-token"],
      ["cookie", "session=abc123"],
      ["Set-Cookie", "session=abc123; HttpOnly"],
      ["Content-Type", "application/json"],
    ]);
    expect(result.headers).toEqual({ "Content-Type": "application/json" });
    expect(result.headers.Authorization).toBeUndefined();
    expect(result.redactedCount).toBe(3);
  });

  it("strips any header whose name LOOKS credential-shaped even under a portal-specific name", () => {
    const result = api.redactHeaders({
      "x-hipoges-session": "abc",
      "x-api-key": "def",
      "x-my-custom-token": "ghi",
      "x-request-id": "kept-1234",
    });
    expect(result.headers).toEqual({ "x-request-id": "kept-1234" });
    expect(result.redactedCount).toBe(3);
  });

  it("handles a plain object, an array of pairs, and null/undefined without throwing", () => {
    expect(api.redactHeaders(null).headers).toEqual({});
    expect(api.redactHeaders(undefined).headers).toEqual({});
    expect(api.redactHeaders({}).headers).toEqual({});
  });
});

describe("redactUrl — credential-shaped query params are removed, path/other params kept", () => {
  it("strips token/api_key/session params but keeps the rest of the URL intact", () => {
    const result = api.redactUrl(
      "https://realestate.hipoges.com/api/assets?token=SECRET123&page=2&api_key=abc",
    );
    expect(result.url).toContain("page=2");
    expect(result.url).not.toContain("SECRET123");
    expect(result.url).not.toContain("api_key");
    expect(result.redactedCount).toBe(2);
  });

  // #684: PR #675 matched param NAMES by exact string only, justified as
  // avoiding an "overzealous substring match" mangling the path. That
  // justification was wrong — `searchParams.forEach` iterates names and cannot
  // reach the path — so the rule bought nothing and missed password/jwt/…
  // Substring matching, aligned with the header path, and the path stays
  // intact anyway.
  it("matches param names by SUBSTRING now, and still cannot touch the path", () => {
    const result = api.redactUrl(
      "https://example.invalid/session-info?foo=bar&x_session_token=SECRET",
    );
    expect(result.url).toContain("/session-info");
    expect(result.url).toContain("foo=bar");
    expect(result.url).not.toContain("SECRET");
    expect(result.redactedCount).toBe(1);
  });

  it("strips password / jwt / code — the params PR #675's exact list missed", () => {
    for (const name of ["password", "pwd", "passwd", "jwt", "sid", "code", "state", "signature"]) {
      const result = api.redactUrl(`https://example.invalid/api?${name}=LEAKED&page=2`);
      expect(result.url, name).not.toContain("LEAKED");
      expect(result.url, name).toContain("page=2");
      expect(result.redactedCount, name).toBe(1);
    }
  });

  // Over-redaction is NOT free for a URL: it is the primary diagnostic signal.
  // The ambiguous English words stay exact-match so a Spanish portal's own
  // params survive.
  it("keeps a portal's legitimate params that merely CONTAIN an ambiguous word", () => {
    const result = api.redactUrl(
      "https://example.invalid/es/venta/pisos?provincia_code=41&estado=nuevo&monkey=1&design=x",
    );
    expect(result.redactedCount).toBe(0);
    expect(result.url).toContain("provincia_code=41");
    expect(result.url).toContain("estado=nuevo");
  });

  // #684: `redactUrl` used `url.searchParams`, which never touches `url.hash`,
  // so a fragment survived whole — including `#access_token=…`, which is
  // exactly the OAuth implicit-flow shape.
  it("strips credentials from a URL FRAGMENT, not just the query string", () => {
    const result = api.redactUrl(
      "https://example.invalid/callback#access_token=LEAKED&token_type=bearer&expires_in=3600",
    );
    expect(result.url).not.toContain("LEAKED");
    expect(result.redactedCount).toBeGreaterThanOrEqual(1);
  });

  it("keeps an SPA hash ROUTE while stripping the credential in its query half", () => {
    const result = api.redactUrl("https://example.invalid/app#/detalle/123?jwt=LEAKED&ref=abc");
    expect(result.url).toContain("#/detalle/123");
    expect(result.url).toContain("ref=abc");
    expect(result.url).not.toContain("LEAKED");
  });

  it("leaves an ordinary fragment byte-identical rather than round-tripping it", () => {
    const result = api.redactUrl("https://example.invalid/guia#/mapa/sevilla?zoom=12");
    expect(result.url).toBe("https://example.invalid/guia#/mapa/sevilla?zoom=12");
    expect(result.redactedCount).toBe(0);
  });

  // #684: tokens in PATH segments, `/api/v1/session/<jwt>/refresh`.
  it("strips a JWT path segment, and a long segment under a credential-shaped one", () => {
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJzeW50aGV0aWMifQ.c2lnbmF0dXJl";
    const withJwt = api.redactUrl(`https://example.invalid/api/v1/session/${jwt}/refresh`);
    expect(withJwt.url).not.toContain(jwt);
    expect(withJwt.url).toContain("/refresh");
    expect(withJwt.redactedCount).toBe(1);

    const underToken = api.redactUrl("https://example.invalid/api/token/AbCd1234EfGh5678/use");
    expect(underToken.url).not.toContain("AbCd1234EfGh5678");
    expect(underToken.redactedCount).toBe(1);
  });

  it("leaves an ordinary listing path alone — a slug or an id is the diagnostic", () => {
    const result = api.redactUrl(
      "https://example.invalid/es/venta/piso-en-sevilla-centro/98765432/detalle",
    );
    expect(result.url).toBe(
      "https://example.invalid/es/venta/piso-en-sevilla-centro/98765432/detalle",
    );
    expect(result.redactedCount).toBe(0);
  });

  it("an unparseable URL is returned unchanged, never throws", () => {
    const result = api.redactUrl("not a url");
    expect(result.url).toBe("not a url");
    expect(result.redactedCount).toBe(0);
  });
});

// #684 recorded this as the largest exposure surface with NO redaction at all.
// It is still not sanitised — a body is the payload the feature exists to show
// — but the three credential shapes that carry zero diagnostic value go.
describe("redactBodyText — best-effort, and honest about what it leaves behind", () => {
  it("redacts a JSON value under a credential-shaped key, at any nesting depth", () => {
    const result = api.redactBodyText(
      JSON.stringify({ access_token: "LEAKED", price: 185000, user: { password: "LEAKED2" } }),
    );
    expect(result.body).not.toContain("LEAKED");
    expect(result.body).toContain("185000");
    expect(result.redactedCount).toBe(2);
  });

  it("redacts a Bearer literal and a bare JWT", () => {
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJzeW50aGV0aWMifQ.c2lnbmF0dXJl";
    const result = api.redactBodyText(`Authorization: Bearer ${jwt}`);
    expect(result.body).not.toContain(jwt);
    expect(result.body).toContain("Bearer");
  });

  // The honest half: a body's ordinary content — including personal data the
  // portal returned — reaches extension_diagnostic.network intact. The bound
  // on that is purge_extension_diagnostics(), not this function.
  it("does NOT touch ordinary body content, personal or otherwise", () => {
    const body = JSON.stringify({ contacto: "Nombre Apellido", telefono: "600000000" });
    const result = api.redactBodyText(body);
    expect(result.body).toBe(body);
    expect(result.redactedCount).toBe(0);
  });

  it("a non-string input degrades to an empty body, never throws", () => {
    expect(api.redactBodyText(undefined as unknown as string).body).toBe("");
  });
});

describe("truncateBody — always reports truncation explicitly, never silently", () => {
  it("leaves a short body untouched", () => {
    const result = api.truncateBody("hello");
    expect(result).toEqual({ body: "hello", truncated: false, originalLength: 5 });
  });

  it("caps a long body at MAX_BODY_BYTES and reports the ORIGINAL length", () => {
    const long = "x".repeat(api.MAX_BODY_BYTES + 500);
    const result = api.truncateBody(long);
    expect(result.body.length).toBe(api.MAX_BODY_BYTES);
    expect(result.truncated).toBe(true);
    expect(result.originalLength).toBe(api.MAX_BODY_BYTES + 500);
  });

  it("a non-string input degrades to an empty body, never throws", () => {
    expect(api.truncateBody(undefined as unknown as string)).toEqual({
      body: "",
      truncated: false,
      originalLength: 0,
    });
  });
});

describe("summarizeEntry — the full redact+truncate+shape pipeline", () => {
  it("redacts headers/query params and truncates the body in one pass", () => {
    const entry = api.summarizeEntry({
      url: "https://realestate.hipoges.com/api/assets?token=SECRET",
      method: "get",
      status: 200,
      type: "fetch",
      requestHeaders: [["Authorization", "Bearer x"], ["Accept", "application/json"]],
      responseHeaders: [["Set-Cookie", "s=1"], ["Content-Type", "application/json"]],
      body: JSON.stringify({ listings: [1, 2, 3] }),
      bodyReadable: true,
      startedAtMs: 100,
      finishedAtMs: 900,
    });

    expect(entry.method).toBe("GET");
    expect(entry.url).not.toContain("SECRET");
    expect(entry.requestHeaders.Authorization).toBeUndefined();
    expect(entry.requestHeaders.Accept).toBe("application/json");
    expect(entry.responseHeaders["Set-Cookie"]).toBeUndefined();
    expect(entry.redactedHeaderCount).toBe(2);
    expect(entry.redactedUrlPartCount).toBe(1);
    expect(entry.bodyTruncated).toBe(false);
    expect(entry.body).toContain("listings");
    expect(entry.startedAtMs).toBe(100);
    expect(entry.finishedAtMs).toBe(900);
  });

  it("an unreadable body (e.g. an XHR blob response) is recorded as null, never guessed at", () => {
    const entry = api.summarizeEntry({
      url: "https://example.com/photo.jpg",
      method: "GET",
      status: 200,
      type: "xhr",
      requestHeaders: [],
      responseHeaders: [],
      bodyReadable: false,
      startedAtMs: 0,
      finishedAtMs: 50,
    });
    expect(entry.body).toBeNull();
    expect(entry.bodyReadable).toBe(false);
    expect(entry.bodyTruncated).toBe(false);
  });

  it("a missing/malformed raw entry degrades to safe defaults, never throws", () => {
    const entry = api.summarizeEntry({});
    expect(entry.method).toBe("GET");
    expect(entry.status).toBeNull();
    expect(entry.url).toBe("undefined");
  });
});

describe("capEntries — keeps the MOST RECENT entries, drops the oldest, reports the drop", () => {
  it("keeps every entry when under the cap", () => {
    const entries = [1, 2, 3];
    const result = api.capEntries(entries);
    expect(result.entries).toEqual([1, 2, 3]);
    expect(result.droppedCount).toBe(0);
  });

  it("drops the OLDEST entries once over MAX_ENTRIES, never silently", () => {
    const entries = Array.from({ length: api.MAX_ENTRIES + 10 }, (_, i) => i);
    const result = api.capEntries(entries);
    expect(result.entries.length).toBe(api.MAX_ENTRIES);
    // The kept entries are the LAST MAX_ENTRIES (most recent), i.e. dropped
    // the first 10.
    expect(result.entries[0]).toBe(10);
    expect(result.droppedCount).toBe(10);
  });
});
