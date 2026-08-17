"use client";

/**
 * EnumSelect — styled <select> for config keys with a fixed enum_values list.
 *
 * Used in the admin /config form so enum keys (e.g. dashboard.llm_provider)
 * render as a dropdown instead of a free-text input. Looks consistent with
 * the existing form fields (same border, padding, focus ring).
 *
 * Each option can supply a longer label that's rendered in the dropdown but
 * not in the closed select. The `value` is always one of `options.map(o.value)`.
 */

interface EnumSelectOption {
  value: string;
  label: string;
}

interface EnumSelectProps {
  value: string;
  onChange: (next: string) => void;
  options: EnumSelectOption[];
  disabled?: boolean;
  ariaLabel?: string;
}

export function EnumSelect({ value, onChange, options, disabled, ariaLabel }: EnumSelectProps) {
  // A `<select>` whose value matches no option renders as "nothing selected",
  // which browsers display as the first option — so a stored value this list
  // doesn't know about looks like a different setting, and saving the form
  // silently rewrites it. Surface the real value instead, disabled so it can
  // be read but not re-picked once changed away from.
  const known = options.some((o) => o.value === value);
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      disabled={disabled}
      aria-label={ariaLabel}
      className="w-full rounded-md border border-tremor-border dark:border-dark-tremor-border bg-tremor-background dark:bg-dark-tremor-background px-3 py-1.5 text-sm text-tremor-content-emphasis dark:text-dark-tremor-content-emphasis focus:outline-none focus:ring-1 focus:ring-blue-500 disabled:opacity-50"
    >
      {!known && value !== "" && (
        <option value={value} disabled>
          {value} (valor actual, no listado)
        </option>
      )}
      {options.map((opt) => (
        <option key={opt.value} value={opt.value}>
          {opt.label}
        </option>
      ))}
    </select>
  );
}

/** Pre-built option list for `dashboard.llm_provider`. Kept here so the
 *  human-readable labels live next to the component that renders them. */
export const PROVIDER_OPTIONS: EnumSelectOption[] = [
  { value: "cli", label: "Claude Code CLI (host claude binary)" },
  { value: "openrouter", label: "OpenRouter (API HTTP)" },
];

/** Curated list of native Claude model ids accepted by `claude --model`.
 *  This is hand-maintained because the CLI doesn't expose a catalog API
 *  the way OpenRouter does. Order = newest first within each tier so the
 *  default open-state shows the most relevant model.
 *
 *  When new Claude models ship, append them here (and bump the default
 *  in config/schema.yaml if appropriate). Stale ids are harmless — they
 *  just won't appear in the dropdown until they're added. */
/*  ORDER MATTERS: a `<select>` whose `value` matches no `<option>` renders
 *  with nothing selected, which browsers show as the FIRST option — so a
 *  value missing from this list is silently "changed" to options[0] the
 *  moment an operator saves the form. Keep the schema default first, and
 *  make sure every value `config/schema.yaml` can produce appears here. */
export const CLAUDE_CLI_MODEL_OPTIONS: EnumSelectOption[] = [
  { value: "claude-haiku-4-5", label: "Haiku 4.5 (rápido y barato — por defecto)" },
  { value: "claude-haiku-4-5-20251001", label: "Haiku 4.5 (id con fecha)" },
  { value: "claude-sonnet-4-6", label: "Sonnet 4.6" },
  { value: "claude-sonnet-4-5", label: "Sonnet 4.5" },
  { value: "claude-opus-4-7", label: "Opus 4.7 (máxima capacidad, ~50x el coste de Haiku)" },
  { value: "claude-opus-4-6", label: "Opus 4.6" },
];
