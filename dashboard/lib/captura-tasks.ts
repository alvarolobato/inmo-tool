/**
 * Task-driven Captura — pure view-model helpers (issue #289).
 *
 * The task-driven `/captura` page renders one openable capture TASK per
 * (profile × portal × searchable section). The task list comes from the
 * restructured search-url builder:
 *
 *   GET /api/profiles/[id]/search-urls
 *     → { profileId, name, tasks: CaptureTask[] }
 *
 * where each task is `{ id, portal, label, url, loosened[] }` and `id` is
 * STABLE/DETERMINISTIC for the same profile+filters (so a last-run row keyed by
 * (profile_id, task_id) survives a page reload or a rebuild of the same scope).
 *
 * This module is the single place that:
 *   1. Normalises the search-urls response into `CaptureTask[]` — consuming the
 *      real `tasks[]` (#296 SearchTask[], the live shape), with a transitional
 *      fallback that adapts the pre-#296 `urls[]` shape (one url per portal).
 *      See {@link normalizeTasks}.
 *   2. Computes the STALENESS state of a task from its last-run timestamp + the
 *      configured window → due / muted (grey). Graying is a visual due-or-not
 *      cue only; the button is never blocked. See {@link taskStaleness}.
 *
 * Kept pure (no `pg`, no React, no config I/O) so the page, the API route, and
 * the unit tests all import the same logic. Client-safe: only a type import.
 */

import type { LoosenedConstraint } from "@/lib/search-url";

/**
 * One openable capture task as the Captura page renders it. Mirrors the
 * restructured search-url builder's `tasks[]` element (issue #289 data
 * contract): one task per (portal × searchable section).
 */
export interface CaptureTask {
  /** Stable/deterministic id for this profile+filters — the task-run key. */
  id: string;
  /** Portal key — matches `CAPTURE_PORTALS[].portal` in lib/worklist.ts. */
  portal: string;
  /** Human label for the task (e.g. "Idealista · Viviendas"). */
  label: string;
  /** The pre-filtered search URL this task opens. */
  url: string;
  /** Constraints the portal's URL grammar had to broaden (never narrow). */
  loosened: LoosenedConstraint[];
}

/** The two response shapes {@link normalizeTasks} accepts. */
interface TasksResponse {
  tasks?: unknown;
  urls?: unknown;
}

/** Title-case a portal key for a fallback label ("idealista" → "Idealista"). */
export function portalTitle(portal: string): string {
  return portal.length > 0 ? portal[0].toUpperCase() + portal.slice(1) : portal;
}

/**
 * Deterministic short id for the LEGACY-shape fallback, so a task keeps the
 * same id across reloads for the same profile+filters. djb2 over `portal|url`,
 * base-36. Only used when the response lacks `tasks[]` (pre-restructure); once
 * the builder emits real `tasks[]` their own `id` is used verbatim.
 */
export function fallbackTaskId(portal: string, url: string): string {
  const seed = `${portal}|${url}`;
  let h = 5381;
  for (let i = 0; i < seed.length; i += 1) {
    h = (h * 33) ^ seed.charCodeAt(i);
  }
  // >>> 0 → unsigned; base36 keeps it short and url/attribute-safe.
  return `${portal}-${(h >>> 0).toString(36)}`;
}

function isTask(v: unknown): v is CaptureTask {
  if (v === null || typeof v !== "object") return false;
  const t = v as Record<string, unknown>;
  return (
    typeof t.id === "string" &&
    typeof t.portal === "string" &&
    typeof t.url === "string"
  );
}

/**
 * The legacy `urls[]` element shape (pre-#296 search-url response, one entry
 * per portal). #296 restructured the API to return `tasks[]` (SearchTask[]);
 * this local shape only backs the transitional fallback below.
 */
interface LegacyPortalUrl {
  portal: string;
  url: string;
  loosened?: LoosenedConstraint[];
}

function isLegacyUrl(v: unknown): v is LegacyPortalUrl {
  if (v === null || typeof v !== "object") return false;
  const u = v as Record<string, unknown>;
  return typeof u.portal === "string" && typeof u.url === "string";
}

