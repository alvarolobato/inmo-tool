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
  /**
   * The URL a HARVESTER should open (issue #529). Identical to `url` except an
   * Idealista map-view search, where it is the listing (card) form so anchors
   * harvest and capture arms. `url` stays canonical for display/pin (D-101).
   * Falls back to `url` when the response predates the field.
   */
  captureUrl: string;
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
      // #529: prefer the server-derived capture URL; fall back to url for an
      // older response shape (or a portal with no map view — they're equal).
      captureUrl: typeof t.captureUrl === "string" && t.captureUrl ? t.captureUrl : t.url,
      loosened: Array.isArray(t.loosened) ? t.loosened : [],
    }));
  }

  if (Array.isArray(body.urls)) {
    return body.urls.filter(isLegacyUrl).map((u) => ({
      id: fallbackTaskId(u.portal, u.url),
      portal: u.portal,
      label: portalTitle(u.portal),
      url: u.url,
      // Legacy shape carries no captureUrl → identity (#529).
      captureUrl: u.url,
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

// ─── Per-profile connector view-model (issue #413) ────────────────────────────
//
// The redesigned Captura page stacks ALL active profiles; under each profile its
// connectors (portals), each collapsible. The collapse/expand decision and the
// per-connector "toca / a-medias / al-día" state are derived here — purely from
// the SAME per-profile signal the task rows already use: each task's last-run
// timestamp (`capture_task_run.last_run_at`) versus the configured staleness
// window (the "cycle"). This is the only per-profile capture signal that exists
// (`capture_worklist` and `extension_capture` have no profile column), so the
// due/half-done logic is grounded in it. The "capturados" counter, by contrast,
// IS split per profile (issue #430) by joining extension_capture →
// profile_listing_state(matched) on property_id; the portal-global count is kept
// alongside as secondary context.
//
// Per task (existing rule, {@link taskStaleness}):
//   - never run, or run ≥ window ago → DUE (pending this cycle)
//   - run < window ago               → MUTED ("al día" / done this cycle)
//
// Per connector (profile × portal):
//   - not-due  → dueCount === 0                      (every task al día)   → COLLAPSED
//   - half-done→ dueCount > 0 AND mutedCount > 0     (some done, some not) → EXPANDED
//   - due      → dueCount > 0 AND mutedCount === 0   (nothing done yet)    → EXPANDED

/** A connector's actionable state within one profile. */
export type ConnectorState = "due" | "half-done" | "not-due";

/** One task with its computed staleness, ready to render. */
export interface ConnectorTaskView {
  task: CaptureTask;
  /** Done within its window → greyed / not due. */
  muted: boolean;
  /** Never run, or window elapsed → full colour / due. */
  due: boolean;
  /** ISO of the last run, or null when never run. */
  lastRunAt: string | null;
  /** Spanish "last done" label ('nunca' / 'hecho hace 3 días'). */
  lastDone: string;
}

/** One connector (portal) under a profile, with its tasks and state. */
export interface ConnectorView {
  portal: string;
  label: string;
  taskViews: ConnectorTaskView[];
  totalTasks: number;
  /** Tasks pending this cycle (never run or window elapsed). */
  dueCount: number;
  /** Tasks done this cycle (run within the window). */
  mutedCount: number;
  state: ConnectorState;
  /** Expanded by default when there is anything to do (due OR half-done). */
  defaultExpanded: boolean;
  /**
   * PER-PROFILE captured properties on this connector (issue #430): DISTINCT
   * `extension_capture` (status='done') properties that match THIS profile via
   * `profile_listing_state`. This is the only "capturados" figure the page shows
   * per profile — the page deliberately shows NO portal-global numbers (#445).
   *
   * CAVEAT: captures are not exclusive to one profile — a property matching two
   * profiles counts under both, so profiles' `capturedProfile` values can sum to
   * more than the number of distinct captured properties on the portal. Correct
   * reading: "this profile has that captured".
   */
  capturedProfile: number;
}

/** One active profile with its connectors (the stacked-page unit). */
export interface ProfileCaptureView {
  id: number;
  name: string;
  connectors: ConnectorView[];
  totalTasks: number;
  /** Connectors needing action (state !== 'not-due') — for the profile header. */
  actionableConnectors: number;
}

/**
 * Per-profile capture-progress summary for one connector's line (issue #433):
 * "capturados / total esperado · restantes". The owner wants the raw capture
 * count to sit next to how much is still expected, not float alone.
 *
 * The three numbers are kept in ONE basis so they RECONCILE by construction
 * (`captured + remaining === total`), which is what makes the line trustworthy:
 *   - captured  = `capturedProfile` — DISTINCT properties captured on this
 *                 connector that match THIS profile (issue #430/#431), the same
 *                 headline "capturados" figure the rest of the page shows;
 *   - remaining = `dueCount`        — tasks still pending this cycle (the "por
 *                 hacer" figure the due/half-done logic already derives — this
 *                 is display only, it never changes that logic);
 *   - total     = captured + remaining (the "pending+captured basis").
 * An empty connector (nothing captured, nothing due) reads 0 / 0 · 0. Both
 * inputs are floored at 0 defensively so the numbers can never go negative.
 */
export interface CaptureSummary {
  /** Per-profile captured properties on this connector (`capturedProfile`). */
  captured: number;
  /** Total expected = captured + remaining (pending+captured basis). */
  total: number;
  /** Still pending this cycle (`dueCount`). */
  remaining: number;
}

/** Compute the reconciling capture summary for a connector line (issue #433). */
export function captureSummary(
  connector: Pick<ConnectorView, "capturedProfile" | "dueCount">,
): CaptureSummary {
  const captured = Math.max(0, connector.capturedProfile);
  const remaining = Math.max(0, connector.dueCount);
  return { captured, total: captured + remaining, remaining };
}

/** Render the summary as the compact "12 / 40 · 28 restantes" line (issue #433). */
export function formatCaptureSummary(
  connector: Pick<ConnectorView, "capturedProfile" | "dueCount">,
): string {
  const { captured, total, remaining } = captureSummary(connector);
  return `${captured} / ${total} · ${remaining} restantes`;
}

/** The connector state from its due/muted task counts. Pure — see block above. */
export function deriveConnectorState(dueCount: number, mutedCount: number): ConnectorState {
  if (dueCount === 0) return "not-due";
  if (mutedCount > 0) return "half-done";
  return "due";
}

/**
 * Build the per-connector view-model for one profile's tasks. Groups by portal
 * (builder order), computes each task's staleness against its portal's window,
 * and folds those into the connector state + default collapse decision.
 * `capturedByConnector` (issue #430) carries THIS profile's per-connector
 * captured counts (connector key → count) as the only "capturados" figure;
 * a portal absent from it yields 0. Portal-global context (activity / worklist
 * roll-up) is intentionally NOT surfaced per profile (#445).
 */
export function buildConnectorViews(
  tasks: readonly CaptureTask[],
  runs: Record<string, string>,
  staleness: StalenessConfig,
  capturedByConnector: Readonly<Record<string, number>>,
  now: Date = new Date(),
): ConnectorView[] {
  return groupTasksByPortal(tasks).map((g) => {
    const windowDays = resolveStalenessDays(g.portal, staleness);
    let dueCount = 0;
    let mutedCount = 0;
    const taskViews: ConnectorTaskView[] = g.tasks.map((task) => {
      const lastRunAt = runs[task.id] ?? null;
      const st = taskStaleness(lastRunAt, windowDays, now);
      if (st.due) dueCount += 1;
      if (st.muted) mutedCount += 1;
      return {
        task,
        muted: st.muted,
        due: st.due,
        lastRunAt,
        lastDone: lastDoneLabel(lastRunAt, now),
      };
    });
    return {
      portal: g.portal,
      label: g.label,
      taskViews,
      totalTasks: g.tasks.length,
      dueCount,
      mutedCount,
      state: deriveConnectorState(dueCount, mutedCount),
      defaultExpanded: dueCount > 0,
      capturedProfile: capturedByConnector[g.portal] ?? 0,
    };
  });
}

// ─── "Capturar todo" batch selection (issue #556) ─────────────────────────
//
// Per-task checkboxes let the owner tick/untick which DUE (or done) tasks the
// global "Capturar todo" button acts on. These helpers are pure — no
// chrome/DOM/fetch — so the selection→queue mapping is unit-testable without a
// browser. The actual queuing mechanism (piggybacking the rest of the ticked
// tasks onto the first task's URL) lives in `lib/extension-capture.ts`
// (`withCaptureQueue`); this module only decides WHICH tasks start ticked and
// how a ticked set turns into an ORDERED CaptureTask[] to feed it.

/**
 * The task ids that start TICKED for a profile: every task that is currently
 * DUE (never run, or its staleness window elapsed) across every connector —
 * mirrors `ConnectorTaskView.due`, never re-derived. A muted (done-this-cycle)
 * task starts unticked but can be ticked back in by the owner (D-048: graying
 * is a visual cue, never a block).
 */
export function defaultTickedTaskIds(connectors: readonly ConnectorView[]): Set<string> {
  const ids = new Set<string>();
  for (const c of connectors) {
    for (const tv of c.taskViews) {
      if (tv.due) ids.add(tv.task.id);
    }
  }
  return ids;
}

/** Every task across a profile's connectors, in display order (portal, then task order). */
export function allProfileTasks(connectors: readonly ConnectorView[]): CaptureTask[] {
  return connectors.flatMap((c) => c.taskViews.map((tv) => tv.task));
}

/**
 * One resolved "Capturar todo" click: which task's tab actually opens (the
 * first ticked task, in display order) and which searches the extension's
 * OWN queue (#555/D-112) should run after it. `null` when nothing is ticked —
 * the caller must show a message and mutate nothing (issue #556 exit
 * criterion), never fall back to "capture everything".
 */
export interface CaptureBatchPlan {
  /** Every ticked task, in order — the caller records a `capture_task_run` for each. */
  taskIds: string[];
  /** The task whose tab is opened directly (in the click's user gesture). */
  first: CaptureTask;
  /** The rest, handed to the extension's queue via `withCaptureQueue`. */
  queue: { portal: string; captureUrl: string }[];
}

/**
 * Build the batch plan from the full task list + the ticked id set, preserving
 * `tasks`' display order (never the Set's insertion order — Sets don't
 * guarantee it and the owner expects the queue to run top-to-bottom as shown).
 * Pure; `null` when no ticked task is present in `tasks`.
 */
export function buildCaptureBatchPlan(
  tasks: readonly CaptureTask[],
  ticked: ReadonlySet<string>,
): CaptureBatchPlan | null {
  const selected = tasks.filter((t) => ticked.has(t.id));
  if (selected.length === 0) return null;
  const [first, ...rest] = selected;
  return {
    taskIds: selected.map((t) => t.id),
    first,
    queue: rest.map((t) => ({ portal: t.portal, captureUrl: t.captureUrl })),
  };
}

/** A capped batch plan, plus how many ticked tasks got dropped by the cap. */
export interface CappedCaptureBatchPlan {
  plan: CaptureBatchPlan;
  /** Ticked tasks that did NOT fit and were left un-queued and un-recorded. */
  droppedCount: number;
}

/**
 * Enforce a sane cap on how many searches ride behind the opened tab (issue
 * #556 review B3). Dropped tasks are NEVER recorded (`capture_task_run`) and
 * NEVER queued — recording a task as "done" when it was actually dropped
 * would be a worse lie than the one this cap exists to prevent. The caller
 * (`CapturaProfiles.onCapturarTodo`) tells the owner exactly how many
 * didn't fit so a second "Capturar todo" click (once the first batch drains)
 * picks up the remainder — nothing is silently lost, just deferred.
 * `maxQueueEntries` caps `plan.queue.length` (the FIRST task always rides
 * along regardless, since it costs nothing extra — only the piggybacked tail
 * is bounded). Pure; a no-op (droppedCount 0) when already within the cap.
 */
export function capCaptureBatchPlan(
  plan: CaptureBatchPlan,
  maxQueueEntries: number,
): CappedCaptureBatchPlan {
  if (plan.queue.length <= maxQueueEntries) return { plan, droppedCount: 0 };
  const droppedCount = plan.queue.length - maxQueueEntries;
  return {
    plan: {
      first: plan.first,
      queue: plan.queue.slice(0, maxQueueEntries),
      taskIds: plan.taskIds.slice(0, 1 + maxQueueEntries),
    },
    droppedCount,
  };
}

/**
 * Assemble one profile's full stacked-view model from its tasks + runs.
 * `capturedByProfileConnector` (issue #430) maps profile id → { connector →
 * captured count }; this profile's slice becomes each connector's primary
 * per-profile `capturedProfile`. A profile absent from the map contributes 0s.
 */
export function buildProfileCaptureView(
  profile: { id: number; name: string },
  tasks: readonly CaptureTask[],
  runs: Record<string, string>,
  staleness: StalenessConfig,
  capturedByProfileConnector: ReadonlyMap<number, Record<string, number>>,
  now: Date = new Date(),
): ProfileCaptureView {
  const connectors = buildConnectorViews(
    tasks,
    runs,
    staleness,
    capturedByProfileConnector.get(profile.id) ?? {},
    now,
  );
  return {
    id: profile.id,
    name: profile.name,
    connectors,
    totalTasks: connectors.reduce((a, c) => a + c.totalTasks, 0),
    actionableConnectors: connectors.filter((c) => c.state !== "not-due").length,
  };
}

// ─── Cross-profile "Capturar todo" (issue #559) ────────────────────────────
//
// #556/#558 built ONE button + ONE select-all/none PER PROFILE. The owner
// rejected that shape outright: asked, up front, "¿el botón es por perfil o
// global?" and answered "global, con los checks me apaño" — #556 was written
// as "one global button *for the selected profile*" regardless, which is
// per-profile. This section replaces the profile-scoped plan
// (`buildCaptureBatchPlan`/`capCaptureBatchPlan` above — kept, still
// unit-tested, and reused internally below) with a version that spans every
// profile the page currently shows.
//
// `CaptureTask.id` is only stable/deterministic "for the same profile +
// filters" (see the type doc on `CaptureTask.id`) — it is a hash of portal +
// normalized filters, NOT of the profile id, so two different profiles with
// identical filters can legitimately produce the SAME task id. Cross-profile
// selection therefore keys on the PAIR (profileId, taskId), never the bare
// task id, via {@link selectionKey}.

/** One task tagged with the profile it belongs to — the cross-profile selection unit. */
export interface ProfileTask {
  profileId: number;
  task: CaptureTask;
}

/**
 * Composite selection-set key. See the module note above: `CaptureTask.id`
 * alone is not unique across profiles, so every cross-profile ticked-set /
 * run-override map in `CapturaProfiles` is keyed by this pair, not by the
 * bare task id.
 */
export function selectionKey(profileId: number, taskId: string): string {
  return `${profileId}:${taskId}`;
}

/**
 * Every task across the given (caller-filtered) profiles, tagged with its
 * profile id, preserving profile order then each profile's own
 * connector/task display order.
 */
export function allTasksAcrossProfiles(profiles: readonly ProfileCaptureView[]): ProfileTask[] {
  return profiles.flatMap((p) => allProfileTasks(p.connectors).map((task) => ({ profileId: p.id, task })));
}

/**
 * Selection keys that start ticked across every given profile: every DUE
 * task, per profile (reuses {@link defaultTickedTaskIds} per profile
 * verbatim, never re-derived).
 */
export function defaultTickedSelectionKeys(profiles: readonly ProfileCaptureView[]): Set<string> {
  const keys = new Set<string>();
  for (const p of profiles) {
    for (const id of defaultTickedTaskIds(p.connectors)) keys.add(selectionKey(p.id, id));
  }
  return keys;
}

/** One entry the caller must record a `capture_task_run` for — which profile's endpoint it belongs to, plus the bare task id. */
export interface GlobalCaptureBatchEntry {
  profileId: number;
  taskId: string;
}

/** The cross-profile counterpart of {@link CaptureBatchPlan} (issue #559). */
export interface GlobalCaptureBatchPlan {
  /** Every ticked task, in display order — one `capture_task_run` POST per entry, to ITS OWN profile's endpoint. */
  entries: GlobalCaptureBatchEntry[];
  /** The task whose tab is opened directly (in the click's user gesture). */
  first: CaptureTask;
  /** The rest, handed to the extension's queue via `withCaptureQueue` — same `{portal, captureUrl}` shape regardless of which profile a task came from. */
  queue: { portal: string; captureUrl: string }[];
}

/**
 * Build the cross-profile batch plan. Reuses {@link buildCaptureBatchPlan}
 * VERBATIM over a profile-qualified id space (never re-implements the
 * selection/ordering logic) — display order is `profileTasks`' order
 * (typically {@link allTasksAcrossProfiles}: profile order, then each
 * profile's own connector/task order). `null` when nothing is ticked, same
 * contract as the profile-scoped version.
 */
export function buildGlobalCaptureBatchPlan(
  profileTasks: readonly ProfileTask[],
  ticked: ReadonlySet<string>,
): GlobalCaptureBatchPlan | null {
  const byKey = new Map<string, ProfileTask>();
  const keyedTasks: CaptureTask[] = profileTasks.map((pt) => {
    const key = selectionKey(pt.profileId, pt.task.id);
    byKey.set(key, pt);
    return { ...pt.task, id: key };
  });
  const plan = buildCaptureBatchPlan(keyedTasks, ticked);
  if (!plan) return null;
  // De-dupe the WIRE queue by (portal, captureUrl) while leaving `entries`
  // alone. `stableTaskId` hashes portal|section|location|price|size|rooms with
  // NO profile component (lib/search-url/task-id.ts), so two profiles with
  // identical filter tuples — "Rentabilidad Estepona" and "Flip Estepona",
  // same geography and bands — produce the SAME captureUrl. Before this, the
  // payload carried it twice and the extension really crawled it twice: the
  // second run re-walks every results page (up to RESULTS_PAGE_CAP=40, paced)
  // and then captures nothing. A wholly redundant walk against a portal we are
  // trying to be a good neighbour to, and it burns a MAX_QUEUE_ENTRIES slot
  // that would otherwise carry distinct work.
  //
  // `entries` is deliberately NOT de-duped: `capture_task_run` is keyed
  // (profile_id, task_id), so BOTH profiles legitimately get their ledger row
  // — the search genuinely ran for each of them. Only the wire is redundant.
  // Note the extension's own `enqueueSearch` dedupe cannot catch this: the
  // claimed run isn't in the queue it compares against.
  const wireKeyOf = (portal: string, captureUrl: string) => `${portal}\u0000${captureUrl}`;
  // Seed with `first` — it is opened directly rather than queued, so a queue
  // entry matching it is the same redundant crawl, just via the other door.
  const seenWire = new Set<string>([
    wireKeyOf(plan.first.portal, plan.first.captureUrl),
  ]);
  const dedupedQueue = plan.queue.filter((q) => {
    const wireKey = wireKeyOf(q.portal, q.captureUrl);
    if (seenWire.has(wireKey)) return false;
    seenWire.add(wireKey);
    return true;
  });
  return {
    entries: plan.taskIds.map((key) => {
      const pt = byKey.get(key)!;
      return { profileId: pt.profileId, taskId: pt.task.id };
    }),
    first: byKey.get(plan.first.id)!.task,
    queue: dedupedQueue,
  };
}

/** A capped {@link GlobalCaptureBatchPlan}, plus which VISIBLE profiles lost entries to the cap. */
export interface CappedGlobalCaptureBatchPlan {
  plan: GlobalCaptureBatchPlan;
  /** Ticked tasks that did NOT fit and were left un-queued and un-recorded. */
  droppedCount: number;
  /** Distinct profile ids with ≥1 dropped entry, in first-dropped order. */
  droppedProfileIds: number[];
}

/**
 * Same cap semantics as {@link capCaptureBatchPlan} (issue #556 review B3,
 * kept verbatim: a dropped task is NEVER queued and NEVER recorded — that
 * would be a worse lie than the cap exists to prevent), plus WHICH profiles
 * the dropped tail belonged to. The button now spans profiles (issue #559),
 * so the cap can bite mid-profile — the "no caben" status message names the
 * affected profiles, not just a bare count, so the owner knows where to
 * click again once this batch drains.
 */
export function capGlobalCaptureBatchPlan(
  plan: GlobalCaptureBatchPlan,
  maxQueueEntries: number,
): CappedGlobalCaptureBatchPlan {
  if (plan.queue.length <= maxQueueEntries) return { plan, droppedCount: 0, droppedProfileIds: [] };
  const droppedCount = plan.queue.length - maxQueueEntries;
  const droppedEntries = plan.entries.slice(1 + maxQueueEntries);
  return {
    plan: {
      first: plan.first,
      queue: plan.queue.slice(0, maxQueueEntries),
      entries: plan.entries.slice(0, 1 + maxQueueEntries),
    },
    droppedCount,
    droppedProfileIds: Array.from(new Set(droppedEntries.map((e) => e.profileId))),
  };
}
