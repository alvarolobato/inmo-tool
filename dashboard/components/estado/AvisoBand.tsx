"use client";

/**
 * "Avisos" — the active-problem strip on the Estado board (issue #642 P2).
 *
 * The last two things `/etl/salud` rendered that no other surface did, in the
 * only form that belongs on Estado: **is this true right now, and where do I
 * go**. Both are one line, both link out, and neither restates the rows they
 * link to.
 *
 *   - **Extensión bloqueada (#637).** An episode inside
 *     {@link ACTIVE_BLOCK_WINDOW_HOURS} means capture on that portal is paused
 *     waiting for a human. The EPISODE HISTORY is not here — it is Actividad's
 *     `bloqueo` rows (#706), where the chronology belongs; this is the state.
 *   - **Búsquedas sin resultados (D-092).** The per-scope list already renders
 *     on `/admin/fuentes/<name>` (#676), so this counts the affected sources
 *     and links there. It does NOT re-list the scopes: #702's hand-off claimed
 *     Fuentes did not cover them, and a re-read of the page showed it does.
 *
 * That split is the whole point of the band. #642 exists because the owner's
 * complaint was "solo has añadido, no has eliminado nada… quiero que unifiques
 * y elimines": an aviso that duplicated the detail it links to would be one
 * more copy, not one fewer.
 *
 * Reads `/api/etl/data-health` — the SAME aggregate `/etl/salud` read and
 * Fuentes/<name> still reads. Nothing is recomputed here, only re-displayed as
 * present state. Its own fetch, like `<QueueBand/>`: a slow or failing
 * six-query aggregate must never delay or blank the per-source rows.
 *
 * Renders NOTHING at all when there is nothing to say — including while
 * loading, and including when the read fails. That last one is deliberate and
 * worth being explicit about: this band cannot honestly say "no hay avisos"
 * after a failed read, and it must not, but it also must not push a red
 * "unknown" line above the board on every transient blip. The board's own
 * headline already carries the unknown-state message, and it is driven by a
 * read that shares the same database.
 */

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import {
  ACTIVE_BLOCK_WINDOW_HOURS,
  activeBlocksByPortal,
  extensionBlockNoticeEs,
  zeroResultsByConnector,
  type DataHealthResponse,
} from "@/lib/data-health";

const POLL_INTERVAL_MS = 60 * 1000;

interface Aviso {
  key: string;
  /** The source this is about — shown first, because it is what you scan for. */
  source: string;
  text: string;
  href: string;
  tone: "warn" | "alarm";
}

function relative(iso: string): string {
  const mins = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 2) return "hace un momento";
  if (mins < 60) return `hace ${mins} min`;
  const h = Math.floor(mins / 60);
  if (h < 24) return `hace ${h} h`;
  return `hace ${Math.floor(h / 24)} d`;
}

/**
 * Pure derivation, exported for its unit test: a data-health payload in,
 * the rendered aviso list out. `now` is injected so the block window can be
 * tested without faking the clock.
 */
export function avisosFrom(data: DataHealthResponse, now: number = Date.now()): Aviso[] {
  const avisos: Aviso[] = [];

  // Blocks first: capture is stopped until a human acts, which outranks a
  // search that quietly went empty.
  for (const [portal, ep] of activeBlocksByPortal(data.extension_blocks, now)) {
    avisos.push({
      key: `bloqueo:${portal}`,
      source: portal,
      // The D-047 vocabulary, unchanged from the page this replaces: a
      // detected block is a CLEAN stop the operator resolves, never a crash.
      text: `${extensionBlockNoticeEs(ep)} · ${relative(ep.detected_at)}`,
      href: `/admin/fuentes/${encodeURIComponent(portal)}`,
      tone: "alarm",
    });
  }

  for (const [connector, rows] of zeroResultsByConnector(data.zero_result_regressions)) {
    const worst = rows.reduce((a, b) => (b.consecutive_zeros > a.consecutive_zeros ? b : a));
    avisos.push({
      key: `zero:${connector}`,
      source: connector,
      text:
        rows.length === 1
          ? `una búsqueda lleva ${worst.consecutive_zeros} ejecuciones sin resultados`
          : `${rows.length} búsquedas sin resultados (hasta ${worst.consecutive_zeros} ejecuciones seguidas)`,
      href: `/admin/fuentes/${encodeURIComponent(connector)}`,
      tone: "warn",
    });
  }

  return avisos;
}

const TONE_COLOR: Record<Aviso["tone"], string> = {
  warn: "#d97706", // amber-600 — same vocabulary as the board's dots
  alarm: "#dc2626", // red-600
};

export function AvisoBand() {
  const [data, setData] = useState<DataHealthResponse | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/etl/data-health");
      if (!res.ok) return;
      setData((await res.json()) as DataHealthResponse);
    } catch {
      /* silent: see the header — a failed read renders nothing, not a lie */
    }
  }, []);

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [load]);

  if (data === null) return null;
  const avisos = avisosFrom(data);
  if (avisos.length === 0) return null;

  return (
    <section style={{ marginBottom: 16 }} data-testid="estado-avisos">
      <h2
        style={{
          fontSize: 12,
          fontWeight: 600,
          color: "var(--fg-muted)",
          marginBottom: 8,
          textTransform: "uppercase",
          letterSpacing: 0.4,
        }}
      >
        Avisos{" "}
        <span style={{ fontWeight: 400, textTransform: "none", letterSpacing: 0 }}>
          · bloqueos de las últimas {ACTIVE_BLOCK_WINDOW_HOURS} h y búsquedas vacías
        </span>
      </h2>
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {avisos.map((a) => (
          <Link
            key={a.key}
            href={a.href}
            data-testid={`estado-aviso-${a.key}`}
            data-tone={a.tone}
            style={{
              display: "flex",
              flexDirection: "column",
              gap: 2,
              // WCAG 2.5.5 / D-120: a full-width tap target on a phone.
              minHeight: 44,
              justifyContent: "center",
              padding: "8px 12px",
              borderRadius: 8,
              border: "1px solid var(--border)",
              borderLeft: `3px solid ${TONE_COLOR[a.tone]}`,
              background: "var(--bg-1)",
              textDecoration: "none",
              minWidth: 0,
            }}
          >
            <span style={{ fontSize: 13, fontWeight: 600, color: "var(--fg)" }}>{a.source}</span>
            <span style={{ fontSize: 12, color: TONE_COLOR[a.tone] }}>{a.text}</span>
          </Link>
        ))}
      </div>
    </section>
  );
}
