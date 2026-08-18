"use client";

import { useMemo, useState } from "react";
import { CapturaProfileSection } from "@/components/captura/CapturaProfileSection";
import {
  allTasksAcrossProfiles,
  buildGlobalCaptureBatchPlan,
  capGlobalCaptureBatchPlan,
  defaultTickedSelectionKeys,
  selectionKey,
  type ProfileCaptureView,
} from "@/lib/captura-tasks";
import { MAX_QUEUE_ENTRIES, withCaptureQueue, withCaptureSignal } from "@/lib/extension-capture";

/**
 * Stacked per-profile Captura view (issue #413), now carrying the GLOBAL
 * "Capturar todo" surface (issue #559).
 *
 * #556/#558 shipped "Capturar todo" as one button + one select-all/none PER
 * PROFILE, with the per-task checkboxes living inside each connector's
 * collapsible. The owner tried it and rejected both, in his own words:
 * *"te pedí un seleccionar todo que funcione en todos los perfiles a la vez y
 * un capturar para todos también, no por perfil. los checkbox están dentro
 * del desplegable lo que me obliga a abrirlo. ponlo fuera. el botón de
 * captura que sea solo uno, y seleccionar todo nada que sea global y por
 * perfil."* This was a spec error, not a change of mind — he was asked
 * "¿el botón es por perfil o global?" up front and answered "global, con los
 * checks me apaño".
 *
 * Three changes from #556/#558:
 *   1. ONE capture button for the whole page, spanning every VISIBLE profile
 *      (never one per profile) — the live count in its label may now span
 *      several profiles.
 *   2. ONE global select-all / select-none, spanning every VISIBLE profile.
 *      The per-profile pair is gone — the owner explicitly rejected having
 *      both ("nada que sea global y por perfil").
 *   3. Selection no longer requires expanding anything — `ConnectorSection`
 *      now renders an ALWAYS-VISIBLE compact checklist (issue #559); this
 *      component only owns the SELECTION STATE, not how it's exposed per
 *      connector.
 *
 * Selection state is lifted HERE (from `CapturaProfileSection`, issue #556)
 * as a cross-profile set keyed by `selectionKey(profileId, taskId)` — a bare
 * `CaptureTask.id` is only unique WITHIN one profile's filter scope (see
 * `lib/captura-tasks.ts`), so two different profiles' tasks can collide on a
 * bare id. The default tick state is seeded from EVERY profile (not just the
 * currently visible ones) so toggling the filter never silently discards a
 * tick made on a now-hidden profile.
 *
 * **"Visible" is defined by the profile filter below** (`captura-profile-filter`,
 * default "Todos los perfiles"). The button, the count in its label, and
 * select-all/none all act on the CURRENTLY VISIBLE set only, and a scope note
 * says so explicitly whenever the filter narrows it — the count must never
 * lie about tasks the owner can't currently see.
 */
