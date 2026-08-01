"use client";

import {
  createContext,
  useContext,
  useState,
  useEffect,
  useCallback,
  useRef,
  type ReactNode,
} from "react";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type TweaksTheme = "dark" | "light";
export type TweaksAccent = "electric" | "citrus" | "magenta" | "mono";
export type TweaksDensity = "compact" | "comfort" | "spacious";
export type TweaksKpiStyle = "editorial" | "bold" | "minimal";

interface Tweaks {
  theme: TweaksTheme;
  accent: TweaksAccent;
  density: TweaksDensity;
  kpiStyle: TweaksKpiStyle;
}

const TWEAKS_DEFAULTS: Tweaks = {
  theme: "dark",
  accent: "electric",
  density: "comfort",
  kpiStyle: "editorial",
};

const STORAGE_KEY = "ps.tweaks.v1";

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

interface TweaksContextValue {
  tweaks: Tweaks;
  setTweak: <K extends keyof Tweaks>(key: K, value: Tweaks[K]) => void;
  kpiStyle: TweaksKpiStyle;
}

const TweaksContext = createContext<TweaksContextValue | undefined>(undefined);

export function useTweaks(): TweaksContextValue {
  const ctx = useContext(TweaksContext);
  if (!ctx) {
    throw new Error("useTweaks debe usarse dentro de TweaksPanelProvider");
  }
  return ctx;
}

/** Convenience hook — reads kpiStyle without needing the full context */
export function useKpiStyle(): TweaksKpiStyle {
  const ctx = useContext(TweaksContext);
  return ctx?.kpiStyle ?? TWEAKS_DEFAULTS.kpiStyle;
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export function TweaksPanelProvider({ children }: { children: ReactNode }) {
  const [tweaks, setTweaks] = useState<Tweaks>(TWEAKS_DEFAULTS);

  // Load from localStorage on mount
  useEffect(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as Partial<Tweaks>;
        const merged: Tweaks = {
          theme: (["dark", "light"].includes(parsed.theme ?? "") ? parsed.theme : TWEAKS_DEFAULTS.theme) as TweaksTheme,
          accent: (["electric", "citrus", "magenta", "mono"].includes(parsed.accent ?? "") ? parsed.accent : TWEAKS_DEFAULTS.accent) as TweaksAccent,
          density: (["compact", "comfort", "spacious"].includes(parsed.density ?? "") ? parsed.density : TWEAKS_DEFAULTS.density) as TweaksDensity,
          kpiStyle: (["editorial", "bold", "minimal"].includes(parsed.kpiStyle ?? "") ? parsed.kpiStyle : TWEAKS_DEFAULTS.kpiStyle) as TweaksKpiStyle,
        };
        setTweaks(merged);
        // Apply DOM attributes
        applyTweaksToDom(merged);
      }
    } catch {
      // ignore
    }
  }, []);

  const setTweak = useCallback(<K extends keyof Tweaks>(key: K, value: Tweaks[K]) => {
    setTweaks((prev) => {
      const next = { ...prev, [key]: value };
      // Persist
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
      } catch {
        // ignore
      }
      // Apply to DOM
      applyTweaksToDom(next);
      return next;
    });
  }, []);

  return (
    <TweaksContext.Provider value={{ tweaks, setTweak, kpiStyle: tweaks.kpiStyle }}>
      {children}
    </TweaksContext.Provider>
  );
}

// ---------------------------------------------------------------------------
// DOM helpers
// ---------------------------------------------------------------------------

function applyTweaksToDom(tweaks: Tweaks) {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  root.setAttribute("data-theme", tweaks.theme);
  root.setAttribute("data-accent", tweaks.accent);
  root.setAttribute("data-density", tweaks.density);
  if (tweaks.theme === "dark") {
    root.classList.add("dark");
  } else {
    root.classList.remove("dark");
  }
}

// ---------------------------------------------------------------------------
// TweaksPanel component
// ---------------------------------------------------------------------------

interface TweaksPanelProps {
  open: boolean;
  onClose: () => void;
}

