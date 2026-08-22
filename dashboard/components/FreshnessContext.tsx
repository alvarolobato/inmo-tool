"use client";

/**
 * TopBar freshness pill state — repointed at the Estado board's source-health
 * model (issue #638, part of #636).
 *
 * Before this change, the pill derived from `/api/data-health`
 * (`getConnectorFreshness`), which reads `connector_freshness_state`'s crawl
 * CYCLE completion — a run-outcome-shaped signal that can read green while a
 * source is actually starving (the fotocasa case: four consecutive `ok` runs,
 * zero listings ingested for ~40h). It now reads `/api/etl/source-health`,
 * whose per-source status is derived from the `listing` table itself
 * (lib/db/source-health.ts) — the same ground truth and the same worst-of
 * rollup the `/admin` Estado board renders, so the TopBar dot and the board
 * can never structurally disagree.
 *
 * `/api/data-health` and `getConnectorFreshness()` are UNCHANGED by this —
 * they still back `/api/ready` and `/admin/fuentes`'
 * per-connector cycle pill, none of which are in #638's scope.
 */

import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import type { SourceHealthResponse } from "@/app/api/etl/source-health/route";
import {
  SOURCE_STATUS_RANK,
  formatSourceAge,
  type SourceStatus,
} from "@/lib/source-health";

interface FreshnessState {
  /** Short label rendered in the TopBar live-status pill. */
  freshnessText: string;
  /** True when the worst-of source status is atascado/fallando — a real
   * problem, not merely a capture source awaiting its owner-paced turn. */
  freshnessStale: boolean;
  /**
   * True when the worst-of status is `pendiente` — due, but no error signal
   * (includes a capture source merely awaiting capture, per the owner's
   * #636-addendum safety constraint: never red from time alone). A distinct,
   * non-alarming pill state from stale. */
  freshnessRefreshing: boolean;
  /**
   * True when the source-health surface can't make an honest claim (a DB
   * error, or no in-scope sources at all — `rollupStatus: null`): the dot
   * must render grey/unknown, NEVER green. Takes priority over
   * freshnessStale (both false at once means "nothing to assert"). */
  freshnessUnknown: boolean;
  /** Hover tooltip naming the worst-ranked source and its age. */
  freshnessTooltip: string | null;
  /** Raw `/api/etl/source-health` payload, for components that need the
   * per-source list. */
  health: SourceHealthResponse | null;
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
  const [health, setHealth] = useState<SourceHealthResponse | null>(null);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setInterval> | null = null;

    const load = async () => {
      try {
        const res = await fetch("/api/etl/source-health");
        if (!res.ok) return;
        const data = (await res.json()) as SourceHealthResponse;
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

    // Fail dark, never green: no in-scope sources (empty registry) or a
    // server-side aggregation error both report rollupStatus: null. This
    // check comes FIRST, ahead of every other branch below.
    if (health.rollupStatus === null) {
      setFreshnessText("Estado desconocido");
      setFreshnessStale(false);
      setFreshnessRefreshing(false);
      setFreshnessUnknown(true);
      setFreshnessTooltip("No se pudo determinar el estado de las fuentes — revisa /admin");
      return;
    }
    setFreshnessUnknown(false);

    const active = health.sources.filter((s) => !s.disabled);
    // The row(s) driving the rollup: the worst-ranked status, oldest age
    // first (a measurable regression named ahead of a "never activity" row
    // with no age, mirroring the prior implementation's B2 fix).
    const worstRank = SOURCE_STATUS_RANK[health.rollupStatus as SourceStatus];
    const worstRows = active.filter((s) => SOURCE_STATUS_RANK[s.status] === worstRank);
    let named = worstRows[0] ?? null;
    for (const row of worstRows) {
      if (named === null) {
        named = row;
        continue;
      }
      const rowAge = row.ageHours ?? Number.POSITIVE_INFINITY;
      const namedAge = named.ageHours ?? Number.POSITIVE_INFINITY;
      if (rowAge > namedAge) named = row;
    }

    if (named === null) {
      // Defensive — rollupStatus non-null implies at least one active row.
      setFreshnessText("Estado desconocido");
      setFreshnessStale(false);
      setFreshnessRefreshing(false);
      setFreshnessUnknown(true);
      setFreshnessTooltip(null);
      return;
    }

    if (named.ageHours === null) {
      setFreshnessText("Datos sin sincronizar");
      setFreshnessStale(health.rollupStatus === "atascado" || health.rollupStatus === "fallando");
      setFreshnessRefreshing(health.rollupStatus === "pendiente");
      setFreshnessTooltip(`${named.source}: sin actividad de datos todavía`);
      return;
    }

    const age = formatSourceAge(named.ageHours);
    const stale = health.rollupStatus === "atascado" || health.rollupStatus === "fallando";
    const pending = health.rollupStatus === "pendiente";

    setFreshnessText(
      health.rollupStatus === "fallando"
        ? `Fallo de sincronización · ${age}`
        : stale
          ? `Datos desactualizados · ${age}`
          : pending
            ? `Sincronización pendiente · ${age}`
            : `Datos al día · ${age}`,
    );
    setFreshnessStale(stale);
    setFreshnessRefreshing(pending);
    setFreshnessTooltip(
      named.lastActivityAt
        ? `Última actividad (${named.source}): ${formatDate(named.lastActivityAt)}`
        : `${named.source}: ${age}`,
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
