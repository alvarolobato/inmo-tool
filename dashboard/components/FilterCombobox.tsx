"use client";

/**
 * FilterCombobox — searchable multi-select (or single-select) input for
 * dashboard global filters.
 *
 * Built on @headlessui/react Combobox v2. In multi-select mode, selected
 * values render as removable chips above the list of options. A search box
 * filters options by their label client-side.
 */
import {
  Combobox,
  ComboboxButton,
  ComboboxInput,
  ComboboxOption,
  ComboboxOptions,
} from "@headlessui/react";
import { useId, useMemo, useState } from "react";

export interface FilterComboboxOption {
  value: string;
  label: string;
}

export interface FilterComboboxBaseProps {
  id: string;
  label: string;
  options: FilterComboboxOption[];
  placeholder?: string;
  loading?: boolean;
  disabled?: boolean;
  error?: string | null;
}

export interface MultiFilterComboboxProps extends FilterComboboxBaseProps {
  multiple: true;
  value: string[];
  onChange: (next: string[]) => void;
}

export interface SingleFilterComboboxProps extends FilterComboboxBaseProps {
  multiple?: false;
  value: string;
  onChange: (next: string) => void;
}

export type FilterComboboxProps =
  | MultiFilterComboboxProps
  | SingleFilterComboboxProps;

const CHIP_CLASS =
  "inline-flex items-center gap-1 rounded-full bg-tremor-brand/10 dark:bg-dark-tremor-brand/20 px-2 py-0.5 text-xs text-tremor-brand dark:text-dark-tremor-brand";

function filterOptions(
  options: FilterComboboxOption[],
  query: string,
): FilterComboboxOption[] {
  const q = query.trim().toLowerCase();
  if (!q) return options;
  return options.filter((o) => o.label.toLowerCase().includes(q));
}

function labelByValue(options: FilterComboboxOption[], value: string): string {
  const match = options.find((o) => o.value === value);
  return match ? match.label : value;
}

/**
 * Multi-select variant. Renders chips + search input + option list.
 */
