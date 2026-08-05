/**
 * Small config readers for the notifications module — the same
 * env > config.yaml > default precedence the AI-assessment scheduler uses
 * (`lib/ai-assessment/scheduler.ts`), factored out so `email.ts` and
 * `scheduler.ts` share one implementation instead of each rolling their own.
 *
 * Reads through the central `getSystemConfig()` loader, falling back to the
 * env var, then a literal default. Loader-unavailable (schema file missing /
 * build context) falls through to env, matching the scheduler's tolerance.
 */

import { getSystemConfig } from "@/lib/system-config/loader";

export function readConfigString(key: string, envVar: string): string | null {
  try {
    const raw = getSystemConfig()[key]?.value;
    if (raw !== null && raw !== undefined) {
      const s = String(raw).trim();
      if (s !== "") return s;
    }
  } catch {
    // Loader unavailable — fall through to env.
  }
  const env = process.env[envVar];
  if (env !== undefined) {
    const s = env.trim();
    if (s !== "") return s;
  }
  return null;
}

export function readBool(key: string, envVar: string, fallback: boolean): boolean {
  const v = readConfigString(key, envVar);
  if (v === null) return fallback;
  return !(v === "false" || v === "0" || v.toLowerCase() === "no");
}

export function readPositiveInt(key: string, envVar: string, fallback: number): number {
  const v = readConfigString(key, envVar);
  if (v === null) return fallback;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

/** Like `readPositiveInt` but allows 0 (for an hour-of-day: 0 = midnight). */
export function readIntInRange(key: string, envVar: string, fallback: number, min: number, max: number): number {
  const v = readConfigString(key, envVar);
  if (v === null) return fallback;
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  const i = Math.floor(n);
  return i >= min && i <= max ? i : fallback;
}