/**
 * Normalise a `GET /api/profiles/[id]/search-urls` body into `CaptureTask[]`.
 *
 * - When the body carries `tasks[]` (the #296 restructured builder — SearchTask[],
 *   the real path today), it is used verbatim (with defensive defaults for
 *   `label`/`loosened`).
 * - The `urls[]` branch is a transitional/defensive fallback for the pre-#296
 *   response shape (one url per portal): it synthesises a stable `id`
 *   ({@link fallbackTaskId}) and a Title-case `label`. Now that #296 is merged
 *   the live API never hits it; TODO(#289): drop it in a follow-up. This thin
 *   adapter never re-implements the URL grammar — it only reshapes the response.
 */
export function normalizeTasks(body: TasksResponse | null | undefined): CaptureTask[] {
  if (!body || typeof body !== "object") return [];

  if (Array.isArray(body.tasks)) {
    return body.tasks.filter(isTask).map((t) => ({
      id: t.id,
      portal: t.portal,
      label: typeof t.label === "string" && t.label.trim() ? t.label : portalTitle(t.portal),
      url: t.url,
      loosened: Array.isArray(t.loosened) ? t.loosened : [],
    }));
  }

  if (Array.isArray(body.urls)) {
    return body.urls.filter(isLegacyUrl).map((u) => ({
      id: fallbackTaskId(u.portal, u.url),
      portal: u.portal,
      label: portalTitle(u.portal),
      url: u.url,
      loosened: Array.isArray(u.loosened) ? u.loosened : [],
    }));
  }

  return [];
}

// ─── Staleness ──────────────────────────────────────────────────────────────

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** The staleness state of one task, derived from its last run + the window. */
export interface TaskStaleness {
  /** True once a run was ever recorded. */
  done: boolean;
  /** True while a run sits INSIDE the staleness window (grey / not due). */
  muted: boolean;
  /** True when never done, or the window has elapsed (full colour / due). */
  due: boolean;
  /** Whole days since the last run (floored); null when never done. */
  ageDays: number | null;
}

/**
 * Pure staleness rule: given the last-run timestamp, the window (in days) and
 * "now", decide whether a task is due (full colour) or muted (greyed).
 *
 *   - never run                       → { done:false, muted:false, due:true }
 *   - run < window ago                → { done:true,  muted:true,  due:false }
 *   - run ≥ window ago                → { done:true,  muted:false, due:true  }
 *
 * A non-positive window means "always due" (never mute); an unparseable
 * timestamp is treated as never-run. Muting is a visual cue only — the caller
 * keeps the button clickable regardless.
 */
export function taskStaleness(
  lastRunAt: string | Date | null | undefined,
  windowDays: number,
  now: Date = new Date(),
): TaskStaleness {
  const last = lastRunAt == null ? null : lastRunAt instanceof Date ? lastRunAt : new Date(lastRunAt);
  if (last === null || Number.isNaN(last.getTime())) {
    return { done: false, muted: false, due: true, ageDays: null };
  }
  const ageMs = Math.max(0, now.getTime() - last.getTime());
  const ageDays = Math.floor(ageMs / MS_PER_DAY);
  if (!(windowDays > 0)) {
    return { done: true, muted: false, due: true, ageDays };
  }
  const withinWindow = ageMs < windowDays * MS_PER_DAY;
  return { done: true, muted: withinWindow, due: !withinWindow, ageDays };
}

/**
 * Spanish "last done" label for a task row: 'nunca' when never run, else
 * 'hecho hace <n> días' / 'hecho hace <n> h' / 'hecho hace unos segundos'.
 * Coarse by design (the exact minute is on hover via the timestamp title).
 */
