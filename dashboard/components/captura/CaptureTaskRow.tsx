"use client";

import { useState } from "react";
import type { CaptureTask } from "@/lib/captura-tasks";
import { loosenedPrefixLabel } from "@/lib/search-url/labels";

/**
 * One capture TASK's FULL detail row on the task-driven `/captura` page
 * (issue #289): label + any loosened flags inline + a last-done note + one
 * execute button. The button (a) records the run (POST, via `onExecute`) and
 * (b) opens the task's pre-filtered URL in a new tab, where the browser
 * extension's batch capture (#262) takes over.
 *
 * Staleness is computed by the parent and passed in as `muted` + `lastDone`:
 *   - `muted` (done within its staleness window) → the row is greyed/atenuada,
 *     a visual "not due" cue. The button STAYS clickable — the operator can
 *     re-run any time; graying never blocks.
 *   - not muted (never done, or the window elapsed) → full colour = due.
 *
 * The row never captures or navigates the operator itself; it is the launch
 * pad + a per-task last-done mirror.
 *
 * **No checkbox here** (issue #559, revised from #556). The "Capturar todo"
 * selection checkbox moved to `ConnectorSection`'s ALWAYS-VISIBLE compact
 * checklist, rendered outside this row's `expanded`-gated detail — the owner's
 * exact complaint was "los checkbox están dentro del desplegable... ponlo
 * fuera" (the checkboxes are inside the collapsible — put them outside). This
 * row is rendered only when its connector is expanded, so it can never be the
 * sole place a task is tickable.
 *
 * **Stacked layout (issue #596)**: this row used to be a side-by-side flex
 * pair — a `flex: 1` text column next to a `flexShrink: 0` button ~160px
 * wide. The button couldn't shrink, so the label column (and the "sin
 * confirmar"-style loosened-flag list beside it) collapsed to roughly a
 * third of the card — long task labels ("Hipoges — pisos, chalets, áticos en
 * Dos Hermanas ≤210.000 €") wrapped one word per line. The owner's fix
 * ("ponlo debajo o arriba para tener todo el ancho") applies at EVERY width,
 * not just phone — he called out desktop explicitly — so this is a plain
 * `flex-direction: column` stack with no `@media` divergence at all: every
 * value that changed here is a static literal with no prop/state dependency
 * (D-121's rung 1), so it lives in `.capture-task-row`/`.capture-task-row-
 * button` (globals.css) rather than the inline `style` object; only the
 * genuinely state-dependent bits (`opacity`, `cursor`) stay inline. The text
 * block now gets the row's full width (container `align-items: stretch`,
 * the default for a column flex container); the button sits below it,
 * sized to its own content (`align-self: flex-start`) but with a 44px
 * `min-height` for the tap target — the old button was only ~34px tall.
 */
export function CaptureTaskRow({
  task,
  muted,
  lastDone,
  lastRunAt,
  onExecute,
}: {
  task: CaptureTask;
  /** True while the last run sits inside the staleness window (grey / not due). */
  muted: boolean;
  /** Spanish "last done" label ('nunca' / 'hecho hace 3 días'). */
  lastDone: string;
  /** ISO of the last run (for the title tooltip), or null when never run. */
  lastRunAt: string | null;
  /**
   * Record the run (POST) then open the URL. Returns once the POST resolves so
   * the row can show a transient "Abriendo…" state; opening the tab is the
   * caller's job (it must happen in the click's user-gesture to dodge popup
   * blockers).
   */
  onExecute: (task: CaptureTask) => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);

  async function handleClick() {
    if (busy) return;
    setBusy(true);
    try {
      await onExecute(task);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      data-testid={`captura-task-${task.id}`}
      data-portal={task.portal}
      data-muted={muted ? "true" : "false"}
      className="capture-task-row"
      style={{
        // Graying: a visual due/not-due cue only — never disables the button.
        // The only prop/state-dependent value left inline (D-121 rung 1) —
        // everything else moved to the class in globals.css.
        opacity: muted ? 0.55 : 1,
      }}
    >
      <div
        data-testid={`captura-task-text-${task.id}`}
        style={{ display: "flex", flexDirection: "column", gap: 6, minWidth: 0 }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <strong style={{ fontSize: 14, color: "var(--fg)" }}>{task.label}</strong>
          {muted && (
            <span
              data-testid={`captura-task-done-badge-${task.id}`}
              style={{
                fontSize: 11,
                fontWeight: 600,
                color: "var(--up)",
                background: "var(--bg-2)",
                borderRadius: 999,
                padding: "1px 8px",
              }}
            >
              hecho
            </span>
          )}
        </div>

        {/* Loosened flags inline — the search is BROADER than the profile. */}
        {task.loosened.length > 0 && (
          <ul
            data-testid={`captura-task-loosened-${task.id}`}
            style={{ margin: 0, padding: 0, listStyle: "none", display: "flex", flexDirection: "column", gap: 3 }}
          >
            {task.loosened.map((l) => (
              <li
                key={l.constraint}
                style={{
                  fontSize: 11,
                  color: "var(--warn)",
                  background: "var(--warn-bg)",
                  borderRadius: 6,
                  padding: "2px 7px",
                }}
              >
                <strong>{loosenedPrefixLabel(l.constraint)}</strong> {l.reason}
              </li>
            ))}
          </ul>
        )}

        <span
          data-testid={`captura-task-lastdone-${task.id}`}
          title={lastRunAt ?? undefined}
          style={{ fontSize: 12, color: "var(--fg-muted)" }}
        >
          {lastDone}
        </span>
      </div>

      <button
        data-testid={`captura-task-run-${task.id}`}
        onClick={handleClick}
        disabled={busy}
        title={task.url}
        className="capture-task-row-button"
        style={{ cursor: busy ? "wait" : "pointer" }}
      >
        {busy ? "Abriendo…" : muted ? "Repetir ↗" : "Abrir búsqueda ↗"}
      </button>
    </div>
  );
}