function MultiCombobox(props: MultiFilterComboboxProps) {
  const {
    id,
    label,
    options,
    value,
    onChange,
    placeholder,
    loading,
    disabled,
    error,
  } = props;
  const [query, setQuery] = useState("");
  const listId = useId();

  const filtered = useMemo(() => filterOptions(options, query), [options, query]);

  const isLocked = Boolean(disabled || loading);

  const handleRemove = (v: string) => {
    if (isLocked) return;
    onChange(value.filter((x) => x !== v));
  };

  const handleClear = () => {
    if (isLocked) return;
    onChange([]);
    setQuery("");
  };

  return (
    <div className="flex min-w-[200px] flex-col gap-1" data-testid={`filter-combobox-${id}`}>
      <Combobox
        multiple
        value={value}
        onChange={(next: string[]) => {
          onChange(next);
          setQuery("");
        }}
        disabled={disabled || loading}
      >
        <div className="relative">
          <div
            className={`flex min-h-[36px] w-full flex-wrap items-center gap-1 rounded-md border border-tremor-border dark:border-dark-tremor-border bg-tremor-background dark:bg-dark-tremor-background px-2 py-1.5 text-sm text-tremor-content-emphasis dark:text-dark-tremor-content-emphasis ${
              disabled || loading ? "opacity-60" : ""
            }`}
          >
            {value.map((v) => (
              <span key={v} className={CHIP_CLASS} data-testid={`filter-chip-${id}-${v}`}>
                {labelByValue(options, v)}
                <button
                  type="button"
                  aria-label={`Quitar ${labelByValue(options, v)}`}
                  className="leading-none text-tremor-brand hover:text-tremor-brand-emphasis dark:text-dark-tremor-brand disabled:cursor-not-allowed disabled:opacity-60"
                  disabled={isLocked}
                  onClick={(e) => {
                    e.stopPropagation();
                    handleRemove(v);
                  }}
                >
                  ×
                </button>
              </span>
            ))}
            <ComboboxInput
              id={`gf-${id}`}
              aria-label={label}
              aria-busy={!!loading}
              aria-controls={listId}
              className="min-w-[120px] flex-1 bg-transparent text-sm text-tremor-content-emphasis dark:text-dark-tremor-content-emphasis outline-none placeholder:text-tremor-content-subtle dark:placeholder:text-dark-tremor-content-subtle"
              placeholder={value.length === 0 ? (placeholder ?? "Buscar…") : ""}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  setQuery("");
                }
              }}
              displayValue={() => query}
            />
            {value.length > 0 && !disabled && !loading ? (
              <button
                type="button"
                aria-label="Limpiar selección"
                className="ml-1 text-xs text-tremor-content-subtle hover:text-tremor-content-emphasis dark:text-dark-tremor-content-subtle dark:hover:text-dark-tremor-content-emphasis"
                onClick={(e) => {
                  e.stopPropagation();
                  handleClear();
                }}
              >
                Limpiar
              </button>
            ) : null}
            <ComboboxButton
              aria-label={`Abrir opciones de ${label}`}
              className="ml-1 text-tremor-content-subtle dark:text-dark-tremor-content-subtle"
            >
              ▾
            </ComboboxButton>
          </div>
          <ComboboxOptions
            id={listId}
            className="absolute z-50 mt-1 max-h-60 w-full overflow-auto rounded-md border border-tremor-border dark:border-dark-tremor-border bg-tremor-background dark:bg-dark-tremor-background py-1 text-sm shadow-lg focus:outline-none"
          >
            {filtered.length === 0 ? (
              // Intentionally a <div>, not a <li>: Headless UI
              // ComboboxOptions is a <ul>, but the empty state is not an
              // option (no role=option, no value) — keeping it as a <li>
              // would pollute listbox semantics and trigger invalid-nesting
              // warnings when the container tag changes.
              <div
                role="status"
                aria-live="polite"
                className="px-3 py-2 text-xs text-tremor-content-subtle dark:text-dark-tremor-content-subtle"
              >
                {loading ? "Cargando…" : "Sin resultados"}
              </div>
            ) : (
              filtered.map((opt) => (
                <ComboboxOption
                  key={opt.value}
                  value={opt.value}
                  className={({ focus, selected }) =>
                    `flex cursor-pointer items-center gap-2 px-3 py-1.5 ${
                      focus
                        ? "bg-tremor-background-muted dark:bg-dark-tremor-background-muted"
                        : ""
                    } ${selected ? "font-semibold" : ""}`
                  }
                >
                  {({ selected }) => (
                    <>
                      <span
                        aria-hidden="true"
                        className={`inline-block h-3 w-3 shrink-0 rounded-sm border ${
                          selected
                            ? "border-tremor-brand bg-tremor-brand dark:border-dark-tremor-brand dark:bg-dark-tremor-brand"
                            : "border-tremor-border dark:border-dark-tremor-border"
                        }`}
                      />
                      <span>{opt.label}</span>
                    </>
                  )}
                </ComboboxOption>
              ))
            )}
          </ComboboxOptions>
        </div>
      </Combobox>
      {error ? (
        <span className="text-xs text-red-500">{error}</span>
      ) : null}
    </div>
  );
}

/**
 * Single-select variant. Renders a search input + option list.
 */
