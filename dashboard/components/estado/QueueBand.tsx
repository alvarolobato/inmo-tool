"use client";

/**
 * "Colas" — the queue band on the Estado board (issue #640, part of #636).
 *
 * The owner asked for queues in his own words ("quiero saber también colas"),
 * and then, three days running: *what is queued right now and is it growing?
 * is anything stalled?* This band answers exactly that and stops — one
 * compact tile per backlog: how many, which way it is moving, how old the
 * oldest item is, and a tap through to the surface where the work is done.
 *
 * ## Why this is a glance and not a page
 *
 * The standing complaint on #636 is "solo has añadido, no has eliminado
 * nada… quiero que unifiques". So every tile that has a work surface LINKS to
 * it and shows nothing that surface already shows: the per-portal capture
 * breakdown stays on `/admin/fuentes` (PR #676 put a queue-depth chip on
 * every source row there), the merge pairs stay on `/admin/dedup`, the
 * assessment coverage/cost panel stays on `/admin/llm`. No tile is a second
 * copy of anything.
 *
 * ## Rendering rules that exist to keep it honest
 *
 * - A `null` depth is NEVER drawn as 0. It renders either the tile's own
 *   `headline` (the dedup pass, whose signal is an age, not a count) or the
 *   `unmeasured` reason ("sweep en curso").
 * - The trend chip only appears when there IS a depth to have a trend about.
 * - "sin medir" is a real, rendered state — see lib/queues.ts.
 *
 * Fetches `/api/etl/queues` independently of the board's own
 * `/api/etl/source-health` read, so a slow or failing queue aggregation can
 * never delay or blank the per-source rows above it.
 *
 * Mobile-first (D-120/D-121/D-124): the grid lives in globals.css as
 * `.queue-band-grid` — an `auto-fill` track list that resolves to two columns
 * at 390px with no media query and no breakpoint-varying inline style.
 */

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import type { QueuesResponse, QueueSeverity, QueueTile } from "@/lib/queues";
import { TREND_LABEL, formatDepth, formatEta } from "@/lib/queues";

const POLL_INTERVAL_MS = 60 * 1000;

// Same three-step vocabulary the board's own status dots use (#638): green is
// "nothing to do here", amber "look at this", red "this is broken".
const SEVERITY_COLOR: Record<QueueSeverity, string> = {
  ok: "var(--fg-muted)",
  warn: "#d97706", // amber-600
  alarm: "#dc2626", // red-600
};

function ageText(hours: number | null): string | null {
  if (hours === null) return null;
  if (hours < 1) return `${Math.max(1, Math.round(hours * 60))} min`;
  if (hours < 48) return `${Math.round(hours)} h`;
  return `${Math.round(hours / 24)} d`;
}

function TileBody({ tile }: { tile: QueueTile }) {
  const depthText = formatDepth(tile.depth);
  // Precedence is deliberate: a real count first, then a tile whose signal
  // genuinely isn't a count, then an explicit "not measurable" reason. There
  // is no branch that renders 0 for an absent number.
  const big = depthText ?? tile.headline ?? tile.unmeasured ?? "sin datos";
  const isNumber = depthText !== null;
  const eta = formatEta(tile.etaHours);
  // Only meaningful next to a depth. When the tile's headline IS an age (the
  // dedup pass), repeating it as "más antiguo 20 h" says the same thing twice.
  const oldest = tile.depth === null ? null : ageText(tile.oldestAgeHours);

  return (
    <>
      <span
        style={{
          fontSize: 11,
          fontWeight: 600,
          color: "var(--fg-muted)",
          textTransform: "uppercase",
          letterSpacing: 0.3,
          lineHeight: 1.25,
        }}
      >
        {tile.label}
      </span>
      <span
        data-testid={`queue-depth-${tile.key}`}
        style={{
          fontSize: isNumber ? 22 : 13,
          fontWeight: 700,
          lineHeight: 1.2,
          color: tile.severity === "ok" ? "var(--fg)" : SEVERITY_COLOR[tile.severity],
        }}
      >
        {big}
      </span>
      {tile.depth !== null && (
        <span
          data-testid={`queue-trend-${tile.key}`}
          data-trend={tile.trend}
          style={{ fontSize: 11, color: SEVERITY_COLOR[tile.severity] }}
        >
          {TREND_LABEL[tile.trend]}
          {/* The window is stated once, in the band heading — repeating
              "24 h" on seven tiles cost a whole extra line on a phone. */}
          {tile.inflow24h !== null && tile.outflow24h !== null
            ? ` · +${tile.inflow24h} / −${tile.outflow24h}`
            : tile.outflow24h !== null
              ? ` · −${tile.outflow24h}`
              : ""}
        </span>
      )}
      {(oldest || eta || tile.note) && (
        <span
          data-testid={`queue-meta-${tile.key}`}
          style={{ fontSize: 11, color: "var(--fg-muted)", lineHeight: 1.3 }}
        >
          {[oldest ? `más antiguo ${oldest}` : null, eta, tile.note]
            .filter(Boolean)
            .join(" · ")}
        </span>
      )}
    </>
  );
}

export function QueueBand() {
  const [data, setData] = useState<QueuesResponse | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/etl/queues");
      if (!res.ok) {
        setLoadFailed(true);
        return;
      }
      setData((await res.json()) as QueuesResponse);
      setLoadFailed(false);
    } catch {
      setLoadFailed(true);
    }
  }, []);

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [load]);

  // `queues: []` with `ok: false` is UNKNOWN, not "nothing queued" — the same
  // trap #638's review found on the board above (a DB error rendered as a
  // confident "no hay fuentes"). Both failure shapes collapse to one message.
  const unknown = loadFailed || (data !== null && !data.ok);

  return (
    <section style={{ marginTop: 20 }} data-testid="estado-queues">
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
        Colas{" "}
        <span style={{ fontWeight: 400, textTransform: "none", letterSpacing: 0 }}>
          · flujo de las últimas 24 h
        </span>
      </h2>
      {unknown ? (
        <p style={{ fontSize: 13, color: "var(--fg-muted)" }} data-testid="estado-queues-unknown">
          Estado de las colas desconocido
        </p>
      ) : data === null ? (
        <p style={{ fontSize: 13, color: "var(--fg-muted)" }}>Cargando…</p>
      ) : (
        <div className="queue-band-grid">
          {data.queues.map((tile) => {
            const style = {
              display: "flex",
              flexDirection: "column" as const,
              gap: 2,
              padding: "10px 12px",
              minHeight: 44,
              borderRadius: 8,
              border: "1px solid var(--border)",
              borderLeft: `3px solid ${
                tile.severity === "ok" ? "var(--border)" : SEVERITY_COLOR[tile.severity]
              }`,
              background: "var(--bg-1)",
              textDecoration: "none",
              minWidth: 0,
            };
            return tile.href ? (
              <Link
                key={tile.key}
                href={tile.href}
                data-testid={`queue-tile-${tile.key}`}
                data-severity={tile.severity}
                style={style}
              >
                <TileBody tile={tile} />
              </Link>
            ) : (
              <div
                key={tile.key}
                data-testid={`queue-tile-${tile.key}`}
                data-severity={tile.severity}
                style={style}
              >
                <TileBody tile={tile} />
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
