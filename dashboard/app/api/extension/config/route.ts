/**
 * GET /api/extension/config — backend-driven extension configuration (issue #237).
 *
 * Returns the list of host suffixes the capture pipeline supports. The browser
 * extension (browser-extension/background.js) fetches and caches this to decide
 * which tabs show the "supported site" badge, so adding a new capture portal is
 * a pure backend change — no extension version bump (Fable's note, §3).
 *
 * Capture itself already works on ANY http(s) tab (popup.js injects the content
 * script on demand); this endpoint only drives the cosmetic badge, so a stale
 * cache or a failed fetch degrades gracefully — the extension falls back to a
 * hardcoded default list.
 *
 * Admin-gated by middleware (`/api/extension/*` is not on the public allow-list).
 * The extension already holds the admin key (options page) and sends it as
 * `x-admin-key`, same as the capture endpoints.
 */

import { NextResponse } from "next/server";
import { CAPTURE_HOST_SUFFIXES } from "@/lib/worklist";

export async function GET(): Promise<NextResponse> {
  return NextResponse.json({ capture_hosts: CAPTURE_HOST_SUFFIXES });
}
