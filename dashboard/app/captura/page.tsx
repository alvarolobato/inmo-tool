"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { ErrorDisplay } from "@/components/ErrorDisplay";
import { CaptureTaskRow } from "@/components/captura/CaptureTaskRow";
import { isApiErrorResponse } from "@/lib/errors";
import type { ApiErrorResponse } from "@/lib/errors";
import {
  normalizeTasks,
  groupTasksByPortal,
  taskStaleness,
  lastDoneLabel,
  relativeAgo,
  resolveStalenessDays,
  DEFAULT_STALENESS_DAYS,
  type CaptureTask,
  type StalenessConfig,
  type PortalCaptureActivity,
} from "@/lib/captura-tasks";
import type { SearchProfileRow } from "@/lib/profiles-schema";
import type { WorklistPortalSummary } from "@/lib/worklist";
import { withCaptureSignal } from "@/lib/extension-capture";

/**
 * Captura — task-driven guided-capture EXECUTION page (issue #289, part of
 * #237, evolving #268/#284).
 *
 * For a selected profile the page lists discrete, recurring capture TASKS —
 * one openable pre-filtered search per (portal × searchable section), from the
 * restructured `GET /api/profiles/[id]/search-urls` `tasks[]` shape. Because
 * Idealista searches one property-type section at a time, a multi-type profile
 * yields SEPARATE tasks, each its own button — there is no merged "ampliada"
 * note; each section is its own task.
 *
 * Per task: a button that records the run (POST /capture-task-runs) then opens
 * the URL in a new tab (the extension's batch capture, #262, takes over); a
 * last-done note ('hecho hace 3 días' / 'nunca'); and any `loosened` flags
 * inline. A task run within its staleness window (settings:
 * `capture.staleness_days`, per-portal or global) greys out (not due); once the
 * window elapses it returns to colour (due). Graying is a visual cue — the
 * button stays clickable for an optional re-run.
 *
 * Still EXECUTION only, distinct from the admin SETUP surfaces under `/etl/*`.
 * Reuses their APIs — search-urls (#267), worklist (#260) — and never
 * re-implements the URL grammar or the batch loop. The per-portal worklist
 * progress roll-up from #284 is kept as a group header.
 */

type ProfileOption = Pick<SearchProfileRow, "id" | "name">;

const FALLBACK_STALENESS: StalenessConfig = { defaultDays: DEFAULT_STALENESS_DAYS, byPortal: {} };

