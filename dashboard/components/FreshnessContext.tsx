"use client";

import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import type { DataHealthResponse } from "@/app/api/data-health/route";

interface FreshnessState {
  /** Short label rendered in the TopBar live-status pill. */
  freshnessText: string;
  /** True when any table is past the staleness threshold. */
  freshnessStale: boolean;
  /** Hover tooltip with the precise last-sync timestamp. */
  freshnessTooltip: string | null;
  /** Raw `/api/data-health` payload, for components that need the table list. */
  health: DataHealthResponse | null;
  setFreshnessText: (text: string) => void;
  setFreshnessStale: (stale: boolean) => void;
  setFreshnessTooltip: (tooltip: string | null) => void;
}

const FreshnessContext = createContext<FreshnessState>({
  freshnessText: "Datos al día",
  freshnessStale: false,
  freshnessTooltip: null,
  health: null,
  setFreshnessText: () => {},
  setFreshnessStale: () => {},
  setFreshnessTooltip: () => {},
});

const REFRESH_INTERVAL_MS = 2 * 60 * 1000;

function formatDate(iso: string): string {
  const d = new Date(iso);
  const date = d.toLocaleDateString("es-ES", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  });
  const time = d.toLocaleTimeString("es-ES", {
    hour: "2-digit",
    minute: "2-digit",
  });
  return `${date} a las ${time}`;
}

export function FreshnessProvider({ children }: { children: ReactNode }) {
  const [freshnessText, setFreshnessText] = useState("Datos al día");
  const [freshnessStale, setFreshnessStale] = useState(false);
  const [freshnessTooltip, setFreshnessTooltip] = useState<string | null>(null);
  const [health, setHealth] = useState<DataHealthResponse | null>(null);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setInterval> | null = null;

    const load = async () => {
      try {
        const res = await fetch("/api/data-health");
        if (!res.ok) return;
        const data = (await res.json()) as DataHealthResponse;
        if (!cancelled) setHealth(data);
      } catch {
        // graceful degradation
      }
    };

    void load();
    timer = setInterval(load, REFRESH_INTERVAL_MS);

    return () => {
      cancelled = true;
      if (timer) clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    if (!health) return;
    const stalest = health.stalestTable;
    if (!stalest) {
      setFreshnessText("Datos al día");
      setFreshnessStale(false);
      setFreshnessTooltip(null);
      return;
    }

    const lastSync = new Date(stalest.lastSync);
    const minutesAgo = Math.max(
      0,
      Math.round((Date.now() - lastSync.getTime()) / 60000),
    );
    const age =
      minutesAgo < 60
        ? `hace ${minutesAgo}m`
        : `hace ${Math.round(minutesAgo / 60)}h`;

    setFreshnessText(
      health.overallStale
        ? `Datos desactualizados · ${age}`
        : `Datos al día · ${age}`,
    );
    setFreshnessStale(health.overallStale);
    setFreshnessTooltip(
      `Última sincronización (${stalest.name}): ${formatDate(stalest.lastSync)}`,
    );
  }, [health]);

  return (
    <FreshnessContext.Provider
      value={{
        freshnessText,
        freshnessStale,
        freshnessTooltip,
        health,
        setFreshnessText,
        setFreshnessStale,
        setFreshnessTooltip,
      }}
    >
      {children}
    </FreshnessContext.Provider>
  );
}

export function useFreshness() {
  return useContext(FreshnessContext);
}
