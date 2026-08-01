export function formatDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return "—";
  if (ms < 1000) return ms + "ms";
  const totalSecs = Math.floor(ms / 1000);
  const h = Math.floor(totalSecs / 3600);
  const m = Math.floor((totalSecs % 3600) / 60);
  const s = totalSecs % 60;
  if (h > 0) return h + "h " + m + "m";
  if (m > 0) return m + "m " + s + "s";
  return s + "s";
}

export function formatNumber(n: number | null | undefined): string {
  if (n === null || n === undefined) return "—";
  return n.toLocaleString("es-ES");
}

/** Format a watermark "age in seconds" as a short human string ("2h 15m"). */
export function formatAgeSeconds(s: number | null | undefined): string {
  if (s === null || s === undefined || Number.isNaN(s)) return "—";
  // Treat negative ages (clock skew) as "ahora" — they are never actionable.
  if (s < 60) return "< 1m";
  const totalMins = Math.floor(s / 60);
  const h = Math.floor(totalMins / 60);
  const m = totalMins % 60;
  if (h >= 24) {
    const d = Math.floor(h / 24);
    const remH = h % 24;
    return d + "d " + remH + "h";
  }
  if (h > 0) return h + "h " + m + "m";
  return m + "m";
}

/** Format rows-per-second with at most one decimal (never scientific). */
export function formatThroughput(rps: number | null | undefined): string {
  if (rps === null || rps === undefined || Number.isNaN(rps)) return "—";
  if (rps >= 1000) {
    return Math.round(rps).toLocaleString("es-ES") + " /s";
  }
  return rps.toFixed(1) + " /s";
}