export function CapturaProfiles({ profiles }: { profiles: ProfileCaptureView[] }) {
  // "" = Todos (default). Otherwise the selected profile id as a string.
  const [filter, setFilter] = useState<string>("");

  const visible = useMemo(
    () => (filter === "" ? profiles : profiles.filter((p) => String(p.id) === filter)),
    [profiles, filter],
  );

  // Cross-profile ticked set, seeded once from EVERY profile's DUE tasks
  // (issue #556's default-tick rule, unchanged) — never re-seeded when the
  // filter changes, so switching it back and forth never resets a manual tick.
  const [ticked, setTicked] = useState<Set<string>>(() => defaultTickedSelectionKeys(profiles));
  // Optimistic per-task run overrides (issue #556 review N7), also global now.
  const [runOverrides, setRunOverrides] = useState<Record<string, string>>({});
  const [status, setStatus] = useState<string | null>(null);
  const [running, setRunning] = useState(false);

  const visibleTasks = useMemo(() => allTasksAcrossProfiles(visible), [visible]);
  const visibleKeys = useMemo(
    () => visibleTasks.map((pt) => selectionKey(pt.profileId, pt.task.id)),
    [visibleTasks],
  );
  const tickedCount = useMemo(
    () => visibleKeys.reduce((n, k) => n + (ticked.has(k) ? 1 : 0), 0),
    [visibleKeys, ticked],
  );

  function toggleTask(profileId: number, taskId: string): void {
    const key = selectionKey(profileId, taskId);
    setTicked((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  /** Select every VISIBLE task — never touches a ticked task hidden by the filter. */
  function selectAllVisible(): void {
    setTicked((prev) => {
      const next = new Set(prev);
      for (const key of visibleKeys) next.add(key);
      return next;
    });
  }

  /** Clear every VISIBLE task's tick — never touches a hidden profile's ticks. */
  function selectNoneVisible(): void {
    setTicked((prev) => {
      const next = new Set(prev);
      for (const key of visibleKeys) next.delete(key);
      return next;
    });
  }

  /** Grey out + un-tick a task the instant its run is recorded (issue #556 review N7). */
  function recordOptimisticRun(profileId: number, taskId: string, lastRunAt: string): void {
    const key = selectionKey(profileId, taskId);
    setRunOverrides((prev) => ({ ...prev, [key]: lastRunAt }));
    setTicked((prev) => {
      if (!prev.has(key)) return prev;
      const next = new Set(prev);
      next.delete(key);
      return next;
    });
  }

  async function onCapturarTodo(): Promise<void> {
    const rawPlan = buildGlobalCaptureBatchPlan(visibleTasks, ticked);
    if (!rawPlan) {
      setStatus("No has marcado ninguna tarea todavía.");
      return;
    }
    const { plan, droppedCount, droppedProfileIds } = capGlobalCaptureBatchPlan(rawPlan, MAX_QUEUE_ENTRIES);

    setRunning(true);

    // Open FIRST, synchronously, inside the click's own gesture (issue #556
    // review N5) — never after an `await`.
    let opened = false;
    if (typeof window !== "undefined") {
      const url = withCaptureSignal(withCaptureQueue(plan.first.captureUrl, plan.queue));
      opened = window.open(url, "_blank", "noopener,noreferrer") !== null;
    }

    const stamp = new Date().toISOString();
    const results = await Promise.allSettled(
      plan.entries.map(async (entry) => {
        const res = await fetch(`/api/profiles/${entry.profileId}/capture-task-runs`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ taskId: entry.taskId }),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const body = await res.json().catch(() => null);
        return { ...entry, lastRunAt: (body?.lastRunAt as string | undefined) ?? stamp };
      }),
    );
    for (const r of results) {
      if (r.status === "fulfilled") recordOptimisticRun(r.value.profileId, r.value.taskId, r.value.lastRunAt);
    }

    // Honest status (issue #556 review N1): only the FIRST task's tab is
    // something the owner can actually see open.
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
      // Name WHICH profiles lost tasks to the cap (issue #559) — the button now
      // spans profiles, so a bare count no longer tells the owner where to look.
      const names = droppedProfileIds
        .map((id) => profiles.find((p) => p.id === id)?.name ?? `#${id}`)
        .join(", ");
      const profileWord = droppedProfileIds.length === 1 ? "el perfil" : "los perfiles";
      parts.push(
        `${droppedCount} tarea${droppedCount === 1 ? "" : "s"} no ${droppedCount === 1 ? "cabe" : "caben"} en esta tanda (límite ${MAX_QUEUE_ENTRIES}) — de ${profileWord} ${names}. Vuelve a pulsar "Capturar todo" cuando esta termine.`,
      );
    }
    setStatus(parts.join(" "));
    setRunning(false);
  }

  const scopedProfileName = filter !== "" ? (visible[0]?.name ?? null) : null;

  return (
    <div data-testid="captura-profiles">
      {/* Optional profile filter — default shows every profile stacked. */}
      {profiles.length > 1 && (
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 16 }}>
          <label htmlFor="captura-profile-filter" style={{ fontSize: 13, color: "var(--fg-muted)" }}>
            Filtrar perfil
          </label>
          <select
            id="captura-profile-filter"
            data-testid="captura-profile-filter"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            style={{
              fontSize: 13,
              padding: "7px 10px",
              borderRadius: 8,
              border: "1px solid var(--border)",
              background: "var(--bg-1)",
              color: "var(--fg)",
              minWidth: 200,
            }}
          >
            <option value="">Todos los perfiles</option>
            {profiles.map((p) => (
              <option key={p.id} value={String(p.id)}>
                {p.name}
              </option>
            ))}
          </select>
        </div>
      )}

      {/* GLOBAL "Capturar todo" controls (issue #559) — ONE button, ONE
          select-all/none, spanning every profile currently VISIBLE under the
          filter above. Rendered only when there is at least one task to act
          on among the visible profiles. */}
      {visibleTasks.length > 0 && (
        <div
          data-testid="captura-batch"
          style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", marginBottom: 20 }}
        >
          <button
            type="button"
            data-testid="captura-batch-run"
            onClick={onCapturarTodo}
            disabled={running}
            style={{
              padding: "8px 18px",
              fontSize: 14,
              fontWeight: 700,
              borderRadius: 8,
              border: "none",
              background: tickedCount > 0 ? "var(--accent)" : "var(--bg-2)",
              color: tickedCount > 0 ? "#fff" : "var(--fg-muted)",
              cursor: running ? "wait" : "pointer",
              whiteSpace: "nowrap",
            }}
          >
            {running ? "Capturando…" : `Capturar ${tickedCount} tarea${tickedCount === 1 ? "" : "s"}`}
          </button>
          <button
            type="button"
            data-testid="captura-batch-select-all"
            onClick={selectAllVisible}
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
            data-testid="captura-batch-select-none"
            onClick={selectNoneVisible}
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
          {scopedProfileName && (
            <span data-testid="captura-batch-scope-note" style={{ fontSize: 12, color: "var(--fg-muted)" }}>
              Filtro activo — solo actúa sobre &quot;{scopedProfileName}&quot;.
            </span>
          )}
          {status && (
            <span data-testid="captura-batch-status" style={{ fontSize: 12, color: "var(--fg-muted)" }}>
              {status}
            </span>
          )}
        </div>
      )}

      <div style={{ display: "flex", flexDirection: "column", gap: 28 }}>
        {visible.map((profile) => (
          <section
            key={profile.id}
            data-testid={`captura-profile-${profile.id}`}
            style={{ display: "flex", flexDirection: "column", gap: 10 }}
          >
            <div style={{ display: "flex", alignItems: "baseline", gap: 10, flexWrap: "wrap" }}>
              <h2 style={{ fontSize: 17, fontWeight: 700, color: "var(--fg)", margin: 0 }}>
                {profile.name}
              </h2>
              <span
                data-testid={`captura-profile-summary-${profile.id}`}
                style={{ fontSize: 12, color: "var(--fg-muted)" }}
              >
                {profile.connectors.length === 0
                  ? "sin conectores"
                  : profile.actionableConnectors > 0
                    ? `${profile.actionableConnectors} conector${profile.actionableConnectors === 1 ? "" : "es"} por hacer · ${profile.totalTasks} tarea${profile.totalTasks === 1 ? "" : "s"}`
                    : `todo al día · ${profile.totalTasks} tarea${profile.totalTasks === 1 ? "" : "s"}`}
              </span>
            </div>

            {profile.connectors.length === 0 ? (
              <p
                data-testid={`captura-profile-empty-${profile.id}`}
                style={{ fontSize: 13, color: "var(--fg-muted)" }}
              >
                Este perfil no tiene ninguna tarea de captura disponible todavía.
              </p>
            ) : (
              <CapturaProfileSection
                profile={profile}
                ticked={ticked}
                onToggleTask={toggleTask}
                runOverrides={runOverrides}
                onOptimisticRun={recordOptimisticRun}
              />
            )}
          </section>
        ))}
      </div>
    </div>
  );
}
