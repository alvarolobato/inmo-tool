// @vitest-environment node
/**
 * Unit tests for `lib/strip-nul-bytes.ts` — and specifically for
 * `stripNulBytesDeep`, added by the PR #675 review (B4).
 *
 * The bug: `POST /api/extension/diagnostic` sanitised `url`/`html`/`title`
 * but handed `detection`/`network` straight to `JSON.stringify` for two
 * `jsonb` columns. A captured page's network entries come from arbitrary
 * `responseText`, so a NUL in either block made Postgres reject the whole
 * INSERT and the owner's diagnostic was lost to a 500 — the same production
 * failure issue #207 / PR #563 closed for `text`, reopened for JSONB.
 *
 * The trap this file pins down is that the OBVIOUS fix does not work:
 * stripping the *serialised* JSON is a silent no-op, because
 * `JSON.stringify` escapes U+0000 instead of emitting it raw. The first test
 * below asserts that no-op explicitly, so nobody "simplifies"
 * `stripNulBytesDeep` back into a single `stripNulBytes(JSON.stringify(x))`
 * call and reintroduces the 500.
 */

import { describe, it, expect } from "vitest";
import { stripNulBytes, stripNulBytesDeep } from "@/lib/strip-nul-bytes";

// Built at runtime rather than typed as a literal, so this file itself stays
// free of a control character (and so the assertions can't be defeated by an
// editor silently dropping one).
const NUL = String.fromCharCode(0);
const REPLACEMENT = "�";

describe("stripNulBytes on serialised JSON — the no-op trap (PR #675 B4)", () => {
  it("does nothing, because JSON.stringify escapes the NUL rather than emitting it", () => {
    const serialised = JSON.stringify({ body: `a${NUL}b` });

    // The escape is six ASCII characters; there is no NUL byte left to find.
    expect(serialised).toContain("\\u0000");
    expect(serialised.includes(NUL)).toBe(false);
    expect(stripNulBytes(serialised)).toBe(serialised);

    // ...and Postgres still rejects that text for a jsonb column with
    // "unsupported Unicode escape sequence". Hence stripNulBytesDeep.
    expect(JSON.stringify(stripNulBytesDeep({ body: `a${NUL}b` }))).not.toContain("\\u0000");
  });
});

describe("stripNulBytesDeep", () => {
  it("replaces NUL with U+FFFD in a plain string", () => {
    expect(stripNulBytesDeep(`x${NUL}y`)).toBe(`x${REPLACEMENT}y`);
  });

  it("reaches nested object values, array elements, and object KEYS", () => {
    const input = {
      [`key${NUL}name`]: "plain",
      nested: { deep: [`a${NUL}`, { deeper: `${NUL}b` }] },
    };
    const out = stripNulBytesDeep(input) as Record<string, unknown>;

    expect(Object.keys(out)).toContain(`key${REPLACEMENT}name`);
    expect(Object.keys(out)).not.toContain(`key${NUL}name`);
    const nested = out.nested as { deep: [string, { deeper: string }] };
    expect(nested.deep[0]).toBe(`a${REPLACEMENT}`);
    expect(nested.deep[1].deeper).toBe(`${REPLACEMENT}b`);

    // The whole point: the serialised form is now jsonb-safe.
    expect(JSON.stringify(out)).not.toContain("\\u0000");
  });

  it("leaves non-string leaves (number/boolean/null/undefined) untouched and keeps shape", () => {
    const input = { n: 42, b: false, z: null, u: undefined, arr: [1, "ok", null] };
    expect(stripNulBytesDeep(input)).toEqual(input);
  });

  it("returns an equal value when there is nothing to strip", () => {
    const clean = { a: "no nulls here", b: ["nor", "here"] };
    expect(stripNulBytesDeep(clean)).toEqual(clean);
  });

  it("handles a realistic diagnostic network entry — a captured responseText", () => {
    const network = {
      entries: [
        {
          url: "https://realestate.hipoges.com/api/list",
          method: "GET",
          status: 200,
          body: `{"items":["a${NUL}b"]}`,
          bodyTruncated: false,
        },
      ],
      droppedCount: 0,
    };
    const out = stripNulBytesDeep(network);
    expect(out.entries[0].body).toBe(`{"items":["a${REPLACEMENT}b"]}`);
    expect(JSON.stringify(out)).not.toContain("\\u0000");
  });
});
