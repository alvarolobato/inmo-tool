"use client";

import type { ReviewContent } from "@/lib/review-schema";

export interface ReviewDiffPanelProps {
  prior: ReviewContent | null;
  current: ReviewContent;
}

export function ReviewDiffPanel({ prior, current }: ReviewDiffPanelProps) {
  if (!prior) {
    return (
      <p className="text-xs text-tremor-content-subtle dark:text-dark-tremor-content-subtle">
        No hay revisión anterior para comparar en esta semana.
      </p>
    );
  }

  const prevExec = new Set(prior.executive_summary);
  const currExec = new Set(current.executive_summary);
  const addedExec = current.executive_summary.filter((x) => !prevExec.has(x));
  const removedExec = prior.executive_summary.filter((x) => !currExec.has(x));

  const prevKeys = new Set(prior.action_items.map((a) => a.action_key));
  const currKeys = new Set(current.action_items.map((a) => a.action_key));
  const addedKeys = [...currKeys].filter((k) => !prevKeys.has(k));
  const removedKeys = [...prevKeys].filter((k) => !currKeys.has(k));

  return (
    <div
      className="rounded-lg border border-tremor-border dark:border-dark-tremor-border bg-tremor-background dark:bg-dark-tremor-background p-4 space-y-3"
      data-testid="review-diff-panel"
    >
      <h3 className="text-sm font-semibold text-tremor-content-strong dark:text-dark-tremor-content-strong">
        Cambios vs revisión anterior
      </h3>
      {addedExec.length > 0 && (
        <div>
          <p className="text-xs font-medium text-green-400 mb-1">Resumen — nuevos bullets</p>
          <ul className="text-xs list-disc list-inside">
            {addedExec.map((s, i) => (
              <li key={i}>{s}</li>
            ))}
          </ul>
        </div>
      )}
      {removedExec.length > 0 && (
        <div>
          <p className="text-xs font-medium text-red-400 mb-1">Resumen — bullets eliminados</p>
          <ul className="text-xs list-disc list-inside">
            {removedExec.map((s, i) => (
              <li key={i}>{s}</li>
            ))}
          </ul>
        </div>
      )}
      {(addedKeys.length > 0 || removedKeys.length > 0) && (
        <div className="text-xs">
          <p className="font-medium mb-1">Acciones</p>
          {addedKeys.length > 0 && (
            <p>
              <span className="text-green-400">+</span> {addedKeys.join(", ")}
            </p>
          )}
          {removedKeys.length > 0 && (
            <p>
              <span className="text-red-400">−</span> {removedKeys.join(", ")}
            </p>
          )}
        </div>
      )}
      {addedExec.length === 0 && removedExec.length === 0 && addedKeys.length === 0 && removedKeys.length === 0 && (
        <p className="text-xs text-tremor-content-subtle dark:text-dark-tremor-content-subtle">
          Sin diferencias detectadas en resumen y claves de acción.
        </p>
      )}
    </div>
  );
}
