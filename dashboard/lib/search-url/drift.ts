/**
 * Deterministic portal filter-DRIFT detection (issue #371, D-090) — CLIENT-SAFE,
 * pure, NO LLM.
 *
 * URL building is 100% code-driven from each connector's hard-coded per-portal
 * map (aliseda `TYPE_MAP`, idealista `OPERATION_BY_TYPE`). Those maps silently
 * drift as portals re-label options, add a new property type, or change a
 * `subtipo` code. Instead of self-healing the URL from a discovered catalog
 * (the #339/D-063 behaviour this supersedes), we DETECT the drift: diff the
 * portal's captured filter catalog (`portal_filter_catalog`) against the
 * connector's own code mapping and FLAG it so the owner updates the code.
 *
 * The diff is a deterministic set/label/code comparison keyed by the URL SLUG
 * (last path segment of a catalog option's `urlFragment`, which is exactly what
 * a code mapping emits):
 *   - ADDED   — the portal offers a slug the code doesn't map (e.g. Aliseda
 *               adds a real `aticos` option while the code folds ático→pisos).
 *   - REMOVED — the code maps a slug the portal no longer offers.
 *   - CHANGED — a slug present on both sides whose `subtipo` code differs, or
 *               whose portal label no longer resolves to the canonical type the
 *               code maps that slug to.
 *
 * Only the `property_type` axis is diffed today (the only axis wired end to end);
 * the shape is open to more axes without a signature change.
 */

import type { CatalogAxes, CatalogAxis, CatalogOption } from "./discovered-mapping";
import { canonicalPropertyType, lastPathSegment } from "./discovered-mapping";
import type { PropertyType } from "./types";

/**
 * One option in a connector's CODE mapping — the URL slug it emits (the diff
 * identity), a human label for the report, the `subtipo` code it emits (if the
 * portal encodes one), and the canonical type it maps that slug to (used to
 * detect a label change on the portal side). A connector exposes these via
 * `PortalSearchUrlBuilder.codeMapping()`.
 */
export interface CodeMappingOption {
  /** URL slug the code emits (last path segment) — identity for the diff. */
  slug: string;
  /** Human-facing label for the drift report. */
  label: string;
  /** The `subtipo` the code emits, if any (Aliseda residential subtypes). */
  code?: number;
  /** Canonical type the code maps this slug to (enables label-drift detection). */
  canonicalType?: PropertyType;
}

/** A connector's code mapping, per axis. */
export type CodeMappingAxes = Partial<Record<CatalogAxis, CodeMappingOption[]>>;

/** One drifted option on one axis. Fields are populated per drift kind. */
export interface DriftItem {
  /** The URL slug the drift is about. */
  slug: string;
  /** The portal's label for this slug (present for ADDED / CHANGED). */
  portalLabel?: string;
  /** The code's label for this slug (present for REMOVED / CHANGED). */
  codeLabel?: string;
  /** The portal's `subtipo` for this slug, if any. */
  portalCode?: number;
  /** The code's `subtipo` for this slug, if any. */
  codeCode?: number;
  /** Human, Spanish-facing note on what changed (CHANGED only). */
  reason?: string;
}

/** The drift on one axis: options added / removed / changed. */
export interface AxisDrift {
  axis: CatalogAxis;
  added: DriftItem[];
  removed: DriftItem[];
  changed: DriftItem[];
}

/** The full drift report for one connector. */
export interface PortalDriftReport {
  connector: string;
  /** True when a catalog has been captured for this connector at all. */
  hasCatalog: boolean;
  /** True when any axis shows any added / removed / changed option. */
  hasDrift: boolean;
  axes: AxisDrift[];
}

/** Total drifted-option count across every axis of a report. */
export function driftCount(report: PortalDriftReport): number {
  return report.axes.reduce(
    (n, a) => n + a.added.length + a.removed.length + a.changed.length,
    0,
  );
}

/**
 * Reduce a catalog's options for one axis to a slug→option map. When two
 * options share a slug the first wins (deterministic; catalogs rarely repeat a
 * slug, and if they do the earliest enumerated is representative).
 */
