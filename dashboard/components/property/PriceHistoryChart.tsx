import { Card, LineChart } from "@tremor/react";
import type { PriceHistoryPoint, StatusEventPoint } from "@/lib/property-detail";
import { fmtEUR0 } from "@/components/widgets/format";
import { STATUS_LABELS } from "@/lib/listing-status-labels";

/**
 * Combined price/status history for the property detail page (task 2.8,
 * #44, EC-1): one chart spanning every linked listing's
 * listing_price_history, so a property relisted at a lower price on a
 * different site reads as one continuous story, not two disconnected
 * per-listing charts. Status transitions (active/withdrawn/sold/...) don't
 * fit a numeric line chart cleanly, so they're listed as a timeline below
 * the chart instead of plotted as a line series.
 *
 * One category (line) per source site. Rows are keyed by exact observed_at
 * date, one row per date any source was observed on. Because different
 * sources are rarely observed on the same date, a source's value is
 * forward-filled into every later row until its next real observation —
 * without this, Tremor/Recharts only draws a dot for a series with a single
 * total value and nothing at all for a series whose 2+ points never share a
 * row, which silently rendered as an empty chart (caught in #73 review).
 * Forward-fill produces an honest step line: "this source's last known price
 * was X until we observed otherwise" — never drawn before a source's first
 * real observation.
 */
export function PriceHistoryChart({
  priceHistory,
  statusEvents,
}: {
  priceHistory: PriceHistoryPoint[];
  statusEvents: StatusEventPoint[];
}) {
  const sources = [...new Set(priceHistory.map((p) => p.source))].sort();

  // Keyed by the raw ISO date (sortable, stable) rather than the formatted
  // label — avoids re-deriving the sort order from the formatted string.
  const byDate = new Map<string, { Fecha: string; sortKey: string; values: Record<string, number> }>();
  for (const point of priceHistory) {
    const sortKey = point.observed_at.slice(0, 10); // YYYY-MM-DD
    const existing = byDate.get(sortKey);
    if (existing) {
      existing.values[point.source] = point.price;
    } else {
      byDate.set(sortKey, {
        sortKey,
        Fecha: new Date(point.observed_at).toLocaleDateString("es-ES", {
          day: "2-digit",
          month: "short",
          year: "numeric",
        }),
        values: { [point.source]: point.price },
      });
    }
  }

  const orderedRows = [...byDate.values()].sort((a, b) => a.sortKey.localeCompare(b.sortKey));

  // Forward-fill each source's last known price into rows where it wasn't
  // observed, starting only after that source's first real observation.
  const lastKnown: Record<string, number> = {};
  const chartData = orderedRows.map(({ Fecha, values }) => {
    const row: Record<string, string | number> = { Fecha };
    for (const source of sources) {
      if (values[source] !== undefined) {
        lastKnown[source] = values[source];
      }
      if (lastKnown[source] !== undefined) {
        row[source] = lastKnown[source];
      }
    }
    return row;
  });

  const sortedStatusEvents = [...statusEvents].sort((a, b) => b.observed_at.localeCompare(a.observed_at));

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      {chartData.length === 0 ? (
        <p style={{ margin: 0, fontSize: 13, color: "var(--fg-muted)" }}>
          Todavía no hay historial de precios registrado.
        </p>
      ) : (
        <Card className="p-4">
          <LineChart
            data={chartData}
            index="Fecha"
            categories={sources}
            colors={["indigo", "cyan", "amber", "rose", "emerald"]}
            valueFormatter={(v: number) => fmtEUR0(v)}
            yAxisWidth={70}
            showLegend={sources.length > 1}
            connectNulls
            autoMinValue
          />
        </Card>
      )}

      {sortedStatusEvents.length > 0 && (
        <div data-testid="status-event-timeline">
          <p style={{ margin: "0 0 6px", fontSize: 12, fontWeight: 600, color: "var(--fg-muted)" }}>
            Historial de estado
          </p>
          <ul style={{ margin: 0, padding: 0, listStyle: "none", display: "flex", flexDirection: "column", gap: 4 }}>
            {sortedStatusEvents.map((e, i) => (
              <li key={i} style={{ fontSize: 12, color: "var(--fg)" }}>
                {new Date(e.observed_at).toLocaleDateString("es-ES", {
                  day: "2-digit",
                  month: "short",
                  year: "numeric",
                })}
                {" — "}
                <span style={{ textTransform: "capitalize" }}>{e.source}</span>: {STATUS_LABELS[e.status] ?? e.status}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
