"use client";

import { useState, useRef, useEffect } from "react";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DateRange {
  from: Date;
  to: Date;
}

export type ComparisonType =
  | "none"
  | "previous_period"
  | "previous_month"
  | "previous_quarter"
  | "previous_year"
  | "yoy"
  | "custom";

export interface ComparisonRange {
  type: ComparisonType;
  from: Date;
  to: Date;
}

export interface DateRangePickerProps {
  value: DateRange;
  onChange: (range: { primary: DateRange; comparison?: ComparisonRange }) => void;
}

export type PeriodType = "day" | "week" | "month" | "quarter" | "year";

export interface DetectPeriodOptions {
  /** When "Trimestre actual" is selected, treat Apr 1→today as quarter instead of month. */
  preferQuarterOverMonth?: boolean;
}

export type FormatPeriodLabelOptions = DetectPeriodOptions & {
  /**
   * When set, label as this calendar period even if {@link detectPeriodType} differs
   * (e.g. "Semana actual" on a Monday matches a single day).
   */
  navPeriodOverride?: PeriodType;
};

// ---------------------------------------------------------------------------
// Presets
// ---------------------------------------------------------------------------

interface Preset {
  label: string;
  range: () => DateRange;
  /** Period used for ← / → and for the trigger label after this preset is applied. */
  navPeriod: PeriodType;
}

export function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0, 0);
}

export function endOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59, 999);
}

// ISO week: Monday = day 1. Returns the Monday of the week containing `d`.
export function isoWeekMonday(d: Date): Date {
  const day = d.getDay(); // 0 = Sun, 1 = Mon, ..., 6 = Sat
  const diff = day === 0 ? -6 : 1 - day; // shift so Monday = 0
  const monday = new Date(d);
  monday.setDate(d.getDate() + diff);
  return monday;
}

export function currentQuarterStart(d: Date): Date {
  const q = Math.floor(d.getMonth() / 3);
  return new Date(d.getFullYear(), q * 3, 1);
}

// Current-period presets (in-progress)
export const CURRENT_PRESETS: Preset[] = [
  {
    label: "Hoy",
    navPeriod: "day",
    range: () => {
      const now = new Date();
      return { from: startOfDay(now), to: endOfDay(now) };
    },
  },
  {
    label: "Semana actual",
    navPeriod: "week",
    range: () => {
      const now = new Date();
      const monday = isoWeekMonday(now);
      return { from: startOfDay(monday), to: endOfDay(now) };
    },
  },
  {
    label: "Mes actual",
    navPeriod: "month",
    range: () => {
      const now = new Date();
      const firstOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
      return { from: startOfDay(firstOfMonth), to: endOfDay(now) };
    },
  },
  {
    label: "Trimestre actual",
    navPeriod: "quarter",
    range: () => {
      const now = new Date();
      return { from: startOfDay(currentQuarterStart(now)), to: endOfDay(now) };
    },
  },
  {
    label: "Año actual",
    navPeriod: "year",
    range: () => {
      const now = new Date();
      const jan1 = new Date(now.getFullYear(), 0, 1);
      return { from: startOfDay(jan1), to: endOfDay(now) };
    },
  },
];

// Previous-period presets (complete periods)
export const PREVIOUS_PRESETS: Preset[] = [
  {
    label: "Ayer",
    navPeriod: "day",
    range: () => {
      const yesterday = new Date();
      yesterday.setDate(yesterday.getDate() - 1);
      return { from: startOfDay(yesterday), to: endOfDay(yesterday) };
    },
  },
  {
    label: "Semana anterior",
    navPeriod: "week",
    range: () => {
      const now = new Date();
      const thisMonday = isoWeekMonday(now);
      const prevSunday = new Date(thisMonday);
      prevSunday.setDate(thisMonday.getDate() - 1);
      const prevMonday = new Date(thisMonday);
      prevMonday.setDate(thisMonday.getDate() - 7);
      return { from: startOfDay(prevMonday), to: endOfDay(prevSunday) };
    },
  },
  {
    label: "Mes anterior",
    navPeriod: "month",
    range: () => {
      const now = new Date();
      const firstOfThisMonth = new Date(now.getFullYear(), now.getMonth(), 1);
      const lastOfPrevMonth = new Date(firstOfThisMonth);
      lastOfPrevMonth.setDate(0); // last day of prev month
      const firstOfPrevMonth = new Date(lastOfPrevMonth.getFullYear(), lastOfPrevMonth.getMonth(), 1);
      return { from: startOfDay(firstOfPrevMonth), to: endOfDay(lastOfPrevMonth) };
    },
  },
  {
    label: "Trimestre anterior",
    navPeriod: "quarter",
    range: () => {
      const now = new Date();
      const thisQStart = currentQuarterStart(now);
      const prevQEnd = new Date(thisQStart);
      prevQEnd.setDate(0); // last day of month before this quarter
      const prevQStart = currentQuarterStart(prevQEnd);
      return { from: startOfDay(prevQStart), to: endOfDay(prevQEnd) };
    },
  },
  {
    label: "Año anterior",
    navPeriod: "year",
    range: () => {
      const prevYear = new Date().getFullYear() - 1;
      return {
        from: new Date(prevYear, 0, 1, 0, 0, 0, 0),
        to: new Date(prevYear, 11, 31, 23, 59, 59, 999),
      };
    },
  },
];

