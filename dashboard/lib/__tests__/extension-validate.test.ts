import { describe, it, expect } from "vitest";
import {
  VALIDATE_SIGNAL,
  withValidateSignal,
  validateSignalPayload as buildPayloadString,
} from "@/lib/extension-validate";
import * as detectMod from "../../../browser-extension/detect.js";

/**
 * The dashboard's "Abrir" on the Validar filtros page opens a portal search URL
 * tagged with the validation-mode signal (issue #478 P3). These tests lock the
 * tagging contract the extension's detect.js `validateSignalPayload` /
 * `stripValidateSignal` rely on — the two run in DIFFERENT processes (dashboard
 * TS vs shipped extension JS), so a round-trip test across BOTH modules is the
 * only guard that the byte-for-byte contract holds.
 */

// detect.js publishes via `module.exports = api`; accept default or spread.
const D = (detectMod as unknown as { default?: Record<string, unknown> }).default ?? detectMod;
const { validateSignalPayload, validateSignalPresent, stripValidateSignal } = D as {
  validateSignalPayload: (u: string) => { profileId: number; connector: string } | null;
  validateSignalPresent: (u: string) => boolean;
  stripValidateSignal: (u: string) => string;
};

const BASE = "https://www.idealista.com/venta-viviendas/sevilla-sevilla/";

describe("withValidateSignal — tag an opened search URL for validation mode", () => {
  it("adds the #inmo-validate=<pid>:<connector> fragment when the URL has none", () => {
    expect(withValidateSignal(BASE, 42, "idealista")).toBe(
      `${BASE}#${VALIDATE_SIGNAL}=42:idealista`,
    );
  });

  it("adds the fragment alongside an existing query string", () => {
    const out = withValidateSignal(
      "https://www.alisedainmobiliaria.com/comprar?precioMax=200000",
      7,
      "aliseda",
    );
    expect(out).toBe(
      `https://www.alisedainmobiliaria.com/comprar?precioMax=200000#${VALIDATE_SIGNAL}=7:aliseda`,
    );
  });

  it("falls back to a query key when the URL already carries a fragment (never clobbers it)", () => {
    const out = withValidateSignal(`${BASE}#existing`, 3, "idealista");
    const u = new URL(out);
    expect(u.hash).toBe("#existing");
    expect(u.searchParams.get(VALIDATE_SIGNAL)).toBe("3:idealista");
  });

  it("is idempotent — tagging an already-tagged URL doesn't double up", () => {
    const once = withValidateSignal(BASE, 42, "idealista");
    expect(withValidateSignal(once, 99, "aliseda")).toBe(once);
  });

  it("returns the input unchanged for an unparseable URL (never breaks it)", () => {
    expect(withValidateSignal("not a url", 1, "idealista")).toBe("not a url");
    expect(withValidateSignal("", 1, "idealista")).toBe("");
  });

  it("builds the plain payload string", () => {
    expect(buildPayloadString(5, "altamira")).toBe("5:altamira");
  });
});

describe("round-trip: withValidateSignal (dashboard) → detect.js (extension)", () => {
  it("parses back the exact profileId + connector from the fragment form", () => {
    const tagged = withValidateSignal(BASE, 42, "idealista");
    expect(validateSignalPresent(tagged)).toBe(true);
    expect(validateSignalPayload(tagged)).toEqual({ profileId: 42, connector: "idealista" });
  });

  it("parses back the payload from the query fallback form", () => {
    const tagged = withValidateSignal(`${BASE}#existing`, 7, "aliseda");
    expect(validateSignalPayload(tagged)).toEqual({ profileId: 7, connector: "aliseda" });
  });

  it("stripping a tagged URL yields the original URL — signal is NEVER persisted", () => {
    const tagged = withValidateSignal(BASE, 42, "idealista");
    const stripped = stripValidateSignal(tagged);
    expect(validateSignalPresent(stripped)).toBe(false);
    expect(stripped).toBe(BASE);
  });

  it("stripping the query-fallback form preserves the owner's own fragment", () => {
    const tagged = withValidateSignal(`${BASE}#existing`, 7, "aliseda");
    const stripped = stripValidateSignal(tagged);
    expect(validateSignalPresent(stripped)).toBe(false);
    expect(stripped).toBe(`${BASE}#existing`);
    expect(new URL(stripped).searchParams.has(VALIDATE_SIGNAL)).toBe(false);
  });
});
