"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { DashboardSpec, GlobalFilter } from "@/lib/schema";
import type { GlobalFilterValues } from "@/lib/sql-filters";
import type { DateRange } from "./DateRangePicker";
import { FilterCombobox } from "./FilterCombobox";

export interface DashboardFiltersBarProps {
  dashboardId: number;
  spec: DashboardSpec;
  dateRange?: DateRange;
  value: GlobalFilterValues;
  onChange: (next: GlobalFilterValues) => void;
}

type OptionRow = { value: string; label: string };

/** HTML form value is always string — coerce stored numbers for controlled value. */
function singleSelectFormValue(
  filter: GlobalFilter,
  value: GlobalFilterValues,
): string {
  const raw = value[filter.id];
  if (raw === undefined || raw === null) return "";
  if (typeof raw === "number" && Number.isFinite(raw)) return String(raw);
  if (typeof raw === "string") return raw;
  return "";
}

function multiSelectFormValue(
  filter: GlobalFilter,
  value: GlobalFilterValues,
): string[] {
  const raw = value[filter.id];
  if (!Array.isArray(raw)) return [];
  if (filter.value_type === "numeric") {
    return (raw as unknown[])
      .filter((x): x is number => typeof x === "number" && Number.isFinite(x))
      .map(String);
  }
  return (raw as string[]).filter((x) => typeof x === "string");
}

async function postOptions(
  body: Record<string, unknown>,
): Promise<OptionRow[]> {
  const res = await fetch("/api/dashboard/filters/options", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const j = await res.json().catch(() => null);
    const msg =
      j && typeof j === "object" && "error" in j && typeof j.error === "string"
        ? j.error
        : "Error al cargar opciones";
    throw new Error(msg);
  }
  const data = (await res.json()) as { options?: OptionRow[] };
  return Array.isArray(data.options) ? data.options : [];
}


// ---------------------------------------------------------------------------
// DashboardFiltersBar
// ---------------------------------------------------------------------------

export function DashboardFiltersBar({
  dashboardId,
  spec,
  dateRange,
  value,
  onChange,
}: DashboardFiltersBarProps) {
  const filters = useMemo(() => spec.filters ?? [], [spec.filters]);
  const [optionsById, setOptionsById] = useState<Record<string, OptionRow[]>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState<Record<string, boolean>>({});

  const rangePayload = useMemo(() => {
    if (!dateRange) return undefined;
    return { from: dateRange.from.toISOString(), to: dateRange.to.toISOString() };
  }, [dateRange]);

  const loadOptions = useCallback(
    async (filter: GlobalFilter) => {
      setLoading((m) => ({ ...m, [filter.id]: true }));
      setErrors((m) => {
        const n = { ...m };
        delete n[filter.id];
        return n;
      });
      try {
        const opts = await postOptions({
          dashboardId,
          filterId: filter.id,
          dateRange: rangePayload,
          activeFilters: value,
        });
        setOptionsById((m) => ({ ...m, [filter.id]: opts }));
      } catch (e) {
        setErrors((m) => ({
          ...m,
          [filter.id]: e instanceof Error ? e.message : "Error",
        }));
      } finally {
        setLoading((m) => ({ ...m, [filter.id]: false }));
      }
    },
    [dashboardId, rangePayload, value],
  );

  useEffect(() => {
    if (filters.length === 0) return;
    let cancelled = false;
    void (async () => {
      for (const f of filters) {
        if (cancelled) return;
        await loadOptions(f);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [filters, loadOptions]);

  if (filters.length === 0) return null;

  const hasActiveFilters = filters.some((f) => {
    const v = value[f.id];
    return v !== undefined && v !== null && v !== "" && !(Array.isArray(v) && v.length === 0);
  });

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 10,
        padding: "10px 20px",
        borderTop: "1px solid var(--border)",
        borderBottom: "1px solid var(--border)",
        background: "var(--bg-1)",
        flexWrap: "wrap",
      }}
      data-testid="global-filters-bar"
      className="no-print"
    >
      {/* Lead label */}
      <span
        style={{
          fontSize: 11,
          color: "var(--fg-subtle)",
          fontFamily: "var(--font-jetbrains, monospace)",
          textTransform: "uppercase",
          letterSpacing: "0.08em",
          marginRight: 4,
          flexShrink: 0,
        }}
      >
        FILTROS
      </span>

      {filters.map((f) => {
        const fOptions = optionsById[f.id] ?? [];
        const fError = errors[f.id];
        const fLoading = !!loading[f.id];
        return (
          <div key={f.id} style={{ display: "flex", flexDirection: "column", gap: 4, minWidth: 200 }}>
            <label
              htmlFor={`gf-${f.id}`}
              style={{ fontSize: 11, color: "var(--fg-muted)", fontFamily: "var(--font-jetbrains, monospace)" }}
            >
              {f.label}
            </label>
            {f.type === "single_select" ? (
              <FilterCombobox
                id={f.id}
                label={f.label}
                options={fOptions}
                loading={fLoading}
                error={fError ?? null}
                value={singleSelectFormValue(f, value)}
                onChange={(v) => {
                  const next = { ...value };
                  if (!v) delete next[f.id];
                  else if (f.value_type === "numeric") {
                    const n = Number(v);
                    next[f.id] = Number.isFinite(n) ? n : v;
                  } else {
                    next[f.id] = v;
                  }
                  onChange(next);
                }}
              />
            ) : (
              <FilterCombobox
                id={f.id}
                label={f.label}
                multiple
                options={fOptions}
                loading={fLoading}
                error={fError ?? null}
                value={multiSelectFormValue(f, value)}
                onChange={(selected) => {
                  const next = { ...value };
                  if (selected.length === 0) delete next[f.id];
                  else if (f.value_type === "numeric") {
                    next[f.id] = selected
                      .map((s) => Number(s))
                      .filter((n) => Number.isFinite(n));
                  } else {
                    next[f.id] = selected;
                  }
                  onChange(next);
                }}
              />
            )}
          </div>
        );
      })}

      {/* Spacer */}
      <div style={{ flex: 1 }} />

      {/* Clear filters */}
      {hasActiveFilters && (
        <button
          type="button"
          onClick={() => onChange({})}
          style={{
            background: "transparent",
            border: "none",
            cursor: "pointer",
            fontSize: 11,
            color: "var(--fg-muted)",
            fontFamily: "inherit",
            padding: "4px 8px",
          }}
        >
          Limpiar filtros
        </button>
      )}
    </div>
  );
}
