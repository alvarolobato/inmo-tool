"use client";

/**
 * OpenRouterModelCombobox — searchable picker for the OpenRouter model
 * catalog (including per-endpoint provider + pricing rows), used by the
 * admin /config form for `dashboard.llm_model_openrouter*`.
 *
 * Stored value (`config_value`):
 *  - Auto routing: `vendor/model`
 *  - Pinned endpoint: `vendor/model\t{"only":["host/quant"],"allow_fallbacks":false}`
 *
 * Catalog: `GET /api/admin/openrouter-models` (cached server-side ~1 h).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

interface OpenRouterModel {
  row_key: string;
  config_value: string;
  model_id: string;
  provider_label: string;
  is_auto_row: boolean;
  name: string;
  description: string;
  context_length: number;
  prompt_price_per_1m: number | null;
  completion_price_per_1m: number | null;
  modality: string;
  supports_tools: boolean;
  popular: boolean;
}

interface CatalogResponse {
  models: OpenRouterModel[];
  cached_at: string;
  source: "openrouter" | "cache";
}

interface Props {
  value: string;
  onChange: (next: string) => void;
  disabled?: boolean;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fmtUSD(n: number | null): string {
  if (n == null) return "–";
  if (n === 0) return "gratis";
  const fixed = n >= 10 ? n.toFixed(1) : n >= 1 ? n.toFixed(2) : n.toFixed(3);
  return `$${fixed}`;
}

function fmtCtx(n: number): string {
  if (n <= 0) return "–";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
  return String(n);
}

function matches(model: OpenRouterModel, q: string): boolean {
  if (!q) return true;
  const needle = q.toLowerCase();
  return (
    model.model_id.toLowerCase().includes(needle) ||
    model.name.toLowerCase().includes(needle) ||
    model.description.toLowerCase().includes(needle) ||
    model.provider_label.toLowerCase().includes(needle) ||
    model.modality.toLowerCase().includes(needle)
  );
}

function sortRestRows(a: OpenRouterModel, b: OpenRouterModel): number {
  const byModel = a.model_id.localeCompare(b.model_id);
  if (byModel !== 0) return byModel;
  if (a.is_auto_row !== b.is_auto_row) return a.is_auto_row ? -1 : 1;
  return a.provider_label.localeCompare(b.provider_label);
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function OpenRouterModelCombobox({ value, onChange, disabled }: Props) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [models, setModels] = useState<OpenRouterModel[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [highlight, setHighlight] = useState(0);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (models !== null || error !== null) return;
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch("/api/admin/openrouter-models");
        if (!res.ok) throw new Error(`Error ${res.status}`);
        const json = (await res.json()) as CatalogResponse;
        if (!cancelled) setModels(json.models);
      } catch (e) {
        if (!cancelled) setError((e as Error).message);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [models, error]);

  useEffect(() => {
    if (!open) return;
    function onClick(ev: MouseEvent) {
      if (!containerRef.current) return;
      if (!containerRef.current.contains(ev.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, [open]);

  useEffect(() => {
    if (open) searchRef.current?.focus();
  }, [open]);

  const filtered = useMemo(() => {
    if (!models) return { popular: [], rest: [] };
    const popular: OpenRouterModel[] = [];
    const rest: OpenRouterModel[] = [];
    for (const m of models) {
      if (!matches(m, query)) continue;
      if (m.popular && m.is_auto_row) popular.push(m);
      else rest.push(m);
    }
    rest.sort(sortRestRows);
    return { popular, rest };
  }, [models, query]);

  const flat = useMemo(
    () => [...filtered.popular, ...filtered.rest],
    [filtered],
  );

  useEffect(() => {
    setHighlight(0);
  }, [query, models]);

  const onPick = useCallback(
    (configValue: string) => {
      onChange(configValue);
      setOpen(false);
      setQuery("");
    },
    [onChange],
  );

  const displaySummary = useMemo(() => {
    if (!value) return "";
    const row = models?.find((m) => m.config_value === value);
    if (row) {
      return row.is_auto_row ? row.model_id : `${row.model_id} · ${row.provider_label}`;
    }
    const tab = value.indexOf("\t");
    if (tab === -1) return value;
    return `${value.slice(0, tab)} · ruta personalizada`;
  }, [value, models]);

  if (error) {
    return (
      <div className="space-y-1">
        <input
          type="text"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          disabled={disabled}
          placeholder="anthropic/claude-sonnet-4"
          className="w-full min-w-[min(100%,42rem)] rounded-md border border-tremor-border dark:border-dark-tremor-border bg-tremor-background dark:bg-dark-tremor-background px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-blue-500 disabled:opacity-50"
        />
        <p className="text-xs text-amber-700 dark:text-amber-400">
          No se pudo cargar el catálogo de OpenRouter ({error}). Introduce el id manualmente.
        </p>
      </div>
    );
  }

  function onKey(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Escape") {
      setOpen(false);
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setHighlight((h) => Math.min(h + 1, flat.length - 1));
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      setHighlight((h) => Math.max(h - 1, 0));
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      const m = flat[highlight];
      if (m) onPick(m.config_value);
    }
  }

  return (
    <div
      ref={containerRef}
      className="relative w-full min-w-[min(100%,42rem)] max-w-[56rem]"
      data-testid="or-model-combobox"
    >
      <button
        type="button"
        onClick={() => !disabled && setOpen((o) => !o)}
        disabled={disabled}
        className="flex w-full min-h-[2.25rem] items-center justify-between gap-2 rounded-md border border-tremor-border dark:border-dark-tremor-border bg-tremor-background dark:bg-dark-tremor-background px-3 py-1.5 text-sm text-left focus:outline-none focus:ring-1 focus:ring-blue-500 disabled:opacity-50"
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <span className="min-w-0 flex-1 break-all font-mono text-xs leading-snug">
          {value ? (
            displaySummary
          ) : (
            <span className="italic text-tremor-content-subtle">Selecciona modelo y proveedor</span>
          )}
        </span>
        <span aria-hidden className="flex-shrink-0 text-tremor-content-subtle">
          ▾
        </span>
      </button>

      {open && (
        <div
          className="absolute left-0 z-30 mt-1 w-max min-w-full max-w-[min(56rem,calc(100vw-2rem))] max-h-[min(70vh,520px)] overflow-hidden rounded-md border border-tremor-border dark:border-dark-tremor-border bg-tremor-background dark:bg-dark-tremor-background shadow-lg"
          role="listbox"
        >
          <div className="border-b border-tremor-border dark:border-dark-tremor-border p-2">
            <input
              ref={searchRef}
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={onKey}
              placeholder="Buscar por modelo, proveedor, id o descripción…"
              className="w-full min-w-[20rem] rounded-md border border-tremor-border dark:border-dark-tremor-border bg-tremor-background dark:bg-dark-tremor-background px-2 py-1 text-sm focus:outline-none focus:ring-1 focus:ring-blue-500"
              data-testid="or-model-combobox-search"
            />
            {models === null && (
              <p className="mt-1 text-xs text-tremor-content-subtle">Cargando catálogo (incluye rutas por proveedor)…</p>
            )}
            {models !== null && (
              <p className="mt-1 text-xs text-tremor-content-subtle">
                {filtered.popular.length + filtered.rest.length} filas · precios USD / 1M tokens (por
                fila)
              </p>
            )}
          </div>

          <div ref={listRef} className="max-h-[min(58vh,440px)] overflow-y-auto">
            {filtered.popular.length > 0 && (
              <Section
                title="Populares (router automático)"
                rows={filtered.popular}
                indexBase={0}
                value={value}
                highlight={highlight}
                onPick={onPick}
              />
            )}
            {filtered.rest.length > 0 && (
              <Section
                title="Todos los modelos y proveedores"
                rows={filtered.rest}
                indexBase={filtered.popular.length}
                value={value}
                highlight={highlight}
                onPick={onPick}
              />
            )}
            {models !== null && filtered.popular.length + filtered.rest.length === 0 && (
              <p className="px-3 py-4 text-sm text-tremor-content-subtle">Ningún resultado coincide.</p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

interface SectionProps {
  title: string;
  rows: OpenRouterModel[];
  indexBase: number;
  value: string;
  highlight: number;
  onPick: (id: string) => void;
}

function Section({ title, rows, indexBase, value, highlight, onPick }: SectionProps) {
  return (
    <div>
      <div className="sticky top-0 bg-tremor-background dark:bg-dark-tremor-background px-3 py-1 text-xs font-semibold uppercase tracking-wider text-tremor-content-subtle">
        {title}
      </div>
      {rows.map((m, i) => {
        const flatIndex = indexBase + i;
        const isCurrent = m.config_value === value;
        const isHighlight = flatIndex === highlight;
        return (
          <button
            key={m.row_key}
            type="button"
            onClick={() => onPick(m.config_value)}
            className={
              "block w-full px-3 py-2 text-left text-sm hover:bg-tremor-background-subtle dark:hover:bg-dark-tremor-background-subtle " +
              (isHighlight
                ? "bg-tremor-background-subtle dark:bg-dark-tremor-background-subtle "
                : "") +
              (isCurrent ? "ring-1 ring-blue-500 ring-inset" : "")
            }
            data-testid={`or-model-row-${m.row_key}`}
          >
            <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
              <span className="font-medium">{m.name}</span>
              <span className="rounded bg-black/5 px-1.5 py-0 font-mono text-[11px] text-tremor-content-subtle dark:bg-white/10">
                {m.provider_label}
              </span>
              <span className="font-mono text-xs text-tremor-content-subtle">{m.model_id}</span>
              {m.supports_tools && (
                <span className="rounded-full bg-emerald-100 px-1.5 py-0 text-[10px] text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-300">
                  tools
                </span>
              )}
              {isCurrent && (
                <span className="rounded-full bg-blue-100 px-1.5 py-0 text-[10px] text-blue-800 dark:bg-blue-900/30 dark:text-blue-300">
                  actual
                </span>
              )}
            </div>
            <div className="mt-0.5 flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-tremor-content-subtle">
              <span>ctx {fmtCtx(m.context_length)}</span>
              <span>
                in {fmtUSD(m.prompt_price_per_1m)} / out {fmtUSD(m.completion_price_per_1m)}
              </span>
              <span>{m.modality}</span>
            </div>
            {m.description && (
              <p className="mt-0.5 line-clamp-2 text-xs text-tremor-content-subtle">{m.description}</p>
            )}
          </button>
        );
      })}
    </div>
  );
}