type RadioOption<T extends string> = { value: T; label: string };

function RadioGroup<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: RadioOption<T>[];
  onChange: (v: T) => void;
}) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <div
        style={{
          fontSize: 10,
          fontFamily: "var(--font-jetbrains, 'JetBrains Mono', monospace)",
          textTransform: "uppercase",
          letterSpacing: "0.08em",
          color: "var(--fg-subtle)",
          fontWeight: 500,
        }}
      >
        {label}
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        {options.map((opt) => (
          <label
            key={opt.value}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              fontSize: 12,
              cursor: "pointer",
              color: value === opt.value ? "var(--fg)" : "var(--fg-muted)",
            }}
          >
            <span
              style={{
                width: 10,
                height: 10,
                borderRadius: "50%",
                border: `2px solid ${value === opt.value ? "var(--accent)" : "var(--border-strong)"}`,
                background: value === opt.value ? "var(--accent)" : "transparent",
                flexShrink: 0,
                display: "inline-block",
              }}
            />
            <input
              type="radio"
              name={label}
              value={opt.value}
              checked={value === opt.value}
              onChange={() => onChange(opt.value)}
              style={{ position: "absolute", opacity: 0, width: 0, height: 0 }}
            />
            {opt.label}
          </label>
        ))}
      </div>
    </div>
  );
}

export default function TweaksPanel({ open, onClose }: TweaksPanelProps) {
  const { tweaks, setTweak } = useTweaks();
  const panelRef = useRef<HTMLDivElement>(null);

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open, onClose]);

  // Close on Escape
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      ref={panelRef}
      data-testid="tweaks-panel"
      style={{
        position: "fixed",
        top: 60,
        right: 60,
        zIndex: 30,
        background: "var(--bg-1)",
        border: "1px solid var(--border-strong)",
        borderRadius: 10,
        padding: 16,
        minWidth: 220,
        boxShadow: "0 12px 40px rgba(0,0,0,0.4)",
        display: "flex",
        flexDirection: "column",
        gap: 14,
      }}
    >
      {/* Header */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          marginBottom: 2,
        }}
      >
        <span style={{ fontSize: 12, fontWeight: 600, color: "var(--fg)" }}>Ajustes</span>
        <button
          type="button"
          onClick={onClose}
          aria-label="Cerrar ajustes"
          style={{
            background: "none",
            border: "none",
            cursor: "pointer",
            color: "var(--fg-muted)",
            fontSize: 14,
            padding: "2px 4px",
            borderRadius: 4,
          }}
        >
          ✕
        </button>
      </div>

      {/* Tema */}
      <RadioGroup<TweaksTheme>
        label="Tema"
        value={tweaks.theme}
        options={[
          { value: "dark", label: "Oscuro" },
          { value: "light", label: "Claro" },
        ]}
        onChange={(v) => setTweak("theme", v)}
      />

      {/* Acento */}
      <RadioGroup<TweaksAccent>
        label="Acento"
        value={tweaks.accent}
        options={[
          { value: "electric", label: "Eléctrico" },
          { value: "citrus", label: "Cítrico" },
          { value: "magenta", label: "Magenta" },
          { value: "mono", label: "Mono" },
        ]}
        onChange={(v) => setTweak("accent", v)}
      />

      {/* Densidad */}
      <RadioGroup<TweaksDensity>
        label="Densidad"
        value={tweaks.density}
        options={[
          { value: "compact", label: "Compacto" },
          { value: "comfort", label: "Cómodo" },
          { value: "spacious", label: "Amplio" },
        ]}
        onChange={(v) => setTweak("density", v)}
      />

      {/* Estilo KPI */}
      <RadioGroup<TweaksKpiStyle>
        label="Estilo KPI"
        value={tweaks.kpiStyle}
        options={[
          { value: "editorial", label: "Editorial" },
          { value: "bold", label: "Destacado" },
          { value: "minimal", label: "Mínimo" },
        ]}
        onChange={(v) => setTweak("kpiStyle", v)}
      />
    </div>
  );
}
