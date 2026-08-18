"use client";

import { useMemo, useState } from "react";
import { ConnectorSection } from "@/components/captura/ConnectorSection";
import {
  allProfileTasks,
  buildCaptureBatchPlan,
  capCaptureBatchPlan,
  defaultTickedTaskIds,
  type ProfileCaptureView,
} from "@/lib/captura-tasks";
import { MAX_QUEUE_ENTRIES, withCaptureQueue, withCaptureSignal } from "@/lib/extension-capture";

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
 * Also owns the OPTIMISTIC per-task run overrides (`runOverrides`, issue #556
 * review N7) — lifted here from `ConnectorSection` so a task launched via
 * EITHER this profile's single-task buttons OR its "Capturar todo" batch
 * button greys out AND un-ticks immediately, everywhere it's rendered. Without
 * this, a second "Capturar todo" click before the page reloads would re-fire
 * every task the first click just launched.
 *
 * ONE global button per profile (never per-portal, per the owner's own
 * decision on #556) acts on the ticked set, labelled with the live count so
 * the owner always knows how much work is about to start ("Capturar 7
 * tareas"). Clicking it:
 *   1. Opens ONLY the first ticked task's tab, SYNCHRONOUSLY in the click's
 *      user gesture (issue #556 review N5 — before any `await`, so it never
 *      leans on Chrome's short-lived transient-activation grace period the
 *      way an open-after-await would). The REST are piggybacked onto that
 *      URL as the `#inmo-capture-queue=<json>` FRAGMENT (`withCaptureQueue` —
 *      see D-113 review B2 for why the fragment, not the query string) and
 *      handed to the extension's OWN pending-search queue (#555/D-112) by its
 *      content script + `background.js` — the extension opens them itself,
 *      one at a time, via `chrome.tabs` (exempt from the page-level popup
 *      blocker), never this component. See `lib/extension-capture.ts` for why
 *      this indirection is needed (the dashboard has no direct messaging
 *      channel to the extension).
 *   2. A sane cap (`MAX_QUEUE_ENTRIES`, issue #556 review B3) bounds how many
 *      ride along; anything past it is NEITHER queued NOR recorded — a
 *      dropped task must never look "done" — and the status message says so.
 *   3. THEN records a `capture_task_run` for every task that actually got
 *      opened/queued (best-effort, parallel POSTs — same ledger write the
 *      single-task path already does, per taskId).
 *   4. The status message is explicit about what's CONFIRMED (the one tab
 *      that visibly opened) versus what's merely QUEUED and depends on the
 *      extension being installed and running (issue #556 review N1) — the
 *      due-cue must never quietly lie about tasks nobody watched happen.
 *   5. Nothing ticked → a message, no fetch, no window.open — never silently
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
  // Optimistic per-task run overrides (issue #556 review N7) — shared by every
  // ConnectorSection under this profile AND by onCapturarTodo below.
  const [runOverrides, setRunOverrides] = useState<Record<string, string>>({});

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

  /** Grey out + un-tick a task the instant its run is recorded (N7). */
  function recordOptimisticRun(taskId: string, lastRunAt: string): void {
    setRunOverrides((prev) => ({ ...prev, [taskId]: lastRunAt }));
    setTicked((prev) => {
      if (!prev.has(taskId)) return prev;
      const next = new Set(prev);
      next.delete(taskId);
      return next;
    });
  }

  async function onCapturarTodo(): Promise<void> {
    const rawPlan = buildCaptureBatchPlan(allTasks, ticked);
    if (!rawPlan) {
      setStatus("No has marcado ninguna tarea todavía.");
      return;
    }
    const { plan, droppedCount } = capCaptureBatchPlan(rawPlan, MAX_QUEUE_ENTRIES);

    setRunning(true);

    // Open FIRST, synchronously, inside the click's own gesture (review N5) —
    // never after an `await`, which would rely on Chrome's short transient-
    // activation grace period instead of the gesture itself.
    let opened = false;
    if (typeof window !== "undefined") {
      const url = withCaptureSignal(withCaptureQueue(plan.first.captureUrl, plan.queue));
      opened = window.open(url, "_blank", "noopener,noreferrer") !== null;
    }

    const stamp = new Date().toISOString();
    const results = await Promise.allSettled(
      plan.taskIds.map(async (taskId) => {
        const res = await fetch(`/api/profiles/${profile.id}/capture-task-runs`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ taskId }),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const body = await res.json().catch(() => null);
        return { taskId, lastRunAt: (body?.lastRunAt as string | undefined) ?? stamp };
      }),
    );
    for (const r of results) {
      if (r.status === "fulfilled") recordOptimisticRun(r.value.taskId, r.value.lastRunAt);
    }

    // Honest status (review N1): only the FIRST task's tab is something the
    // owner can actually see open. The rest are handed to the extension's own
    // queue and depend on it being installed and running — never phrase that
    // as "capturado", only as queued/pending.
    const queuedCount = plan.queue.length;
    const parts: string[] = [
      opened
        ? `Se abre "${plan.first.label}" ahora.`
        : `Se ha intentado abrir "${plan.first.label}" (puede que el navegador haya bloqueado la pestaña).`,
    ];
    if (queuedCount > 0) {
      parts.push(
        `${queuedCount} búsqueda${queuedCount === 1 ? "" : "s"} más en cola en la extensión — solo se capturarán si la extensión está instalada y activa.`,
      );
    }
    if (droppedCount > 0) {
      parts.push(
        `${droppedCount} tarea${droppedCount === 1 ? "" : "s"} no ${droppedCount === 1 ? "cabe" : "caben"} en esta tanda (límite ${MAX_QUEUE_ENTRIES}) — vuelve a pulsar "Capturar todo" cuando esta termine.`,
      );
    }
    setStatus(parts.join(" "));
    setRunning(false);
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
            runOverrides={runOverrides}
            onOptimisticRun={recordOptimisticRun}
          />
        ))}
      </div>
    </div>
  );
}