// ---------------------------------------------------------------------------
// Period detection
// ---------------------------------------------------------------------------

/** Options for {@link navigatePeriod}; extends {@link DetectPeriodOptions}. */
export type NavigatePeriodOptions = DetectPeriodOptions & {
  /**
   * When set, step by this period instead of {@link detectPeriodType}.
   * Used to disambiguate presets (e.g. "Semana actual" on a Monday is the same
   * calendar range as "Hoy" but must advance by ISO weeks, not single days).
   */
  periodType?: PeriodType;
};

/**
 * Detect whether a DateRange matches a known calendar period.
 * Returns null for custom/rolling ranges.
 * In-progress periods (to == end-of-today) are recognised for each type.
 */
export function detectPeriodType(
  range: DateRange,
  opts?: DetectPeriodOptions,
): PeriodType | null {
  const { from, to } = range;
  const today = new Date();
  const todayEnd = endOfDay(today);

  const fromMidnight =
    from.getHours() === 0 &&
    from.getMinutes() === 0 &&
    from.getSeconds() === 0 &&
    from.getMilliseconds() === 0;
  const toEndOfDay =
    to.getHours() === 23 &&
    to.getMinutes() === 59 &&
    to.getSeconds() === 59 &&
    to.getMilliseconds() === 999;

  if (!fromMidnight || !toEndOfDay) return null;

  const toIsToday = to.getTime() === todayEnd.getTime();

  // Day: same calendar day
  if (
    from.getFullYear() === to.getFullYear() &&
    from.getMonth() === to.getMonth() &&
    from.getDate() === to.getDate()
  ) {
    return "day";
  }

  // Week: from is ISO Monday, to is the following Sunday (or today for current week)
  const monday = isoWeekMonday(from);
  if (
    monday.getFullYear() === from.getFullYear() &&
    monday.getMonth() === from.getMonth() &&
    monday.getDate() === from.getDate()
  ) {
    const sunday = new Date(monday);
    sunday.setDate(monday.getDate() + 6);
    const expectedTo = endOfDay(sunday);
    const currentWeekMonday = isoWeekMonday(today);
    const isCurrentWeek =
      from.getFullYear() === currentWeekMonday.getFullYear() &&
      from.getMonth() === currentWeekMonday.getMonth() &&
      from.getDate() === currentWeekMonday.getDate();
    if (to.getTime() === expectedTo.getTime() || (toIsToday && isCurrentWeek)) {
      return "week";
    }
  }

  if (opts?.preferQuarterOverMonth && toIsToday) {
    const qStart = currentQuarterStart(today);
    const fromIsQuarterStart =
      from.getFullYear() === qStart.getFullYear() &&
      from.getMonth() === qStart.getMonth() &&
      from.getDate() === 1;
    if (fromIsQuarterStart) {
      return "quarter";
    }
  }

  // Month: from is 1st of month, to is last of that same month (or today in that month)
  if (from.getDate() === 1) {
    const lastDay = new Date(from.getFullYear(), from.getMonth() + 1, 0);
    const expectedTo = endOfDay(lastDay);
    if (to.getTime() === expectedTo.getTime()) {
      return "month";
    }
    if (
      toIsToday &&
      from.getFullYear() === to.getFullYear() &&
      from.getMonth() === to.getMonth()
    ) {
      return "month";
    }
  }

  // Quarter: from is 1st of a quarter start month (Jan/Apr/Jul/Oct),
  // to is last of that quarter (or today for current quarter past month 1)
  const qStartMonth = Math.floor(from.getMonth() / 3) * 3;
  if (from.getDate() === 1 && from.getMonth() === qStartMonth) {
    const lastOfQ = new Date(from.getFullYear(), qStartMonth + 3, 0);
    const expectedTo = endOfDay(lastOfQ);
    if (to.getTime() === expectedTo.getTime()) {
      return "quarter";
    }
    if (toIsToday) {
      // Only call it a quarter if we're past the first month of the quarter,
      // to avoid colliding with the 'month' case above.
      const qStart = currentQuarterStart(today);
      const isCurrentQ =
        from.getFullYear() === qStart.getFullYear() &&
        from.getMonth() === qStart.getMonth();
      if (isCurrentQ && today.getMonth() !== qStartMonth) {
        return "quarter";
      }
    }
  }

  // Year: from is Jan 1, to is Dec 31 (or today for current year past January)
  if (from.getMonth() === 0 && from.getDate() === 1) {
    const dec31 = new Date(from.getFullYear(), 11, 31);
    const expectedTo = endOfDay(dec31);
    if (to.getTime() === expectedTo.getTime()) {
      return "year";
    }
    if (
      toIsToday &&
      from.getFullYear() === today.getFullYear() &&
      today.getMonth() !== 0
    ) {
      return "year";
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Period navigation
// ---------------------------------------------------------------------------

/**
 * Shift a DateRange by one period in the given direction.
 * The period type is detected automatically. Returns range unchanged for null (custom).
 * When navigating forward into the current period, `to` = end-of-today.
 */
export function navigatePeriod(
  range: DateRange,
  direction: -1 | 1,
  opts?: NavigatePeriodOptions,
): DateRange {
  const type = opts?.periodType ?? detectPeriodType(range, opts);
  if (type === null) return range;

  const today = new Date();
  const todayEnd = endOfDay(today);

  function clampTo(newFrom: Date, fullTo: Date): Date {
    return fullTo.getTime() > todayEnd.getTime() && newFrom.getTime() <= today.getTime()
      ? todayEnd
      : fullTo;
  }

  switch (type) {
    case "day": {
      const d = new Date(range.from);
      d.setDate(d.getDate() + direction);
      return { from: startOfDay(d), to: endOfDay(d) };
    }
    case "week": {
      const newMonday = new Date(range.from);
      newMonday.setDate(newMonday.getDate() + direction * 7);
      const newFrom = startOfDay(newMonday);
      const sunday = new Date(newMonday);
      sunday.setDate(newMonday.getDate() + 6);
      return { from: newFrom, to: clampTo(newFrom, endOfDay(sunday)) };
    }
    case "month": {
      const newFrom = new Date(range.from.getFullYear(), range.from.getMonth() + direction, 1);
      const lastDay = new Date(newFrom.getFullYear(), newFrom.getMonth() + 1, 0);
      return { from: startOfDay(newFrom), to: clampTo(newFrom, endOfDay(lastDay)) };
    }
    case "quarter": {
      const newFrom = new Date(range.from.getFullYear(), range.from.getMonth() + direction * 3, 1);
      const lastDay = new Date(newFrom.getFullYear(), newFrom.getMonth() + 3, 0);
      return { from: startOfDay(newFrom), to: clampTo(newFrom, endOfDay(lastDay)) };
    }
    case "year": {
      const newYear = range.from.getFullYear() + direction;
      const newFrom = new Date(newYear, 0, 1);
      const dec31 = new Date(newYear, 11, 31);
      return { from: startOfDay(newFrom), to: clampTo(newFrom, endOfDay(dec31)) };
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function toDateInputValue(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** Compact Spanish range: year once when both dates share the same year. */
function formatCustomRangeCompact(range: DateRange): string {
  const sameYear = range.from.getFullYear() === range.to.getFullYear();
  const fromPart = range.from.toLocaleDateString("es-ES", {
    day: "numeric",
    month: "short",
    ...(sameYear ? {} : { year: "numeric" }),
  });
  const toPart = range.to.toLocaleDateString("es-ES", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
  return `${fromPart} – ${toPart}`;
}

const MONTH_LONG_YEAR_FMT = new Intl.DateTimeFormat("es-ES", {
  month: "long",
  year: "numeric",
});

function sameCalendarDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

/** ISO week number (1–53) for the Monday-based week containing *d*. */
function isoWeekNumber(d: Date): number {
  const utc = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const dayNum = utc.getUTCDay() || 7;
  utc.setUTCDate(utc.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(utc.getUTCFullYear(), 0, 1));
  return Math.ceil(((utc.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
}

const QUARTER_SHORT = ["ene-mar", "abr-jun", "jul-sep", "oct-dic"] as const;

/**
 * Human-readable label for the date-range trigger (Spanish).
 * Falls back to a compact range when the range is not a recognised calendar period.
 */
export function formatPeriodLabel(
  range: DateRange,
  opts?: FormatPeriodLabelOptions,
): string {
  const { navPeriodOverride, ...detectOpts } = opts ?? {};
  const detected = detectPeriodType(range, detectOpts);
  const type = navPeriodOverride ?? detected;
  if (type === null) {
    return formatCustomRangeCompact(range);
  }

  const todayStart = startOfDay(new Date());

  if (type === "day") {
    if (sameCalendarDay(range.from, todayStart)) return "Hoy";
    const y = new Date(todayStart);
    y.setDate(y.getDate() - 1);
    if (sameCalendarDay(range.from, y)) return "Ayer";
    return range.from.toLocaleDateString("es-ES", {
      weekday: "short",
      day: "numeric",
      month: "short",
      year: "numeric",
    });
  }

  if (type === "week") {
    const week = isoWeekNumber(range.from);
    const fromStr = range.from.toLocaleDateString("es-ES", { day: "numeric", month: "short" });
    const toStr = range.to.toLocaleDateString("es-ES", {
      day: "numeric",
      month: "short",
      year: "numeric",
    });
    const mondayThisWeek = isoWeekMonday(new Date());
    const isCurrentWeek = sameCalendarDay(isoWeekMonday(range.from), mondayThisWeek);
    if (isCurrentWeek) {
      return `Semana ${week} • ${fromStr} →`;
    }
    return `Semana ${week} • ${fromStr}–${toStr}`;
  }

  if (type === "month") {
    return MONTH_LONG_YEAR_FMT.format(range.from);
  }

  if (type === "quarter") {
    const q = Math.floor(range.from.getMonth() / 3) + 1;
    const y = range.from.getFullYear();
    return `T${q} ${y} • ${QUARTER_SHORT[q - 1]}`;
  }

  if (type === "year") {
    return String(range.from.getFullYear());
  }

  return formatCustomRangeCompact(range);
}

// ---------------------------------------------------------------------------
// computeComparisonRange
// ---------------------------------------------------------------------------

export function computeComparisonRange(
  primary: DateRange,
  type: ComparisonType,
): { from: Date; to: Date } | null {
  if (type === "none" || type === "custom") return null;

  const pFrom = primary.from;
  const pTo = primary.to;

  switch (type) {
    case "previous_period": {
      const durationMs = pTo.getTime() - pFrom.getTime();
      const compTo = new Date(pFrom.getTime() - 1);
      const compFrom = new Date(compTo.getTime() - durationMs);
      return { from: compFrom, to: compTo };
    }
    case "previous_month": {
      const y = pFrom.getFullYear();
      const m = pFrom.getMonth();
      const prevMonth = m === 0 ? 11 : m - 1;
      const prevYear = m === 0 ? y - 1 : y;
      return {
        from: new Date(prevYear, prevMonth, 1, 0, 0, 0, 0),
        to: new Date(prevYear, prevMonth + 1, 0, 23, 59, 59, 999),
      };
    }
    case "previous_quarter": {
      const y = pFrom.getFullYear();
      const m = pFrom.getMonth();
      const currentQ = Math.floor(m / 3);
      const prevQ = currentQ === 0 ? 3 : currentQ - 1;
      const prevYear = currentQ === 0 ? y - 1 : y;
      const fromMonth = prevQ * 3;
      return {
        from: new Date(prevYear, fromMonth, 1, 0, 0, 0, 0),
        to: new Date(prevYear, fromMonth + 3, 0, 23, 59, 59, 999),
      };
    }
    case "previous_year": {
      const prevYear = pFrom.getFullYear() - 1;
      return {
        from: new Date(prevYear, 0, 1, 0, 0, 0, 0),
        to: new Date(prevYear, 11, 31, 23, 59, 59, 999),
      };
    }
    case "yoy": {
      const fromYoY = new Date(pFrom);
      fromYoY.setFullYear(fromYoY.getFullYear() - 1);
      const toYoY = new Date(pTo);
      toYoY.setFullYear(toYoY.getFullYear() - 1);
      return { from: fromYoY, to: toYoY };
    }
  }
}

// ---------------------------------------------------------------------------
// Comparison labels
// ---------------------------------------------------------------------------

const COMPARISON_LABELS: Record<ComparisonType, string> = {
  none: "Sin comparación",
  previous_period: "Período anterior",
  previous_month: "Mes anterior",
  previous_quarter: "Trimestre anterior",
  previous_year: "Año anterior (completo)",
  yoy: "Año sobre año (YoY)",
  custom: "Personalizado",
};

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/**
 * Date range picker with presets.
 * Designed to be used in the dashboard toolbar as a UX control for selecting
 * a date range. The picker itself only provides the selected range via `onChange`.
 * Callers are responsible for using the range to filter data — either by
 * re-running widget queries (e.g., incrementing refreshKey), by passing the
 * range to the LLM to regenerate SQL, or by applying `injectDateRange()` when
 * the widget SQL selects the date column directly.
 *
 * Usage:
 *   <DateRangePicker value={dateRange} onChange={handleDateRangeChange} />
 */
export function DateRangePicker({ value, onChange }: DateRangePickerProps) {
  const [open, setOpen] = useState(false);
  /** When non-null, ← / → use this period even if the range matches another (e.g. Mon-only current week). */
  const [navPeriodMode, setNavPeriodMode] = useState<PeriodType | null>(null);
  const [preferQuarterForLabel, setPreferQuarterForLabel] = useState(false);
  const [customFrom, setCustomFrom] = useState(toDateInputValue(value.from));
  const [customTo, setCustomTo] = useState(toDateInputValue(value.to));
  /** Default to previous calendar period so comparison_sql charts work without extra UX steps. */
  const [comparisonType, setComparisonType] = useState<ComparisonType>("previous_period");
  const [compCustomFrom, setCompCustomFrom] = useState("");
  const [compCustomTo, setCompCustomTo] = useState("");
  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  // Close on outside click
  useEffect(() => {
    function handleOutside(e: MouseEvent) {
      if (
        containerRef.current &&
        !containerRef.current.contains(e.target as Node)
      ) {
        setOpen(false);
      }
    }
    if (open) {
      document.addEventListener("mousedown", handleOutside);
    }
    return () => document.removeEventListener("mousedown", handleOutside);
  }, [open]);

  // Close on Escape key and return focus to trigger
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        setOpen(false);
        triggerRef.current?.focus();
      }
    }
    if (open) {
      document.addEventListener("keydown", handleKeyDown);
    }
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [open]);

  // Sync custom inputs when value changes externally
  useEffect(() => {
    setCustomFrom(toDateInputValue(value.from));
    setCustomTo(toDateInputValue(value.to));
  }, [value]);

  function buildPayload(
    primary: DateRange,
    cType: ComparisonType,
    cCustomFrom: string,
    cCustomTo: string,
  ): { primary: DateRange; comparison?: ComparisonRange } {
    if (cType === "none") return { primary };

    if (cType === "custom") {
      const from = new Date(cCustomFrom + "T00:00:00.000");
      const to = new Date(cCustomTo + "T23:59:59.999");
      if (!isNaN(from.getTime()) && !isNaN(to.getTime()) && from <= to) {
        return { primary, comparison: { type: "custom", from, to } };
      }
      return { primary };
    }

    const computed = computeComparisonRange(primary, cType);
    if (!computed) return { primary };
    return { primary, comparison: { type: cType, ...computed } };
  }

  function applyPreset(preset: Preset) {
    setPreferQuarterForLabel(preset.label === "Trimestre actual");
    setNavPeriodMode(preset.navPeriod);
    const primary = preset.range();
    onChange(buildPayload(primary, comparisonType, compCustomFrom, compCustomTo));
    setOpen(false);
    triggerRef.current?.focus();
  }

  function applyCustomRange() {
    setPreferQuarterForLabel(false);
    setNavPeriodMode(null);
    const from = new Date(customFrom + "T00:00:00.000");
    // Use T23:59:59.999 for consistency with endOfDay() used by presets
    const to = new Date(customTo + "T23:59:59.999");
    if (!isNaN(from.getTime()) && !isNaN(to.getTime()) && from <= to) {
      const primary = { from, to };
      onChange(buildPayload(primary, comparisonType, compCustomFrom, compCustomTo));
      setOpen(false);
      triggerRef.current?.focus();
    }
  }

  function handleComparisonTypeChange(cType: ComparisonType) {
    setComparisonType(cType);
    if (cType !== "custom") {
      onChange(buildPayload(value, cType, compCustomFrom, compCustomTo));
    }
  }

  const comparisonHint =
    comparisonType !== "none" && comparisonType !== "custom"
      ? computeComparisonRange(value, comparisonType)
      : null;

  const isComparisonActive = comparisonType !== "none";

  const periodDetectOpts: DetectPeriodOptions | undefined = preferQuarterForLabel
    ? { preferQuarterOverMonth: true }
    : undefined;
  const labelOpts: FormatPeriodLabelOptions = {
    ...periodDetectOpts,
    ...(navPeriodMode != null ? { navPeriodOverride: navPeriodMode } : {}),
  };
  const detectedPeriod = detectPeriodType(value, periodDetectOpts);
  const effectiveNavPeriod = navPeriodMode ?? detectedPeriod;
  const showNavButtons = effectiveNavPeriod !== null;
  const navigateOpts: NavigatePeriodOptions = {
    ...periodDetectOpts,
    ...(effectiveNavPeriod != null ? { periodType: effectiveNavPeriod } : {}),
  };

  // → is disabled when the next period starts after today
  const nextPeriod = showNavButtons ? navigatePeriod(value, 1, navigateOpts) : null;
  const startOfToday = startOfDay(new Date());
  const forwardDisabled = nextPeriod !== null && nextPeriod.from > startOfToday;

  // ---------------------------------------------------------------------------
  // Style helpers (B2 design)
  // ---------------------------------------------------------------------------

  const arrowBtnStyle: React.CSSProperties = {
    padding: "7px 10px",
    border: "none",
    background: "transparent",
    color: "var(--fg-muted)",
    cursor: "pointer",
    fontSize: 14,
    lineHeight: 1,
    display: "flex",
    alignItems: "center",
    opacity: 1,
  };

  const sectionLabelStyle: React.CSSProperties = {
    fontFamily: "var(--font-jetbrains, monospace)",
    fontSize: 10,
    textTransform: "uppercase",
    letterSpacing: "0.1em",
    color: "var(--fg-subtle)",
    marginBottom: 6,
  };

  const presetBtnStyle = (active: boolean): React.CSSProperties => ({
    display: "block",
    width: "100%",
    textAlign: "left",
    padding: "6px 8px",
    background: active ? "var(--accent-soft)" : "transparent",
    color: active ? "var(--accent)" : "var(--fg)",
    border: "none",
    borderRadius: 4,
    fontSize: 12,
    cursor: "pointer",
    fontFamily: "inherit",
    fontWeight: active ? 600 : 400,
  });

  // color-scheme is inherited from :root[data-theme] in globals.css — no inline override needed.
  const dateInputStyle: React.CSSProperties = {
    display: "block",
    width: "100%",
    marginTop: 4,
    padding: "7px 9px",
    background: "var(--bg-2)",
    border: "1px solid var(--border)",
    borderRadius: 6,
    color: "var(--fg)",
    fontSize: 12,
    fontFamily: "inherit",
    boxSizing: "border-box",
  };

  const activeCurrentPresetLabel = CURRENT_PRESETS.find((p) => {
    const r = p.range();
    const tolerance = 1000;
    return (
      value.from.getTime() >= r.from.getTime() - tolerance &&
      value.from.getTime() <= r.from.getTime() + tolerance &&
      value.to.getTime() >= r.to.getTime() - tolerance &&
      value.to.getTime() <= r.to.getTime() + tolerance
    );
  })?.label;

  return (
    <div style={{ position: "relative" }} ref={containerRef} data-testid="date-range-picker">
      {/* Pill trigger with prev/next arrows */}
      <div
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 0,
          border: "1px solid var(--border-strong)",
          borderRadius: 6,
          overflow: "hidden",
          background: "var(--bg-1)",
          fontSize: 12,
        }}
      >
        {/* Prev arrow */}
        {showNavButtons && (
          <button
            type="button"
            data-testid="nav-prev"
            aria-label="Período anterior"
            style={arrowBtnStyle}
            onClick={() =>
              onChange(
                buildPayload(
                  navigatePeriod(value, -1, navigateOpts),
                  comparisonType,
                  compCustomFrom,
                  compCustomTo,
                ),
              )
            }
          >
            ‹
          </button>
        )}

        {/* Trigger */}
        <button
          ref={triggerRef}
          type="button"
          onClick={() => setOpen((prev) => !prev)}
          style={{
            padding: "7px 12px",
            borderLeft: showNavButtons ? "1px solid var(--border)" : "none",
            borderRight: showNavButtons ? "1px solid var(--border)" : "none",
            display: "flex",
            alignItems: "center",
            gap: 8,
            background: "transparent",
            border: showNavButtons ? undefined : "none",
            color: "var(--fg)",
            cursor: "pointer",
            fontFamily: "inherit",
            fontSize: 12,
          }}
          aria-label="Seleccionar rango de fechas"
          aria-expanded={open}
          aria-haspopup="dialog"
        >
          {/* Calendar icon */}
          <svg
            width="13"
            height="13"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            style={{ color: "var(--fg-muted)", flexShrink: 0 }}
            aria-hidden="true"
          >
            <rect x="3" y="4" width="18" height="18" rx="2" />
            <path d="M16 2v4M8 2v4M3 10h18" />
          </svg>
          <span>{formatPeriodLabel(value, labelOpts)}</span>
          {isComparisonActive && (
            <span
              data-testid="vs-badge"
              style={{
                fontSize: 10,
                padding: "2px 6px",
                borderRadius: 3,
                background: "var(--accent-soft)",
                color: "var(--accent)",
                fontFamily: "var(--font-jetbrains, monospace)",
              }}
            >
              vs
            </span>
          )}
        </button>

        {/* Next arrow */}
        {showNavButtons && (
          <button
            type="button"
            data-testid="nav-next"
            aria-label="Período siguiente"
            disabled={forwardDisabled}
            style={{
              ...arrowBtnStyle,
              opacity: forwardDisabled ? 0.4 : 1,
              cursor: forwardDisabled ? "not-allowed" : "pointer",
            }}
            onClick={() =>
              onChange(
                buildPayload(
                  navigatePeriod(value, 1, navigateOpts),
                  comparisonType,
                  compCustomFrom,
                  compCustomTo,
                ),
              )
            }
          >
            ›
          </button>
        )}
      </div>

      {/* Dropdown panel (440px, right-aligned) */}
      {open && (
        <div
          role="dialog"
          aria-label="Selector de rango de fechas"
          style={{
            position: "absolute",
            top: "calc(100% + 6px)",
            right: 0,
            zIndex: 40,
            width: 440,
            background: "var(--bg-1)",
            border: "1px solid var(--border-strong)",
            borderRadius: 10,
            boxShadow: "0 18px 40px -10px rgba(0,0,0,0.5)",
            fontSize: 12,
            overflow: "hidden",
          }}
        >
          {/* Two-column preset grid */}
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr" }}>
            <div style={{ padding: "14px 16px", borderRight: "1px solid var(--border)" }}>
              <div style={sectionLabelStyle}>Período actual</div>
              {CURRENT_PRESETS.map((preset) => (
                <button
                  key={preset.label}
                  type="button"
                  onClick={() => applyPreset(preset)}
                  style={presetBtnStyle(activeCurrentPresetLabel === preset.label)}
                >
                  {preset.label}
                </button>
              ))}
            </div>
            <div style={{ padding: "14px 16px" }}>
              <div style={sectionLabelStyle}>Período anterior</div>
              {PREVIOUS_PRESETS.map((preset) => (
                <button
                  key={preset.label}
                  type="button"
                  onClick={() => applyPreset(preset)}
                  style={presetBtnStyle(false)}
                >
                  {preset.label}
                </button>
              ))}
            </div>
          </div>

          {/* Custom range */}
          <div style={{ padding: "14px 16px", borderTop: "1px solid var(--border)" }}>
            <div style={sectionLabelStyle}>Rango personalizado</div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginTop: 6 }}>
              <label style={{ fontSize: 11, color: "var(--fg-muted)" }}>
                Desde
                <input
                  type="date"
                  value={customFrom}
                  onChange={(e) => setCustomFrom(e.target.value)}
                  style={dateInputStyle}
                />
              </label>
              <label style={{ fontSize: 11, color: "var(--fg-muted)" }}>
                Hasta
                <input
                  type="date"
                  value={customTo}
                  onChange={(e) => setCustomTo(e.target.value)}
                  style={dateInputStyle}
                />
              </label>
            </div>
            <button
              type="button"
              onClick={applyCustomRange}
              style={{
                marginTop: 10,
                width: "100%",
                height: 34,
                background: "var(--accent)",
                color: "#fff",
                border: "none",
                borderRadius: 6,
                fontSize: 12,
                fontWeight: 600,
                cursor: "pointer",
                fontFamily: "inherit",
              }}
            >
              Aplicar
            </button>
          </div>

          {/* Comparison period footer */}
          <div
            style={{
              padding: "12px 16px",
              borderTop: "1px solid var(--border)",
              background: "var(--bg-2)",
            }}
          >
            <div style={sectionLabelStyle}>Período de comparación</div>
            <select
              data-testid="comparison-type-select"
              value={comparisonType}
              onChange={(e) =>
                handleComparisonTypeChange(e.target.value as ComparisonType)
              }
              style={{
                width: "100%",
                marginTop: 4,
                padding: "8px 10px",
                background: "var(--bg-1)",
                border: "1px solid var(--border-strong)",
                borderRadius: 6,
                color: "var(--fg)",
                fontSize: 12,
                fontFamily: "inherit",
                boxSizing: "border-box",
              }}
            >
              {(Object.keys(COMPARISON_LABELS) as ComparisonType[]).map((key) => (
                <option key={key} value={key}>
                  {COMPARISON_LABELS[key]}
                </option>
              ))}
            </select>

            {comparisonHint && (
              <p
                data-testid="comparison-hint"
                style={{
                  fontSize: 11,
                  color: "var(--fg-subtle)",
                  marginTop: 6,
                  fontFamily: "var(--font-jetbrains, monospace)",
                }}
              >
                {formatPeriodLabel(comparisonHint)}
              </p>
            )}

            {comparisonType === "custom" && (
              <div style={{ marginTop: 8, display: "flex", flexDirection: "column", gap: 8 }}>
                <label style={{ fontSize: 11, color: "var(--fg-muted)" }}>
                  Comp. desde
                  <input
                    type="date"
                    data-testid="comp-custom-from"
                    value={compCustomFrom}
                    onChange={(e) => setCompCustomFrom(e.target.value)}
                    style={dateInputStyle}
                  />
                </label>
                <label style={{ fontSize: 11, color: "var(--fg-muted)" }}>
                  Comp. hasta
                  <input
                    type="date"
                    data-testid="comp-custom-to"
                    value={compCustomTo}
                    onChange={(e) => setCompCustomTo(e.target.value)}
                    style={dateInputStyle}
                  />
                </label>
                <button
                  type="button"
                  data-testid="apply-comparison-btn"
                  onClick={() =>
                    onChange(
                      buildPayload(value, "custom", compCustomFrom, compCustomTo),
                    )
                  }
                  style={{
                    width: "100%",
                    height: 34,
                    background: "var(--accent)",
                    color: "#fff",
                    border: "none",
                    borderRadius: 6,
                    fontSize: 12,
                    fontWeight: 600,
                    cursor: "pointer",
                    fontFamily: "inherit",
                  }}
                >
                  Aplicar comparación
                </button>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Date range injection helper
// ---------------------------------------------------------------------------

/**
 * Inject a date range filter into a SQL query by wrapping it as a subquery.
 *
 * **Important limitation**: this helper only works when the original query's
 * SELECT list includes `dateColumn` (the raw date column). Many aggregate
 * queries (e.g. GROUP BY) do not select the raw date — in those cases,
 * the date range should be applied inside the original SQL's WHERE clause
 * instead. Use this helper only for simple row-level queries.
 *
 * Example output (using default `fecha_creacion` column):
 *   SELECT * FROM (<original sql>) AS _drp_q
 *   WHERE _drp_q.fecha_creacion BETWEEN '2026-01-01' AND '2026-03-31'
 *
 * @param sql - original SQL query (must SELECT `dateColumn` to work correctly)
 * @param range - date range to apply
 * @param dateColumn - column name to filter on (default: 'fecha_creacion')
 * @returns SQL with date filter applied via subquery
 */
/**
 * Pattern for safe SQL identifiers: letters, digits, and underscores only.
 * This prevents injection when `dateColumn` originates from untrusted input.
 */
const SAFE_IDENTIFIER_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

export function injectDateRange(
  sql: string,
  range: DateRange,
  dateColumn = "fecha_creacion",
): string {
  if (!SAFE_IDENTIFIER_RE.test(dateColumn)) {
    throw new Error(
      `injectDateRange: dateColumn '${dateColumn}' is not a valid SQL identifier. ` +
      `Only letters, digits, and underscores are allowed.`
    );
  }
  // Trim a single trailing semicolon so the SQL can be embedded in a subquery.
  // Multi-statement SQL (multiple semicolons) is rejected at the server by the
  // read-only validator in /api/query.
  const normalizedSql = sql.trimEnd().replace(/;$/, "");
  const from = toDateInputValue(range.from);
  const to = toDateInputValue(range.to);
  // Wrap in subquery and apply date filter
  return `SELECT * FROM (${normalizedSql}) AS _drp_q WHERE _drp_q.${dateColumn} BETWEEN '${from}' AND '${to}'`;
}