function SingleCombobox(props: SingleFilterComboboxProps) {
  const {
    id,
    label,
    options,
    value,
    onChange,
    placeholder,
    loading,
    disabled,
    error,
  } = props;
  const [query, setQuery] = useState("");
  const listId = useId();

  const filtered = useMemo(() => filterOptions(options, query), [options, query]);

  return (
    <div className="flex min-w-[200px] flex-col gap-1" data-testid={`filter-combobox-${id}`}>
      <Combobox
        value={value}
        onChange={(next: string | null) => {
          onChange(next ?? "");
          setQuery("");
        }}
        disabled={disabled || loading}
      >
        <div className="relative">
          <div
            className={`flex min-h-[36px] w-full items-center gap-1 rounded-md border border-tremor-border dark:border-dark-tremor-border bg-tremor-background dark:bg-dark-tremor-background px-2 py-1.5 text-sm text-tremor-content-emphasis dark:text-dark-tremor-content-emphasis ${
              disabled || loading ? "opacity-60" : ""
            }`}
          >
            <ComboboxInput
              id={`gf-${id}`}
              aria-label={label}
              aria-busy={!!loading}
              aria-controls={listId}
              className="flex-1 bg-transparent text-sm text-tremor-content-emphasis dark:text-dark-tremor-content-emphasis outline-none placeholder:text-tremor-content-subtle dark:placeholder:text-dark-tremor-content-subtle"
              placeholder={placeholder ?? "Buscar…"}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                // Headless UI owns Escape for closing the listbox; we only
                // consume it here when the user has typed a query so that
                // Esc clears the in-progress search text without preventing
                // the default close behavior.
                if (event.key === "Escape" && query) {
                  setQuery("");
                }
              }}
              displayValue={(v: string) => labelByValue(options, v || "")}
            />
            {value && !disabled && !loading ? (
              <button
                type="button"
                aria-label="Limpiar selección"
                className="ml-1 text-xs text-tremor-content-subtle hover:text-tremor-content-emphasis dark:text-dark-tremor-content-subtle dark:hover:text-dark-tremor-content-emphasis"
                onClick={(e) => {
                  e.stopPropagation();
                  onChange("");
                  setQuery("");
                }}
              >
                Limpiar
              </button>
            ) : null}
            <ComboboxButton
              aria-label={`Abrir opciones de ${label}`}
              className="ml-1 text-tremor-content-subtle dark:text-dark-tremor-content-subtle"
            >
              ▾
            </ComboboxButton>
          </div>
          <ComboboxOptions
            id={listId}
            className="absolute z-50 mt-1 max-h-60 w-full overflow-auto rounded-md border border-tremor-border dark:border-dark-tremor-border bg-tremor-background dark:bg-dark-tremor-background py-1 text-sm shadow-lg focus:outline-none"
          >
            <ComboboxOption
              value=""
              className={({ focus }) =>
                `cursor-pointer px-3 py-1.5 italic text-tremor-content-subtle dark:text-dark-tremor-content-subtle ${
                  focus ? "bg-tremor-background-muted dark:bg-dark-tremor-background-muted" : ""
                }`
              }
            >
              Todos
            </ComboboxOption>
            {filtered.length === 0 ? (
              // Intentionally a <div>, not a <li>: Headless UI
              // ComboboxOptions is a <ul>, but the empty state is not an
              // option (no role=option, no value) — keeping it as a <li>
              // would pollute listbox semantics and trigger invalid-nesting
              // warnings when the container tag changes.
              <div
                role="status"
                aria-live="polite"
                className="px-3 py-2 text-xs text-tremor-content-subtle dark:text-dark-tremor-content-subtle"
              >
                {loading ? "Cargando…" : "Sin resultados"}
              </div>
            ) : (
              filtered.map((opt) => (
                <ComboboxOption
                  key={opt.value}
                  value={opt.value}
                  className={({ focus, selected }) =>
                    `cursor-pointer px-3 py-1.5 ${
                      focus
                        ? "bg-tremor-background-muted dark:bg-dark-tremor-background-muted"
                        : ""
                    } ${selected ? "font-semibold" : ""}`
                  }
                >
                  {opt.label}
                </ComboboxOption>
              ))
            )}
          </ComboboxOptions>
        </div>
      </Combobox>
      {error ? (
        <span className="text-xs text-red-500">{error}</span>
      ) : null}
    </div>
  );
}

export function FilterCombobox(props: FilterComboboxProps) {
  if (props.multiple) {
    return <MultiCombobox {...props} />;
  }
  return <SingleCombobox {...props} />;
}
