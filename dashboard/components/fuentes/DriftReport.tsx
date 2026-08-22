"use client";

import type { PortalDriftReport } from "@/lib/search-url/drift";

/**
 * Deterministic portal filter-drift report (issue #371, D-090), moved out of the
 * retired Descubrimiento page into a shared component (#511) so "Salud de datos"
 * can render it. A clear per-portal "the code needs updating" flag: green "sin
 * deriva" when the captured catalog matches the code mapping; a red banner
 * listing ADDED / REMOVED / CHANGED options otherwise — actionable enough for
 * the owner to edit the code map. URL building stays 100% code-driven; this only
 * detects drift.
 *
 * Testids are unchanged from the original so existing assertions keep working.
 */
export function DriftReport({ drift }: { drift: PortalDriftReport }) {
  const totals = drift.axes.reduce(
    (acc, a) => ({
      added: acc.added + a.added.length,
      removed: acc.removed + a.removed.length,
      changed: acc.changed + a.changed.length,
    }),
    { added: 0, removed: 0, changed: 0 },
  );

  if (!drift.hasDrift) {
    return (
      <div
        data-testid="discovery-drift"
        data-drift="false"
        className="rounded-md border border-emerald-500/40 bg-emerald-50 px-4 py-3 text-sm text-emerald-800 dark:border-emerald-400/30 dark:bg-emerald-950/40 dark:text-emerald-200"
      >
        <span data-testid="discovery-drift-none" className="font-medium">
          Sin deriva: el catálogo del portal «{drift.connector}» coincide con el mapeo del código.
        </span>
      </div>
    );
  }

  return (
    <div
      data-testid="discovery-drift"
      data-drift="true"
      className="space-y-3 rounded-md border border-rose-500/40 bg-rose-50 px-4 py-3 text-sm text-rose-900 dark:border-rose-400/30 dark:bg-rose-950/40 dark:text-rose-100"
    >
      <p data-testid="discovery-drift-flag" className="font-semibold">
        Deriva detectada — actualiza el mapeo del código de «{drift.connector}» (
        {totals.added} nuevo(s), {totals.removed} retirado(s), {totals.changed} cambiado(s)).
      </p>
      {drift.axes.map((axis) => {
        if (
          axis.added.length === 0 &&
          axis.removed.length === 0 &&
          axis.changed.length === 0
        ) {
          return null;
        }
        return (
          <div key={axis.axis} className="space-y-1" data-testid={`drift-axis-${axis.axis}`}>
            <p className="font-mono text-xs uppercase tracking-wide opacity-70">{axis.axis}</p>
            <ul className="list-disc space-y-0.5 pl-5">
              {axis.added.map((it) => (
                <li key={`a-${it.slug}`} data-testid="drift-added">
                  <strong>Nuevo tipo</strong> «{it.portalLabel ?? it.slug}» (
                  <code className="font-mono text-xs">{it.slug}</code>
                  {typeof it.portalCode === "number" ? `, subtipo ${it.portalCode}` : ""}) que el
                  código no mapea.
                </li>
              ))}
              {axis.removed.map((it) => (
                <li key={`r-${it.slug}`} data-testid="drift-removed">
                  <strong>Ya no existe</strong> «{it.codeLabel ?? it.slug}» (
                  <code className="font-mono text-xs">{it.slug}</code>): el código lo mapea pero el
                  portal ya no lo ofrece.
                </li>
              ))}
              {axis.changed.map((it) => (
                <li key={`c-${it.slug}`} data-testid="drift-changed">
                  <strong>Cambiado</strong> «{it.portalLabel ?? it.slug}» (
                  <code className="font-mono text-xs">{it.slug}</code>): {it.reason}.
                </li>
              ))}
            </ul>
          </div>
        );
      })}
    </div>
  );
}
