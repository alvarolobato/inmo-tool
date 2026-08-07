/**
 * Digest email — unit tests (issue #35, Phase 5.5 v1).
 *
 * Covers rendering (the three distinct sections, HTML escaping), SMTP config
 * loading + the "configured?" / recipient-resolution rules, and the three
 * `sendDigestEmail` outcomes: the no-SMTP no-op, the no-recipient no-op, and a
 * real send (with nodemailer mocked) — plus the never-throws transport-failure
 * path.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const getSystemConfig = vi.fn<() => Record<string, { value: unknown }>>(() => ({}));
vi.mock("@/lib/system-config/loader", () => ({ getSystemConfig: () => getSystemConfig() }));

const sendMail = vi.fn(async () => ({ messageId: "1" }));
const createTransport = vi.fn(() => ({ sendMail }));
vi.mock("nodemailer", () => ({ createTransport: (o: unknown) => createTransport(o), default: { createTransport: (o: unknown) => createTransport(o) } }));

import {
  renderDigestEmail,
  loadSmtpConfig,
  isSmtpConfigured,
  resolveRecipient,
  sendDigestEmail,
} from "../email";
import type { DigestContent } from "../digest";

function content(overrides: Partial<DigestContent> = {}): DigestContent {
  return {
    profileId: 1,
    profileName: "Madrid",
    since: "2026-08-04T00:00:00.000Z",
    generatedAt: "2026-08-05T07:00:00.000Z",
    seguimientoDrops: [],
    relistedLower: [],
    newCandidates: [
      {
        propertyId: 1,
        zone: "Centro <b>",
        propertyType: "piso",
        price: 100000,
        m2: 80,
        pricePerM2: 1250,
        sources: ["idealista"],
        url: "https://x/1?a=1&b=2",
        score: 0.5,
        scoreKind: "trained",
        flags: [{ kind: "caveat:tenanted", label: "Alquilado", tone: "warn" }],
        redFlags: ["Embargo"],
        belowMarketPct: 0.23,
      },
    ],
    priceDrops: [
      { propertyId: 2, zone: "Salamanca", source: "fotocasa", url: "https://x/2", oldPrice: 250000, newPrice: 225000, dropPct: 0.1, observedAt: "t" },
    ],
    statusChanges: [
      { propertyId: 3, zone: "Retiro", source: "idealista", url: null, status: "sold", observedAt: "t" },
    ],
    ...overrides,
  };
}

beforeEach(() => {
  getSystemConfig.mockReturnValue({});
  vi.unstubAllEnvs();
  sendMail.mockClear();
  createTransport.mockClear();
});

describe("renderDigestEmail", () => {
  it("renders three distinctly-headed sections with counts", () => {
    const { subject, text, html } = renderDigestEmail(content());
    expect(subject).toContain("1 nuevas");
    expect(subject).toContain("1 bajadas");
    expect(subject).toContain("1 cambios");
    expect(text).toContain("NUEVOS CANDIDATOS (1)");
    expect(text).toContain("BAJADAS DE PRECIO (1)");
    expect(text).toContain("CAMBIOS DE ESTADO (1)");
    expect(text).toContain("23% bajo mercado");
    expect(text).toContain("Embargo");
    expect(text).toContain("Vendido");
    expect(html).toContain("<h3>Nuevos candidatos (1)</h3>");
  });

  it("escapes HTML in zone/url and omits empty sections", () => {
    const c = content({ priceDrops: [], statusChanges: [] });
    const { html, text } = renderDigestEmail(c);
    expect(html).toContain("Centro &lt;b&gt;");
    expect(html).toContain("a=1&amp;b=2");
    expect(html).not.toContain("Bajadas de precio");
    expect(text).not.toContain("BAJADAS DE PRECIO");
  });

  it("#428: renders the 'En seguimiento' section at the TOP and in the subject", () => {
    const c = content({
      seguimientoDrops: [
        { propertyId: 9, zone: "Triana", source: "idealista", url: "https://x/9", oldPrice: 300000, newPrice: 274200, dropPct: 0.086, observedAt: "t" },
      ],
    });
    const { subject, text, html } = renderDigestEmail(c);
    expect(subject).toContain("1 en seguimiento");
    expect(text).toContain("EN SEGUIMIENTO — BAJADAS (1)");
    // The seguimiento heading precedes the generic "Nuevos candidatos" one.
    expect(html.indexOf("En seguimiento — bajadas")).toBeLessThan(html.indexOf("Nuevos candidatos"));
  });

  it("#428 (EC-4): renders the 'Rebajas tras retirada' relisted-lower section", () => {
    const c = content({
      relistedLower: [
        { propertyId: 12, zone: "Nervión", withdrawnPrice: 200000, relistedPrice: 170000, dropPct: 0.15, withdrawnAt: "a", relistedAt: "b" },
      ],
    });
    const { subject, text, html } = renderDigestEmail(c);
    expect(subject).toContain("1 rebajas tras retirada");
    expect(text).toContain("REBAJAS TRAS RETIRADA (1)");
    expect(html).toContain("Rebajas tras retirada (1)");
  });
});

describe("loadSmtpConfig / isSmtpConfigured / resolveRecipient", () => {
  it("reads env with defaults for port/secure", () => {
    vi.stubEnv("NOTIFICATIONS_SMTP_HOST", "smtp.x");
    vi.stubEnv("NOTIFICATIONS_SMTP_FROM", "a@x");
    const cfg = loadSmtpConfig();
    expect(cfg.host).toBe("smtp.x");
    expect(cfg.port).toBe(587);
    expect(cfg.secure).toBe(false);
    expect(isSmtpConfigured(cfg)).toBe(true);
  });

  it("is not configured without host or from", () => {
    expect(isSmtpConfigured({ ...loadSmtpConfig(), host: null, from: "a@x" })).toBe(false);
    expect(isSmtpConfigured({ ...loadSmtpConfig(), host: "smtp.x", from: null })).toBe(false);
  });

  it("prefers the profile's own email, else the global default", () => {
    const cfg = { ...loadSmtpConfig(), defaultTo: "global@x" };
    expect(resolveRecipient(cfg, "profile@x")).toBe("profile@x");
    expect(resolveRecipient(cfg, "   ")).toBe("global@x");
    expect(resolveRecipient(cfg, null)).toBe("global@x");
  });
});

describe("sendDigestEmail", () => {
  it("is a no-op when SMTP is not configured", async () => {
    const r = await sendDigestEmail(content());
    expect(r).toEqual({ sent: false, reason: "smtp-not-configured" });
    expect(createTransport).not.toHaveBeenCalled();
  });

  it("is a no-op when configured but no recipient resolves", async () => {
    vi.stubEnv("NOTIFICATIONS_SMTP_HOST", "smtp.x");
    vi.stubEnv("NOTIFICATIONS_SMTP_FROM", "a@x");
    const r = await sendDigestEmail(content(), { to: null });
    expect(r.sent).toBe(false);
    expect(r.reason).toBe("no-recipient");
  });

  it("sends via nodemailer when configured and a recipient resolves", async () => {
    vi.stubEnv("NOTIFICATIONS_SMTP_HOST", "smtp.x");
    vi.stubEnv("NOTIFICATIONS_SMTP_FROM", "inmo <a@x>");
    vi.stubEnv("NOTIFICATIONS_SMTP_USER", "u");
    vi.stubEnv("NOTIFICATIONS_SMTP_PASSWORD", "p");
    const r = await sendDigestEmail(content(), { to: "investor@x" });
    expect(r).toEqual({ sent: true, recipient: "investor@x" });
    expect(createTransport).toHaveBeenCalledOnce();
    expect(sendMail).toHaveBeenCalledOnce();
    const msg = sendMail.mock.calls[0][0] as { to: string; from: string; subject: string };
    expect(msg.to).toBe("investor@x");
    expect(msg.from).toBe("inmo <a@x>");
  });

  it("never throws on a transport failure — folds it into the result", async () => {
    vi.stubEnv("NOTIFICATIONS_SMTP_HOST", "smtp.x");
    vi.stubEnv("NOTIFICATIONS_SMTP_FROM", "a@x");
    sendMail.mockRejectedValueOnce(new Error("connection refused"));
    const r = await sendDigestEmail(content(), { to: "investor@x" });
    expect(r).toEqual({ sent: false, reason: "send-failed", recipient: "investor@x" });
  });
});