export default function CapturaPage() {
  const [profiles, setProfiles] = useState<ProfileOption[]>([]);
  const [profilesLoading, setProfilesLoading] = useState(true);
  const [selectedId, setSelectedId] = useState<number | null>(null);

  const [tasks, setTasks] = useState<CaptureTask[]>([]);
  const [summaries, setSummaries] = useState<WorklistPortalSummary[]>([]);
  const [activity, setActivity] = useState<PortalCaptureActivity[]>([]);
  const [runs, setRuns] = useState<Record<string, string>>({});
  const [staleness, setStaleness] = useState<StalenessConfig>(FALLBACK_STALENESS);
  const [detailLoading, setDetailLoading] = useState(false);
  const [error, setError] = useState<ApiErrorResponse | string | null>(null);

  // "now" is captured per detail load / execute so all rows agree on the window.
  const [now, setNow] = useState(() => new Date());

  // ── Load the profile list once ──────────────────────────────────────────
  const fetchProfiles = useCallback(async () => {
    setProfilesLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/profiles");
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        setError(isApiErrorResponse(body) ? body : "No se pudieron cargar los perfiles.");
        return;
      }
      const body: SearchProfileRow[] = await res.json();
      setProfiles(body.map((p) => ({ id: p.id, name: p.name })));
      if (body.length > 0) setSelectedId((prev) => prev ?? body[0].id);
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudieron cargar los perfiles.");
    } finally {
      setProfilesLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchProfiles();
  }, [fetchProfiles]);

  // ── Load the selected profile's tasks + worklist roll-up + task-runs ─────
  const fetchDetail = useCallback(async (id: number) => {
    setDetailLoading(true);
    setError(null);
    try {
      const [urlsRes, wlRes, runsRes] = await Promise.all([
        fetch(`/api/profiles/${id}/search-urls`),
        fetch("/api/etl/worklist"),
        fetch(`/api/profiles/${id}/capture-task-runs`),
      ]);
      if (!urlsRes.ok) {
        const body = await urlsRes.json().catch(() => null);
        setError(isApiErrorResponse(body) ? body : "No se pudieron cargar las tareas del perfil.");
        return;
      }
      if (!wlRes.ok) {
        const body = await wlRes.json().catch(() => null);
        setError(isApiErrorResponse(body) ? body : "No se pudo cargar el progreso de captura.");
        return;
      }
      if (!runsRes.ok) {
        const body = await runsRes.json().catch(() => null);
        setError(isApiErrorResponse(body) ? body : "No se pudo cargar el histórico de tareas.");
        return;
      }
      const urlsBody = await urlsRes.json();
      const wlBody = await wlRes.json();
      const runsBody = await runsRes.json();
      // Consumes the restructured `tasks[]` when present; the normaliser adapts
      // the legacy `urls[]` shape until the search-url restructure lands (#289).
      setTasks(normalizeTasks(urlsBody));
      setSummaries(wlBody.summaries ?? []);
      setActivity(Array.isArray(runsBody.activity) ? runsBody.activity : []);
      setRuns(runsBody.runs ?? {});
      setStaleness(
        runsBody.staleness && typeof runsBody.staleness === "object"
          ? {
              defaultDays: Number(runsBody.staleness.defaultDays) || DEFAULT_STALENESS_DAYS,
              byPortal: runsBody.staleness.byPortal ?? {},
            }
          : FALLBACK_STALENESS,
      );
      setNow(new Date());
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo cargar la captura del perfil.");
    } finally {
      setDetailLoading(false);
    }
  }, []);

  useEffect(() => {
    if (selectedId !== null) fetchDetail(selectedId);
  }, [selectedId, fetchDetail]);

  // ── Execute a task: record the run (POST), then open the URL in a new tab ─
  const onExecute = useCallback(
    async (task: CaptureTask) => {
      if (selectedId === null) return;
      const stamp = new Date().toISOString();
      try {
        const res = await fetch(`/api/profiles/${selectedId}/capture-task-runs`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ taskId: task.id }),
        });
        if (res.ok) {
          const body = await res.json().catch(() => null);
          const lastRunAt = body?.lastRunAt ?? stamp;
          // Optimistic: grey the row immediately (it is now within its window).
          setRuns((prev) => ({ ...prev, [task.id]: lastRunAt }));
          setNow(new Date());
        }
      } catch {
        // Recording is best-effort — never block the operator from opening the
        // search. The last-done note just won't update until the next reload.
      } finally {
        // Open in the click's user gesture so popup blockers don't eat it.
        // Tag the URL with the auto-start signal (#inmo-capture) so the
        // extension starts the batch on that tab without any popup/banner
        // click (issue #297). withCaptureSignal never breaks the URL.
        if (typeof window !== "undefined") {
          window.open(withCaptureSignal(task.url), "_blank", "noopener,noreferrer");
        }
      }
    },
    [selectedId],
  );

  const groups = useMemo(() => groupTasksByPortal(tasks), [tasks]);
  const summaryByPortal = useMemo(() => {
    const m = new Map<string, WorklistPortalSummary>();
    for (const s of summaries) m.set(s.source_portal, s);
    return m;
  }, [summaries]);
  const activityByPortal = useMemo(() => {
    const m = new Map<string, PortalCaptureActivity>();
    for (const a of activity) m.set(a.portal, a);
    return m;
  }, [activity]);

  const totals = useMemo(() => {
    let done = 0;
    for (const t of tasks) {
      const st = taskStaleness(runs[t.id], resolveStalenessDays(t.portal, staleness), now);
      if (st.done && st.muted) done += 1;
    }
    // REAL captured count across the portals this profile has tasks for — the
    // headline must reflect what actually landed (extension_capture), not just
    // seeded worklist rows, so it never reads empty while captures are working.
    let captured = 0;
    for (const g of groups) captured += activityByPortal.get(g.portal)?.captured ?? 0;
    return { tasks: tasks.length, done, due: tasks.length - done, portals: groups.length, captured };
  }, [tasks, runs, staleness, now, groups, activityByPortal]);

  return (
    <main style={{ padding: 24, maxWidth: 900, margin: "0 auto" }} data-testid="captura-page">
      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
        <h1 style={{ fontSize: 22, fontWeight: 700, color: "var(--fg)", margin: 0 }}>Captura</h1>
        <Link
          href="/etl/extension"
          data-testid="captura-setup-link"
          style={{ fontSize: 13, color: "var(--accent)", textDecoration: "none", marginLeft: "auto" }}
        >
          ¿Primera vez? Instalar la extensión →
        </Link>
      </div>
      <p style={{ fontSize: 13, color: "var(--fg-muted)", marginTop: 8, lineHeight: 1.5 }}>
        Elige un perfil y ejecuta cada tarea de captura: abre su búsqueda ya filtrada en el portal y
        deja que la extensión capture los anuncios. Cada tarea recuerda cuándo la hiciste y se atenúa
        durante su ventana; cuando caduca vuelve a estar activa. La configuración (extensión, clave,
        conectores) vive en{" "}
        <Link href="/etl/captura" style={{ color: "var(--accent)", textDecoration: "none" }}>
          Admin · Captura
        </Link>
        .
      </p>

      {error && (
        <div style={{ marginTop: 16 }}>
          <ErrorDisplay error={error} />
        </div>
      )}

      {/* Profile picker */}
      <section style={{ marginTop: 20 }} data-testid="captura-profile-picker">
        {profilesLoading ? (
          <div
            data-testid="captura-profiles-loading"
            style={{ height: 38, width: 260, borderRadius: 8, background: "var(--bg-2)", opacity: 0.6 }}
          />
        ) : profiles.length === 0 ? (
          <div
            data-testid="captura-no-profiles"
            style={{
              border: "1px solid var(--border)",
              borderRadius: 12,
              padding: 20,
              background: "var(--bg-1)",
              fontSize: 13,
              color: "var(--fg-muted)",
            }}
          >
            No hay perfiles de búsqueda todavía. Crea uno en{" "}
            <Link href="/profiles" style={{ color: "var(--accent)", textDecoration: "none" }}>
              Perfiles
            </Link>{" "}
            para empezar a capturar.
          </div>
        ) : (
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <label htmlFor="captura-profile-select" style={{ fontSize: 13, color: "var(--fg-muted)" }}>
              Perfil
            </label>
            <select
              id="captura-profile-select"
              data-testid="captura-profile-select"
              value={selectedId ?? ""}
              onChange={(e) => setSelectedId(Number(e.target.value))}
              style={{
                fontSize: 13,
                padding: "7px 10px",
                borderRadius: 8,
                border: "1px solid var(--border)",
                background: "var(--bg-1)",
                color: "var(--fg)",
                minWidth: 220,
              }}
            >
              {profiles.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
            <button
              data-testid="captura-refresh"
              onClick={() => selectedId !== null && fetchDetail(selectedId)}
              disabled={detailLoading || selectedId === null}
              style={{
                fontSize: 13,
                fontWeight: 600,
                padding: "7px 14px",
                borderRadius: 8,
                border: "1px solid var(--border)",
                background: "var(--bg-1)",
                color: "var(--fg)",
                cursor: detailLoading ? "not-allowed" : "pointer",
                opacity: detailLoading ? 0.6 : 1,
              }}
            >
              {detailLoading ? "Actualizando…" : "Actualizar"}
            </button>
          </div>
        )}
      </section>

      {/* Task list grouped by portal */}
      {selectedId !== null && profiles.length > 0 && (
        <section style={{ marginTop: 20 }} data-testid="captura-tasks">
          {detailLoading && tasks.length === 0 ? (
            <div
              data-testid="captura-detail-loading"
              style={{ height: 120, borderRadius: 12, background: "var(--bg-1)", border: "1px solid var(--border)", opacity: 0.6 }}
            />
          ) : tasks.length === 0 ? (
            <p data-testid="captura-tasks-empty" style={{ fontSize: 13, color: "var(--fg-muted)" }}>
              Este perfil no tiene ninguna tarea de captura disponible todavía.
            </p>
          ) : (
            <>
              <p
                data-testid="captura-totals"
                style={{ fontSize: 13, color: "var(--fg-muted)", marginTop: 0, marginBottom: 12 }}
              >
                {totals.due} de {totals.tasks} tareas por hacer en {totals.portals} portal
                {totals.portals === 1 ? "" : "es"} · {totals.done} al día ·{" "}
                <strong style={{ color: "var(--fg)" }}>{totals.captured}</strong> propiedad
                {totals.captured === 1 ? "" : "es"} capturada{totals.captured === 1 ? "" : "s"}
              </p>

              <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
                {groups.map((g) => {
                  const summary = summaryByPortal.get(g.portal) ?? null;
                  const act = activityByPortal.get(g.portal) ?? null;
                  const captured = act?.captured ?? 0;
                  const pct =
                    summary && summary.total > 0
                      ? Math.round((summary.captured / summary.total) * 100)
                      : 0;
                  return (
                    <div key={g.portal} data-testid={`captura-portal-${g.portal}`}>
                      {/* Portal group header: name + REAL capture activity
                          (extension_capture) as the headline, plus the seeded
                          worklist roll-up (for batch runs) as a secondary line. */}
                      <div
                        style={{
                          display: "flex",
                          alignItems: "baseline",
                          gap: 10,
                          flexWrap: "wrap",
                          marginBottom: 8,
                        }}
                      >
                        <strong style={{ fontSize: 15, color: "var(--fg)" }}>{g.label}</strong>
                        {/* Headline: what ACTUALLY landed, whether batch-harvested
                            or captured one detail page at a time. Never empty when
                            captures are happening. */}
                        <span
                          data-testid={`captura-activity-${g.portal}`}
                          style={{ fontSize: 12, color: captured > 0 ? "var(--up)" : "var(--fg-muted)", fontWeight: captured > 0 ? 600 : 400 }}
                        >
                          {captured > 0
                            ? `${captured} propiedad${captured === 1 ? "" : "es"} capturada${captured === 1 ? "" : "s"} · última ${relativeAgo(act?.lastCapturedAt ?? null, now)}`
                            : "sin capturas todavía"}
                        </span>
                        {/* Secondary: seeded-worklist status (batch runs only). */}
                        {summary ? (
                          <span
                            data-testid={`captura-captured-${g.portal}`}
                            style={{ fontSize: 12, color: "var(--fg-muted)" }}
                          >
                            lista: {summary.captured}/{summary.total} · {summary.pending} pendientes · {pct}%
                          </span>
                        ) : (
                          <span
                            data-testid={`captura-nolist-${g.portal}`}
                            style={{ fontSize: 12, color: "var(--fg-muted)" }}
                          >
                            sin lista de captura
                          </span>
                        )}
                      </div>

                      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                        {g.tasks.map((task) => {
                          const lastRunAt = runs[task.id] ?? null;
                          const st = taskStaleness(
                            lastRunAt,
                            resolveStalenessDays(task.portal, staleness),
                            now,
                          );
                          return (
                            <CaptureTaskRow
                              key={task.id}
                              task={task}
                              muted={st.muted}
                              lastDone={lastDoneLabel(lastRunAt, now)}
                              lastRunAt={lastRunAt}
                              onExecute={onExecute}
                            />
                          );
                        })}
                      </div>
                    </div>
                  );
                })}
              </div>
            </>
          )}
        </section>
      )}
    </main>
  );
}
