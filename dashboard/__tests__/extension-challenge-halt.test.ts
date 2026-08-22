// @vitest-environment jsdom
/**
 * Issue #692 — the anti-bot CHALLENGE page must be detected as a soft block,
 * halt the batch, and consume nothing.
 *
 * Imports the REAL extension modules (detect.js / batch.js), same pattern as
 * extension-block-detect.test.ts.
 *
 * Every fixture here is SYNTHETIC — the phrasing is the portal's own
 * boilerplate chrome, reconstructed from the operator's description; no
 * scraped listing content, no real IP address, no per-visit challenge UUID
 * (public repo). Where the real page renders those, the fixtures use
 * RFC-5737 documentation addresses and an all-zero UUID.
 */

import { describe, it, expect, beforeEach } from "vitest";
import * as detectMod from "../../browser-extension/detect.js";
import * as batchMod from "../../browser-extension/batch.js";

const D = (detectMod as unknown as { default?: Record<string, unknown> }).default
  ?? detectMod;
const B = (batchMod as unknown as { default?: Record<string, unknown> }).default
  ?? batchMod;

const { detectBlockSignals, isRenderReady, challengePhraseHits, CHALLENGE_PHRASES } =
  D as {
    detectBlockSignals: (d: Document, p?: string | null) => {
      blocked: boolean;
      signature: string | null;
    };
    isRenderReady: (d: Document, p?: string | null) => boolean;
    challengePhraseHits: (d: Document) => number;
    CHALLENGE_PHRASES: string[];
  };

const { makeBatchState, launchNext, pauseForBlock, recordResultAt, resume,
        firstPendingIndex, progress } = B as any;

/**
 * The challenge idealista serves AT THE LISTING URL during a fast drain.
 * Reconstructed structure + boilerplate wording only.
 */
const CHALLENGE_HTML = `
  <main>
    <h1>¡Vaya! parece que estamos recibiendo muchas peticiones tuyas en poco tiempo</h1>
    <p>Desliza hacia la derecha para asegurar tu acceso</p>
    <div class="slider" role="slider"><span>Desliza</span></div>
    <h2>¿Por qué esta verificación?</h2>
    <p>Algo sobre el comportamiento del navegador nos ha intrigado.</p>
    <p>Varias posibilidades:</p>
    <ul>
      <li>usted navega y hace clic a una velocidad sobrehumana</li>
      <li>algo bloquea el funcionamiento de JavaScript en su navegador</li>
      <li>un robot se encuentra en la misma red (IP 203.0.113.7) que usted</li>
    </ul>
    <p>Un saludo, El equipo de idealista</p>
    <p>ID: 00000000-0000-4000-8000-000000000000</p>
  </main>`;

/** A healthy advert — long enough to be render-ready, with real detail markup. */
const REAL_ADVERT_HTML = `
  <main>
    <h1 class="main-info__title-main">Piso en venta en calle Inventada</h1>
    <div class="info-data-price">180.000 €</div>
    <div class="adCommentsLanguage">
      Vivienda exterior muy luminosa con tres dormitorios y dos baños completos.
      Reformada íntegramente, suelos de tarima, ventanas con doble
      acristalamiento y climatización por conductos. La finca dispone de
      ascensor y portal reformado. Zona muy bien comunicada, con transporte
      público, colegios y comercios a pocos minutos andando. Se entrega libre
      de cargas y de inquilinos, lista para entrar a vivir desde el primer día.
      Posibilidad de plaza de garaje en el mismo edificio por precio aparte.
    </div>
    <div class="details-property_features"><ul><li>83 m²</li><li>3 hab.</li></ul></div>
  </main>`;

/** jsdom leaves readyState 'loading'; a content script only ever runs later. */
function renderAsBrowser(html: string): Document {
  document.body.innerHTML = html;
  Object.defineProperty(document, "readyState", {
    value: "complete",
    configurable: true,
  });
  return document;
}

beforeEach(() => {
  document.head.innerHTML = "";
  document.body.innerHTML = "";
  document.title = "";
});

