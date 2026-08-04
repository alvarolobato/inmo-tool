"use client";

import { useEffect, useRef, useState } from "react";

/**
 * Subtle "buscando datos nuevos para esta zona…" indicator shown after a
 * profile create/scope-edit kicks off an ad-hoc sweep (issue #245).
 *
 * It polls GET /api/etl/run?id=<triggerId> (same-origin — the browser attaches
 * the `ps_admin` cookie automatically, so no key is embedded in JS) until the
 * sweep reaches a terminal state, then calls `onSettled` once so the parent can
 * refresh its candidate counts. It never surfaces a scary error: a failed or
 * unreachable sweep just resolves the indicator quietly — the candidate list
 * was already re-materialized against existing data on save, so a crawl that
 * fails is a missed acceleration, not a broken save.
 *
 * `triggerId` may be null (enqueue failed / coalesced with no readable pending
 * id) — in that case nothing renders.
 */
export function RefreshIndicator({
  triggerId,
  onSettled,
}: {
  triggerId: number | null;
  onSettled?: () => void;
}) {
  const [phase, setPhase] = useState<"searching" | "done" | "hidden">(
    triggerId === null ? "hidden" : "searching",
  );
  // Guard so onSettled fires exactly once per trigger, even across re-renders.
  const settledRef = useRef(false);

  useEffect(() => {
    if (triggerId === null) {
      setPhase("hidden");
      return;
    }
    settledRef.current = false;
    setPhase("searching");

    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const settle = () => {
      if (settledRef.current) return;
      settledRef.current = true;
      onSettled?.();
    };

    const poll = async () => {
      try {
        const res = await fetch(`/api/etl/run?id=${triggerId}`, { cache: "no-store" });
        if (cancelled) return;
        if (res.ok) {
          const row: { status?: string } = await res.json();
          if (row.status === "done" || row.status === "failed") {
            setPhase("done");
            settle();
            // Leave the brief "listo" state up for a moment, then hide.
            timer = setTimeout(() => {
              if (!cancelled) setPhase("hidden");
            }, 4000);
            return;
          }
        } else {
          // A 404 (trigger row consumed/vanished) or any non-OK: stop quietly,
          // don't spin forever or alarm the operator.
          setPhase("hidden");
          settle();
          return;
        }
      } catch {
        // Network hiccup — keep polling; a persistent failure just means the
        // indicator lingers harmlessly until the page is left.
      }
      if (!cancelled) timer = setTimeout(poll, 3000);
    };

    // First poll after a short beat so a fast sweep doesn't flash.
    timer = setTimeout(poll, 1500);

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [triggerId, onSettled]);

  if (phase === "hidden") return null;

  const searching = phase === "searching";
  return (
    <div
      data-testid="refresh-indicator"
      role="status"
      aria-live="polite"
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        marginTop: 12,
        padding: "8px 12px",
        borderRadius: 8,
        border: "1px solid var(--border)",
        background: "var(--bg-1)",
        fontSize: 12,
        color: "var(--fg-muted)",
      }}
    >
      <span
        aria-hidden
        style={{
          width: 8,
          height: 8,
          borderRadius: "50%",
          background: searching ? "var(--accent)" : "var(--up, var(--accent))",
          opacity: searching ? 1 : 0.7,
          animation: searching ? "refreshpulse 1.1s ease-in-out infinite" : "none",
          flexShrink: 0,
        }}
      />
      <span>
        {searching
          ? "Buscando datos nuevos para esta zona…"
          : "Datos nuevos disponibles para esta zona."}
      </span>
      <style>{`@keyframes refreshpulse { 0%,100% { opacity: .35 } 50% { opacity: 1 } }`}</style>
    </div>
  );
}
