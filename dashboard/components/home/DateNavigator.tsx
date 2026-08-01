"use client";

import { useRef } from "react";

interface DateNavigatorProps {
  /** ISO YYYY-MM-DD string of the currently selected date. */
  value: string;
  onChange: (next: string) => void;
  /** Disable the next-day arrow when we're already on the most recent
   *  available date. Days the ETL hasn't reached yet show honest zeros,
   *  so callers typically pass `today_madrid`. */
  maxDate?: string;
}

const MONTHS_ES = [
  "ene", "feb", "mar", "abr", "may", "jun",
  "jul", "ago", "sep", "oct", "nov", "dic",
];
const DAYS_ES = ["dom", "lun", "mar", "mié", "jue", "vie", "sáb"];

function parseISO(s: string): Date {
  const [y, m, d] = s.split("-").map((p) => parseInt(p, 10));
  return new Date(y, m - 1, d);
}

function toISO(d: Date): string {
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function fmtDateEs(s: string): string {
  const d = parseISO(s);
  return `${DAYS_ES[d.getDay()]} ${d.getDate()} ${MONTHS_ES[d.getMonth()]} ${d.getFullYear()}`;
}

const arrowBtn: React.CSSProperties = {
  background: "transparent",
  border: "1px solid var(--border-strong)",
  color: "var(--fg)",
  width: 32,
  height: 32,
  borderRadius: 6,
  cursor: "pointer",
  fontFamily: "inherit",
  fontSize: 14,
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
};

const labelBtn: React.CSSProperties = {
  background: "transparent",
  border: "1px solid var(--border-strong)",
  color: "var(--fg)",
  height: 32,
  borderRadius: 6,
  cursor: "pointer",
  fontFamily: "inherit",
  fontSize: 12,
  fontWeight: 500,
  padding: "0 12px",
  display: "inline-flex",
  alignItems: "center",
  gap: 8,
};

export function DateNavigator({ value, onChange, maxDate }: DateNavigatorProps) {
  const inputRef = useRef<HTMLInputElement>(null);

  const shift = (days: number) => {
    const d = parseISO(value);
    d.setDate(d.getDate() + days);
    const next = toISO(d);
    if (maxDate && next > maxDate) return;
    onChange(next);
  };

  const atMax = !!maxDate && value >= maxDate;

  // Open the browser-native calendar. On Chrome ≥ 99 / Edge / Safari ≥ 16.4
  // we use input.showPicker() which opens the calendar on demand. On
  // older browsers we fall back to focusing the input — the browser's
  // own UA logic decides whether to open the calendar from focus.
  const openCalendar = () => {
    const el = inputRef.current;
    if (!el) return;
    type WithShowPicker = HTMLInputElement & { showPicker?: () => void };
    const withPicker = el as WithShowPicker;
    if (typeof withPicker.showPicker === "function") {
      try {
        withPicker.showPicker();
        return;
      } catch {
        // showPicker can throw when the element is not in DOM or the
        // browser refuses to open it — fall through to focus.
      }
    }
    el.focus();
    el.click();
  };

  return (
    <div
      style={{ display: "inline-flex", alignItems: "center", gap: 4 }}
      data-testid="date-navigator"
    >
      <button
        type="button"
        style={arrowBtn}
        onClick={() => shift(-1)}
        aria-label="Día anterior"
        data-testid="date-prev"
      >
        ‹
      </button>

      {/* Visible button shows the localized date and triggers the native
          calendar via showPicker(). The real <input type="date"> sits in
          a 0×0 wrapper next to it: it owns the value + change events but
          doesn't take any layout space, so click reliability comes from
          the explicit showPicker() call above. */}
      <button
        type="button"
        style={labelBtn}
        onClick={openCalendar}
        aria-label="Elegir fecha"
        data-testid="date-label"
      >
        <span style={{ fontFamily: "var(--font-jetbrains, monospace)" }} aria-hidden="true">
          📅
        </span>
        <span>{fmtDateEs(value)}</span>
      </button>
      <span style={{ width: 0, height: 0, overflow: "hidden", display: "inline-block" }}>
        <input
          ref={inputRef}
          type="date"
          value={value}
          max={maxDate}
          onChange={(e) => {
            const v = e.target.value;
            if (v) onChange(v);
          }}
          style={{
            // The input must remain a real focusable element for
            // showPicker() to be allowed by the browser, but we don't
            // want it to take any visible space. Width 0 + a small
            // height + opacity 0 keeps it accessible without affecting
            // layout.
            width: 0,
            height: 1,
            opacity: 0,
            border: "none",
            padding: 0,
            margin: 0,
            background: "transparent",
          }}
          aria-hidden="true"
          tabIndex={-1}
          data-testid="date-input"
        />
      </span>

      <button
        type="button"
        style={{
          ...arrowBtn,
          opacity: atMax ? 0.4 : 1,
          cursor: atMax ? "not-allowed" : "pointer",
        }}
        onClick={() => shift(1)}
        disabled={atMax}
        aria-label="Día siguiente"
        data-testid="date-next"
      >
        ›
      </button>
    </div>
  );
}