describe("challenge detection (detect.js)", () => {
  it("REGRESSION: the challenge page reads as render-ready, which is why the old detector missed it", () => {
    const doc = renderAsBrowser(CHALLENGE_HTML);
    // This is the whole bug in one assertion. The page has ~490 chars of
    // prose under a <main>, so both of isRenderReady's tests pass and the
    // pre-#692 corroboration (`if (isRenderReady) continue`) discarded every
    // marker on it — including a correctly-matched DataDome one.
    expect(isRenderReady(doc, "idealista")).toBe(true);
    expect((doc.body.textContent || "").trim().length).toBeGreaterThan(400);
    // Detected anyway, because the signature is self-corroborated.
    expect(detectBlockSignals(doc, "idealista")).toEqual({
      blocked: true,
      signature: "rate_limit_challenge",
    });
  });

  it("detects the challenge even with no vendor asset on the page at all", () => {
    // No captcha-delivery.com / Cloudflare / Incapsula marker — text only.
    const doc = renderAsBrowser(CHALLENGE_HTML);
    expect(doc.querySelector("script[src*='captcha-delivery.com']")).toBeNull();
    expect(detectBlockSignals(doc, "idealista").signature).toBe("rate_limit_challenge");
  });

  it("detects it on a portal with no configured readySelectors", () => {
    const doc = renderAsBrowser(CHALLENGE_HTML);
    expect(detectBlockSignals(doc, null).blocked).toBe(true);
  });

  it("needs TWO distinct phrases — one alone is not a block", () => {
    const doc = renderAsBrowser(
      `<main><h1>Piso en venta</h1><p>Se vende en poco tiempo, no lo dejes pasar.</p></main>`,
    );
    expect(challengePhraseHits(doc)).toBe(1);
    expect(detectBlockSignals(doc, "idealista").blocked).toBe(false);
  });

  it("a healthy advert is never a challenge", () => {
    const doc = renderAsBrowser(REAL_ADVERT_HTML);
    expect(challengePhraseHits(doc)).toBe(0);
    expect(detectBlockSignals(doc, "idealista").blocked).toBe(false);
  });

  it("an advert whose description quotes the challenge wording stays alive", () => {
    // Self-corroboration means no isRenderReady veto, so this false-positive
    // route has to be closed by the two-phrase threshold alone. One quoted
    // phrase inside otherwise-real advert copy must not block.
    const doc = renderAsBrowser(
      REAL_ADVERT_HTML.replace(
        "Vivienda exterior",
        "Si la web te pide desliza hacia la derecha, vuelve más tarde. Vivienda exterior",
      ),
    );
    expect(challengePhraseHits(doc)).toBe(1);
    expect(detectBlockSignals(doc, "idealista").blocked).toBe(false);
  });

  it("ignores the phrases when they only appear inside <script>", () => {
    const doc = renderAsBrowser(
      REAL_ADVERT_HTML +
        `<script>var msgs = {a:"muchas peticiones", b:"desliza hacia la derecha"};</script>`,
    );
    expect(challengePhraseHits(doc)).toBe(0);
    expect(detectBlockSignals(doc, "idealista").blocked).toBe(false);
  });

  it("folds accents and case", () => {
    const doc = renderAsBrowser(
      `<main><p>MUCHAS PETICIONES</p><p>¿POR QUÉ ESTA VERIFICACIÓN?</p></main>`,
    );
    expect(challengePhraseHits(doc)).toBe(2);
    expect(detectBlockSignals(doc, "idealista").blocked).toBe(true);
  });

  it("keys on nothing per-visit — the IP and the challenge UUID are not signatures", () => {
    for (const phrase of CHALLENGE_PHRASES) {
      expect(phrase).not.toMatch(/\d+\.\d+\.\d+\.\d+/);
      expect(phrase).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}/i);
      expect(phrase).not.toMatch(/\bid\s*:/);
    }
    // Same page, different visitor: same verdict.
    const a = detectBlockSignals(renderAsBrowser(CHALLENGE_HTML), "idealista");
    document.body.innerHTML = "";
    const b = detectBlockSignals(
      renderAsBrowser(
        CHALLENGE_HTML.replace("203.0.113.7", "198.51.100.42").replace(
          "00000000-0000-4000-8000-000000000000",
          "11111111-2222-4333-8444-555555555555",
        ),
      ),
      "idealista",
    );
    expect(a).toEqual(b);
  });
});

describe("the batch halts and consumes nothing (batch.js pauseForBlock)", () => {
  const URLS = ["u0", "u1", "u2", "u3", "u4"];

  it("stops advancing, and the in-flight pages go back to pending", () => {
    let s = makeBatchState(URLS, 3, undefined, "idealista");
    // Three tabs in flight, all about to meet the same wall.
    s = launchNext(s).state;
    s = launchNext(s).state;
    s = launchNext(s).state;
    expect(s.slots.filter((x: string) => x === "inflight")).toHaveLength(3);

    s = pauseForBlock(s);

    expect(s.status).toBe("paused");
    // Nothing consumed: no slot became captured or failed.
    expect(s.slots.filter((x: string) => x === "inflight")).toHaveLength(0);
    expect(s.slots).toEqual(["pending", "pending", "pending", "pending", "pending"]);
    // And the driver may not open another page.
    expect(launchNext(s).index).toBe(-1);
  });

  it("the late capture-signal timeout cannot re-consume a reset slot", () => {
    let s = makeBatchState(URLS, 2, undefined, "idealista");
    const first = launchNext(s);
    s = first.state;
    s = pauseForBlock(s);
    // waitForCaptureSignal times out ~30s later and driveOnePage records a
    // failure against the slot it launched. recordResultAt must ignore it.
    const after = recordResultAt(s, first.index, false);
    expect(after.slots[first.index]).toBe("pending");
    expect(progress(after).failed).toBe(0);
  });

  it("resuming after the owner clears the wall restarts at the same page", () => {
    let s = makeBatchState(URLS, 2, undefined, "idealista");
    s = launchNext(s).state; // index 0
    s = recordResultAt(s, 0, true); // captured for real, before the wall
    const second = launchNext(s); // index 1 — this one hits the wall
    s = pauseForBlock(second.state);

    expect(s.slots[0]).toBe("captured"); // real work is kept
    expect(firstPendingIndex(s)).toBe(1); // position preserved

    s = resume(s);
    expect(s.status).toBe("running");
    expect(launchNext(s).index).toBe(1); // resumes exactly where it stopped
    expect(progress(s).done).toBe(1); // 4 still to do, none skipped
  });

  it("is idempotent — a repeat detection on an already-paused queue changes nothing", () => {
    let s = makeBatchState(URLS, 2, undefined, "idealista");
    s = launchNext(s).state;
    const once = pauseForBlock(s);
    const twice = pauseForBlock(once);
    expect(twice).toEqual(once);
  });

  it("resume completes a queue with nothing left, rather than re-running it", () => {
    let s = makeBatchState(["only"], 1, undefined, "idealista");
    s = launchNext(s).state;
    s = recordResultAt(s, 0, true);
    expect(s.status).toBe("done");
  });
});
