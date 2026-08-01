"use client";

import {
  createContext,
  useContext,
  useState,
  useEffect,
  useCallback,
  type ReactNode,
} from "react";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type Theme = "light" | "dark";

interface ThemeContextValue {
  theme: Theme;
  toggleTheme: () => void;
}

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

const ThemeContext = createContext<ThemeContextValue | undefined>(undefined);

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) {
    throw new Error("useTheme debe usarse dentro de ThemeProvider");
  }
  return ctx;
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

const STORAGE_KEY = "theme";

export default function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setTheme] = useState<Theme>("dark");
  const [mounted, setMounted] = useState(false);

  // Read persisted preference on mount — only reads ps.tweaks.v1 (new key).
  // Legacy "theme" key is intentionally NOT used as fallback: defaults to dark.
  useEffect(() => {
    try {
      let initial: Theme = "dark";
      const tweaksRaw = localStorage.getItem("ps.tweaks.v1");
      if (tweaksRaw) {
        try {
          const tweaks = JSON.parse(tweaksRaw) as { theme?: string };
          if (tweaks.theme === "light" || tweaks.theme === "dark") {
            initial = tweaks.theme;
          }
        } catch {
          // ignore parse error
        }
      }
      setTheme(initial);
      applyTheme(initial);
    } catch {
      // localStorage not available — keep default (dark)
      applyTheme("dark");
    }
    setMounted(true);
  }, []);

  const toggleTheme = useCallback(() => {
    setTheme((prev) => {
      const next: Theme = prev === "dark" ? "light" : "dark";
      applyTheme(next);
      try {
        // Persist to both keys for compatibility
        localStorage.setItem(STORAGE_KEY, next);
        const tweaksRaw = localStorage.getItem("ps.tweaks.v1");
        let tweaks: Record<string, string> = {};
        if (tweaksRaw) {
          try { tweaks = JSON.parse(tweaksRaw) as Record<string, string>; } catch { /* ignore */ }
        }
        tweaks.theme = next;
        localStorage.setItem("ps.tweaks.v1", JSON.stringify(tweaks));
      } catch {
        // ignore
      }
      return next;
    });
  }, []);

  // Prevent flash: don't render children until we know the theme
  if (!mounted) {
    return null;
  }

  return (
    <ThemeContext.Provider value={{ theme, toggleTheme }}>
      {children}
    </ThemeContext.Provider>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function applyTheme(theme: Theme) {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  if (theme === "dark") {
    root.classList.add("dark");
    root.setAttribute("data-theme", "dark");
  } else {
    root.classList.remove("dark");
    root.setAttribute("data-theme", "light");
  }
}
