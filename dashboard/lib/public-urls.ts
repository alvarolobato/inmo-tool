/**
 * Runtime-safe public URL helpers.
 *
 * Reads from the config loader (env > config.yaml > schema defaults) so
 * changes made via the /admin/config UI take effect on the next page load
 * without needing to restart the container.
 *
 * Falls back to localhost defaults when the config system is unavailable
 * (e.g. when schema.yaml is missing).
 *
 * NOTE: server-side only — called from Server Components in layout.tsx.
 */

import { getSystemConfig } from "@/lib/system-config/loader";

function readFromConfig(key: string): string | null {
  try {
    const cfg = getSystemConfig();
    const val = cfg[key]?.value;
    if (val && typeof val === "string" && val.trim()) {
      return val.trim().replace(/\/$/, "");
    }
  } catch {
    // Schema or loader unavailable — fall through to env/default.
  }
  return null;
}

export function getAppPublicUrl(): string {
  return (
    readFromConfig("dashboard.app_public_url") ??
    (process.env.APP_PUBLIC_URL ?? "http://localhost:4000").replace(/\/$/, "")
  );
}

export function getWrenPublicUrl(): string {
  return (
    readFromConfig("dashboard.wren_public_url") ??
    (process.env.WREN_PUBLIC_URL ?? "http://localhost:3000").replace(/\/$/, "")
  );
}