export function lastDoneLabel(
  lastRunAt: string | Date | null | undefined,
  now: Date = new Date(),
): string {
  const last = lastRunAt == null ? null : lastRunAt instanceof Date ? lastRunAt : new Date(lastRunAt);
  if (last === null || Number.isNaN(last.getTime())) return "nunca";
  const ms = Math.max(0, now.getTime() - last.getTime());
  const mins = Math.floor(ms / 60000);
  if (mins < 1) return "hecho hace unos segundos";
  if (mins < 60) return `hecho hace ${mins} min`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `hecho hace ${hours} h`;
  const days = Math.floor(hours / 24);
  return `hecho hace ${days} día${days === 1 ? "" : "s"}`;
}

/**
 * Bare Spanish "hace X" relative label (no verb), or 'nunca' when null. Coarse
 * by design: 'hace unos segundos' / 'hace 5 min' / 'hace 3 h' / 'hace 2 días'.
 * Used for portal-level real-capture recency ("última captura hace …").
 */
export function relativeAgo(at: string | Date | null | undefined, now: Date = new Date()): string {
  const d = at == null ? null : at instanceof Date ? at : new Date(at);
  if (d === null || Number.isNaN(d.getTime())) return "nunca";
  const ms = Math.max(0, now.getTime() - d.getTime());
  const mins = Math.floor(ms / 60000);
  if (mins < 1) return "hace unos segundos";
  if (mins < 60) return `hace ${mins} min`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `hace ${hours} h`;
  const days = Math.floor(hours / 24);
  return `hace ${days} día${days === 1 ? "" : "s"}`;
}

// ─── Real capture activity (downstream result) ───────────────────────────────

/**
 * A portal's REAL capture activity — what actually landed in the pipeline
 * (`extension_capture` rows that reached 'done', by URL host), independent of
 * whether anything seeded `capture_worklist`. This is the truth the owner
 * cares about ("N propiedades capturadas, última hace X"): captures that came
 * from opening detail pages one by one seed NO worklist row, so a
 * worklist-only progress reads empty even when captures are happening. The
 * activity is GLOBAL per portal (extension_capture has no profile column),
 * framed against the profile whose tasks opened the portal — same framing as
 * the worklist roll-up.
 */
export interface PortalCaptureActivity {
  portal: string;
  /** Count of `extension_capture` rows (status='done') for this portal. */
  captured: number;
  /** ISO of the most recent such capture, or null if none. */
  lastCapturedAt: string | null;
}

// ─── Staleness-window config resolution ──────────────────────────────────────

/** Per-portal staleness overrides + the global default (all in days). */
export interface StalenessConfig {
  /** Global default window in days (always present; falls back to 7). */
  defaultDays: number;
  /** Per-portal overrides; a portal absent here inherits `defaultDays`. */
  byPortal: Record<string, number>;
}

/** Fallback window when nothing is configured — mirrors schema.yaml default. */
export const DEFAULT_STALENESS_DAYS = 7;

/** Resolve the staleness window (days) for one portal: per-portal ?? global. */
export function resolveStalenessDays(portal: string, config: StalenessConfig): number {
  const perPortal = config.byPortal[portal];
  if (typeof perPortal === "number" && perPortal > 0) return perPortal;
  return config.defaultDays > 0 ? config.defaultDays : DEFAULT_STALENESS_DAYS;
}

// ─── Grouping ────────────────────────────────────────────────────────────────

/** A portal and its tasks, preserving first-seen order (builder order). */
export interface PortalTaskGroup {
  portal: string;
  label: string;
  tasks: CaptureTask[];
}

/**
 * Group tasks by portal, preserving the order portals first appear in
 * (the builder emits portals in CAPTURE_PORTALS order; sections follow). The
 * group label is the portal's Title-case name.
 */
export function groupTasksByPortal(tasks: readonly CaptureTask[]): PortalTaskGroup[] {
  const order: string[] = [];
  const byPortal = new Map<string, CaptureTask[]>();
  for (const t of tasks) {
    if (!byPortal.has(t.portal)) {
      byPortal.set(t.portal, []);
      order.push(t.portal);
    }
    byPortal.get(t.portal)!.push(t);
  }
  return order.map((portal) => ({
    portal,
    label: portalTitle(portal),
    tasks: byPortal.get(portal)!,
  }));
}
