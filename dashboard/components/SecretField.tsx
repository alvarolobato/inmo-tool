"use client";

/**
 * SecretField — a password input with an eye-toggle to reveal/hide the value,
 * a copy-to-clipboard button, and an optional "reveal from server" callback.
 *
 * When `onReveal` is provided, clicking the eye icon the first time will call
 * `onReveal()` to fetch the real value from the server before revealing it.
 *
 * Usage:
 *   <SecretField
 *     id="openrouter-key"
 *     value={masked}            // "••••1234" when not revealed
 *     revealed={revealed}       // actual value once revealed
 *     onReveal={fetchRealValue}
 *     onChange={handleChange}
 *     placeholder="sk-or-..."
 *   />
 */

import { useState } from "react";

interface SecretFieldProps {
  id?: string;
  /** Masked display value ("••••1234") shown when not revealed */
  value?: string;
  /** Actual revealed value (set externally after onReveal resolves) */
  revealed?: string | null;
  /** Called when the user clicks the eye icon to reveal the secret */
  onReveal?: () => Promise<void> | void;
  /** Called when the input value changes (only active in edit mode) */
  onChange?: (value: string) => void;
  placeholder?: string;
  disabled?: boolean;
  /** When true, the field is read-only (no onChange) */
  readOnly?: boolean;
  className?: string;
  /** When provided, the eye icon is grayed out and this text shown as tooltip */
  title?: string;
}

export default function SecretField({
  id,
  value = "",
  revealed = null,
  onReveal,
  onChange,
  placeholder = "••••••••",
  disabled = false,
  readOnly = false,
  className = "",
  title,
}: SecretFieldProps) {
  const [isRevealed, setIsRevealed] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [copySuccess, setCopySuccess] = useState(false);

  const displayValue = isRevealed && revealed != null ? revealed : value;

  async function handleToggleReveal() {
    if (isRevealed) {
      setIsRevealed(false);
      return;
    }
    // Use null check (not falsy) so an empty-string revealed value is treated
    // as "already revealed" and does not trigger another fetch.
    if (onReveal && revealed == null) {
      setIsLoading(true);
      try {
        await onReveal();
        setIsRevealed(true);
      } finally {
        setIsLoading(false);
      }
    } else {
      setIsRevealed(true);
    }
  }

  async function handleCopy() {
    const toCopy = isRevealed && revealed != null ? revealed : value;
    if (!toCopy) return;
    try {
      await navigator.clipboard.writeText(toCopy);
      setCopySuccess(true);
      setTimeout(() => setCopySuccess(false), 2000);
    } catch {
      // clipboard might be unavailable
    }
  }

  return (
    <div className={`relative flex items-center gap-1 ${className}`}>
      <input
        id={id}
        type={isRevealed ? "text" : "password"}
        value={displayValue}
        onChange={
          !readOnly && onChange ? (e) => onChange(e.target.value) : undefined
        }
        readOnly={readOnly || !onChange}
        disabled={disabled}
        placeholder={placeholder}
        autoComplete="off"
        data-lpignore="true"
        className="flex-1 min-w-0 rounded-md border border-tremor-border dark:border-dark-tremor-border bg-tremor-background dark:bg-dark-tremor-background px-3 py-1.5 text-sm font-mono text-tremor-content-emphasis dark:text-dark-tremor-content-emphasis focus:outline-none focus:ring-1 focus:ring-blue-500 disabled:opacity-50 disabled:cursor-not-allowed"
      />

      {/* Eye toggle */}
      <button
        type="button"
        onClick={title ? undefined : handleToggleReveal}
        disabled={disabled || isLoading || !!title}
        title={title ?? (isRevealed ? "Ocultar" : "Mostrar valor")}
        aria-label={title ?? (isRevealed ? "Ocultar valor" : "Mostrar valor")}
        className={`flex-shrink-0 rounded p-1 disabled:cursor-not-allowed ${title ? "opacity-30 cursor-not-allowed" : "text-tremor-content-subtle dark:text-dark-tremor-content-subtle hover:text-tremor-content-emphasis dark:hover:text-dark-tremor-content-emphasis disabled:opacity-50"}`}
      >
        {isLoading ? (
          <svg className="h-4 w-4 animate-spin" viewBox="0 0 24 24" fill="none">
            <circle
              className="opacity-25"
              cx="12"
              cy="12"
              r="10"
              stroke="currentColor"
              strokeWidth="4"
            />
            <path
              className="opacity-75"
              fill="currentColor"
              d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
            />
          </svg>
        ) : isRevealed ? (
          // Eye-slash icon
          <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M13.875 18.825A10.05 10.05 0 0112 19c-4.478 0-8.268-2.943-9.543-7a9.97 9.97 0 011.563-3.029m5.858.908a3 3 0 114.243 4.243M9.878 9.878l4.242 4.242M9.88 9.88l-3.29-3.29m7.532 7.532l3.29 3.29M3 3l3.59 3.59m0 0A9.953 9.953 0 0112 5c4.478 0 8.268 2.943 9.543 7a10.025 10.025 0 01-4.132 4.411m0 0L21 21"
            />
          </svg>
        ) : (
          // Eye icon
          <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"
            />
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z"
            />
          </svg>
        )}
      </button>

      {/* Copy button */}
      <button
        type="button"
        onClick={handleCopy}
        disabled={disabled || (!displayValue)}
        title="Copiar al portapapeles"
        aria-label="Copiar al portapapeles"
        className="flex-shrink-0 rounded p-1 text-tremor-content-subtle dark:text-dark-tremor-content-subtle hover:text-tremor-content-emphasis dark:hover:text-dark-tremor-content-emphasis disabled:opacity-50 disabled:cursor-not-allowed"
      >
        {copySuccess ? (
          <svg className="h-4 w-4 text-green-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
          </svg>
        ) : (
          <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z"
            />
          </svg>
        )}
      </button>
    </div>
  );
}
