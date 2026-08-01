import type { DateRange } from "@/components/DateRangePicker";
import type { TimeRangePreset, DefaultTimeRange } from "@/lib/schema";

function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0, 0);
}

function endOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59, 999);
}

export function toISODateString(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export function substituteTimeRange(sql: string, from: string, to: string): string {
  return sql.replaceAll("{{date_from}}", from).replaceAll("{{date_to}}", to);
}

export function presetToDateRange(preset: TimeRangePreset): DateRange {
  const now = new Date();
  switch (preset) {
    case "today":
      return { from: startOfDay(now), to: endOfDay(now) };
    case "last_7_days": {
      const from = new Date(now);
      from.setDate(from.getDate() - 6);
      return { from: startOfDay(from), to: endOfDay(now) };
    }
    case "last_30_days": {
      const from = new Date(now);
      from.setDate(from.getDate() - 29);
      return { from: startOfDay(from), to: endOfDay(now) };
    }
    case "current_month": {
      const from = new Date(now.getFullYear(), now.getMonth(), 1);
      return { from: startOfDay(from), to: endOfDay(now) };
    }
    case "last_month": {
      const lastMonthEnd = new Date(now.getFullYear(), now.getMonth(), 0);
      const lastMonthStart = new Date(lastMonthEnd.getFullYear(), lastMonthEnd.getMonth(), 1);
      return { from: startOfDay(lastMonthStart), to: endOfDay(lastMonthEnd) };
    }
    case "year_to_date": {
      const from = new Date(now.getFullYear(), 0, 1);
      return { from: startOfDay(from), to: endOfDay(now) };
    }
  }
}

export function defaultTimeRangeToDateRange(defaultTimeRange: DefaultTimeRange | undefined): DateRange {
  return presetToDateRange(defaultTimeRange?.preset ?? "last_30_days");
}
