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
  /** True when any in-scope source is past its staleness threshold. */
  freshnessStale: boolean;
  /**
   * True when a connector is actively refreshing (mid-cycle, not stuck) and
   * nothing is stale — a distinct pill state from stale (issue #295, D-050). */
  freshnessRefreshing: boolean;
  /**
   * Issue #586 — true when the freshness surface can't make an honest
   * "nothing due" claim (a DB error, or an empty in-scope set): the dot must
   * render grey/unknown, NEVER green. Takes priority over freshnessStale
   * (both false at once means "nothing to assert", not "all fine"). */
  freshnessUnknown: boolean;
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
  freshnessRefreshing: false,
  freshnessUnknown: false,
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
  const [freshnessRefreshing, setFreshnessRefreshing] = useState(false);
  const [freshnessUnknown, setFreshnessUnknown] = useState(false);
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
    if (!health) return; // no response yet (still loading) — keep prior state.

    // Issue #586 — fail dark, never green: a DB error or an empty in-scope
    // set (no stalest connector to report — the two are the same condition,
    // see getConnectorFreshness) is UNKNOWN, never "Datos al día". This check
    // comes FIRST, ahead of every other branch below.
    if (health.overallUnknown || !health.stalestConnector) {
      setFreshnessText("Estado desconocido");
      setFreshnessStale(false);
      setFreshnessRefreshing(false);
      setFreshnessUnknown(true);
      setFreshnessTooltip(
        "No se pudo determinar el estado de los conectores — revisa /etl/connectors",
      );
      return;
    }
    setFreshnessUnknown(false);
    const stalest = health.stalestConnector;

    // An in-scope connector/portal that has never completed a fresh cycle (or
    // never had a successful capture): there is no freshness age to show —
    // say so plainly rather than inventing "0m".
    if (!stalest.lastSuccessAt) {
      setFreshnessText("Datos sin sincronizar");
      setFreshnessStale(true);
      setFreshnessRefreshing(false);
      setFreshnessTooltip(
        `${stalest.connector}: sin ejecución correcta todavía`,
      );
      return;
    }

    const lastSuccess = new Date(stalest.lastSuccessAt);
    const minutesAgo = Math.max(
      0,
      Math.round((Date.now() - lastSuccess.getTime()) / 60000),
    );
    const age =
      minutesAgo < 60
        ? `hace ${minutesAgo}m`
        : `hace ${Math.round(minutesAgo / 60)}h`;

    // A connector actively mid-cycle (and nothing stale) reads as "refreshing"
    // — a distinct, non-alarming state from stale (issue #295, D-050).
    const refreshing = health.overallRefreshing === true && !health.overallStale;
    setFreshnessText(
      health.overallStale
        ? `Datos desactualizados · ${age}`
        : refreshing
          ? `Refrescando datos · ${age}`
          : `Datos al día · ${age}`,
    );
    setFreshnessStale(health.overallStale);
    setFreshnessRefreshing(refreshing);
    setFreshnessTooltip(
      `Última ejecución correcta (${stalest.connector}): ${formatDate(stalest.lastSuccessAt)}`,
    );
  }, [health]);

  return (
    <FreshnessContext.Provider
      value={{
        freshnessText,
        freshnessStale,
        freshnessRefreshing,
        freshnessUnknown,
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