function catalogBySlug(options: readonly CatalogOption[]): Map<string, CatalogOption> {
  const bySlug = new Map<string, CatalogOption>();
  for (const opt of options) {
    const slug = lastPathSegment(opt.urlFragment);
    if (!slug) continue;
    if (!bySlug.has(slug)) bySlug.set(slug, opt);
  }
  return bySlug;
}

/** Reduce a code mapping's options for one axis to a slug→option map (first wins). */
function codeBySlug(options: readonly CodeMappingOption[]): Map<string, CodeMappingOption> {
  const bySlug = new Map<string, CodeMappingOption>();
  for (const opt of options) {
    if (!opt.slug) continue;
    if (!bySlug.has(opt.slug)) bySlug.set(opt.slug, opt);
  }
  return bySlug;
}

/**
 * Deterministically diff one axis: the portal's captured options vs the code
 * mapping's options, keyed by URL slug. Results are sorted by slug so the report
 * is stable across runs.
 */
export function computeAxisDrift(
  axis: CatalogAxis,
  catalogOptions: readonly CatalogOption[],
  codeOptions: readonly CodeMappingOption[],
): AxisDrift {
  const catalog = catalogBySlug(catalogOptions);
  const code = codeBySlug(codeOptions);

  const added: DriftItem[] = [];
  const removed: DriftItem[] = [];
  const changed: DriftItem[] = [];

  // Portal → code: slugs the portal offers that the code doesn't map (ADDED),
  // and slugs on both sides whose code/label drifted (CHANGED).
  for (const [slug, opt] of catalog) {
    const codeOpt = code.get(slug);
    const portalCode = typeof opt.subtipo === "number" ? opt.subtipo : undefined;
    if (!codeOpt) {
      added.push({ slug, portalLabel: opt.label, portalCode });
      continue;
    }
    const reasons: string[] = [];
    if (
      portalCode !== undefined &&
      codeOpt.code !== undefined &&
      portalCode !== codeOpt.code
    ) {
      reasons.push(`el código «subtipo» cambió (${codeOpt.code} → ${portalCode})`);
    }
    if (
      codeOpt.canonicalType !== undefined &&
      canonicalPropertyType(opt.label) !== codeOpt.canonicalType
    ) {
      reasons.push(
        `la etiqueta del portal («${opt.label}») ya no corresponde al tipo «${codeOpt.canonicalType}»`,
      );
    }
    if (reasons.length > 0) {
      changed.push({
        slug,
        portalLabel: opt.label,
        codeLabel: codeOpt.label,
        portalCode,
        codeCode: codeOpt.code,
        reason: reasons.join("; "),
      });
    }
  }

  // Code → portal: slugs the code maps that the portal no longer offers (REMOVED).
  for (const [slug, codeOpt] of code) {
    if (catalog.has(slug)) continue;
    removed.push({ slug, codeLabel: codeOpt.label, codeCode: codeOpt.code });
  }

  const bySlug = (a: DriftItem, b: DriftItem) => a.slug.localeCompare(b.slug);
  return {
    axis,
    added: added.sort(bySlug),
    removed: removed.sort(bySlug),
    changed: changed.sort(bySlug),
  };
}

/**
 * Compute the full drift report for one connector: diff every axis the code
 * maps against the captured catalog. `catalogAxes` is null when no catalog has
 * been captured yet (→ `hasCatalog:false`, no drift — you can't drift from a
 * baseline you never captured). Pure.
 */
export function computePortalDrift(
  connector: string,
  catalogAxes: CatalogAxes | null,
  codeMapping: CodeMappingAxes,
): PortalDriftReport {
  if (!catalogAxes) {
    return { connector, hasCatalog: false, hasDrift: false, axes: [] };
  }

  const axes: AxisDrift[] = [];
  for (const axis of Object.keys(codeMapping) as CatalogAxis[]) {
    const codeOptions = codeMapping[axis];
    if (!codeOptions || codeOptions.length === 0) continue;
    const catalogOptions = catalogAxes[axis] ?? [];
    axes.push(computeAxisDrift(axis, catalogOptions, codeOptions));
  }

  const hasDrift = axes.some(
    (a) => a.added.length > 0 || a.removed.length > 0 || a.changed.length > 0,
  );
  return { connector, hasCatalog: true, hasDrift, axes };
}
