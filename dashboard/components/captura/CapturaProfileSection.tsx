"use client";

import { useMemo, useState } from "react";
import { ConnectorSection } from "@/components/captura/ConnectorSection";
import {
  allProfileTasks,
  buildCaptureBatchPlan,
  defaultTickedTaskIds,
  type ProfileCaptureView,
} from "@/lib/captura-tasks";
import { withCaptureQueue, withCaptureSignal } from "@/lib/extension-capture";

/**
 * One profile's stacked section on `/captura`, including the "Capturar todo"
 * batch button (issue #556): *"quiero un botón que sea capturar todo y que
 * vaya a todas una a una y las capture todas"*.
 *
 * Owns the per-task TICKED SET for this profile — pre-ticked exactly on the
 * tasks that are DUE (`lib/captura-tasks.ts` `defaultTickedTaskIds`, reusing
 * D-048's staleness computation verbatim, never re-derived). A muted
 * (done-this-cycle) task starts unticked but can be ticked back in; a due one
 * can be ticked out — graying is a visual cue, never a block (D-048), and the
 * same is true of the tick state.
 *
 * ONE global button per profile (never per-portal, per the owner's own
 * decision on #556) acts on the ticked set, labelled with the live count so
 * the owner always knows how much work is about to start ("Capturar 7
 * tareas"). Clicking it:
 *   1. Records a `capture_task_run` for EVERY ticked task (best-effort,
 *      parallel POSTs — same ledger write the single-task path already does,
 *      per taskId), so the staleness window stays honest regardless of
 *      whether the extension ever gets to run all of them.
 *   2. Opens ONLY the first ticked task's tab, in the click's user gesture
 *      (exactly like the existing single-task button — popup blockers only
 *      allow this for a synchronous/near-synchronous open). The REST are
 *      piggybacked onto that URL as the `inmo-capture-queue` param
 *      (`withCaptureQueue`) and handed to the extension's OWN pending-search
 *      queue (#555/D-112) by its content script + `background.js` — the
 *      extension opens them itself, one at a time, via `chrome.tabs` (exempt
 *      from the page-level popup blocker), never this component. See
 *      `lib/extension-capture.ts` for why this indirection is needed (the
 *      dashboard has no direct messaging channel to the extension).
 *   3. Nothing ticked → a message, no fetch, no window.open — never silently
 *      no-ops without telling the owner.
 *
 * The single-task "Abrir búsqueda ↗" button inside each `ConnectorSection` /
 * `CaptureTaskRow` is UNCHANGED — this component only adds the checkbox +
 * batch button around it.
 */
export function CapturaProfileSection({ profile }: { profile: ProfileCaptureView }) {
  const allTasks = useMemo(() => allProfileTasks(profile.connectors), [profile.connectors]);

  const [ticked, setTicked] = useState<Set<string>>(() => defaultTickedTaskIds(profile.connectors));
  const [status, setStatus] = useState<string | null>(null);
  const [running, setRunning] = useState(false);

  const tickedCount = useMemo(
    () => allTasks.reduce((n, t) => n + (ticked.has(t.id) ? 1 : 0), 0),
    [allTasks, ticked],
  );

  function toggleTask(taskId: string): void {
    setTicked((prev) => {
      const next = new Set(prev);
      if (next.has(taskId)) next.delete(taskId);
      else next.add(taskId);
      return next;
    });
  }

  function selectAll(): void {
    setTicked(new Set(allTasks.map((t) => t.id)));
  }

  function selectNone(): void {
    setTicked(new Set());
  }

  async function onCapturarTodo(): Promise<void> {
    const plan = buildCaptureBatchPlan(allTasks, ticked);
    if (!plan) {
      setStatus("No has marcado ninguna tarea todavía.");
      return;
    }
    setRunning(true);
    try {
      await Promise.allSettled(
        plan.taskIds.map((taskId) =>
          fetch(`/api/profiles/${profile.id}/capture-task-runs`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ taskId }),
          }),
        ),
      );
    } finally {
      // Open in the click's gesture regardless of whether every POST resolved
      // in time — recording is best-effort (matches the single-task path);
      // it must never block launching the capture.
      if (typeof window !== "undefined") {
        const url = withCaptureQueue(withCaptureSignal(plan.first.captureUrl), plan.queue);
        window.open(url, "_blank", "noopener,noreferrer");
      }
      setStatus(
        plan.queue.length > 0
          ? `Capturando ${plan.taskIds.length} tareas: se abre "${plan.first.label}" ahora; ${plan.queue.length} más en cola en la extensión.`
          : `Capturando 1 tarea: se abre "${plan.first.label}".`,
      );
      setRunning(false);
    }
  }

  return (
    <div data-testid={`captura-batch-${profile.id}`} style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      {allTasks.length > 0 && (
        <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
          <button
            type="button"
            data-testid={`captura-batch-run-${profile.id}`}
            onClick={onCapturarTodo}
            disabled={running}
            style={{
              padding: "7px 16px",
              fontSize: 13,
              fontWeight: 700,
              borderRadius: 8,
              border: "none",
              background: tickedCount > 0 ? "var(--accent)" : "var(--bg-2)",
              color: tickedCount > 0 ? "#fff" : "var(--fg-muted)",
              cursor: running ? "wait" : "pointer",
              whiteSpace: "nowrap",
            }}
          >
            {running
              ? "Capturando…"
              : `Capturar ${tickedCount} tarea${tickedCount === 1 ? "" : "s"}`}
          </button>
          <button
            type="button"
            data-testid={`captura-batch-select-all-${profile.id}`}
            onClick={selectAll}
            style={{
              background: "none",
              border: "none",
              padding: 0,
              font: "inherit",
              fontSize: 12,
              color: "var(--accent)",
              textDecoration: "underline",
              cursor: "pointer",
            }}
          >
            Todo
          </button>
          <button
            type="button"
            data-testid={`captura-batch-select-none-${profile.id}`}
            onClick={selectNone}
            style={{
              background: "none",
              border: "none",
              padding: 0,
              font: "inherit",
              fontSize: 12,
              color: "var(--accent)",
              textDecoration: "underline",
              cursor: "pointer",
            }}
          >
            Nada
          </button>
          {status && (
            <span
              data-testid={`captura-batch-status-${profile.id}`}
              style={{ fontSize: 12, color: "var(--fg-muted)" }}
            >
              {status}
            </span>
          )}
        </div>
      )}

      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        {profile.connectors.map((connector) => (
          <ConnectorSection
            key={connector.portal}
            profileId={profile.id}
            connector={connector}
            checkedTaskIds={ticked}
            onToggleTask={toggleTask}
          />
        ))}
      </div>
    </div>
  );
}
