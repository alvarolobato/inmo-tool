import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

/** Shared 401 for missing/invalid admin API credentials. */
export function adminUnauthorized(): NextResponse {
  return NextResponse.json({ error: "unauthorized" }, { status: 401 });
}

/**
 * Validates the request against `ADMIN_API_KEY`.
 * Accepted credential forms (any one of):
 *   - `x-admin-key: <key>` request header
 *   - `Authorization: Bearer <key>` request header
 *   - `ps_admin` session cookie (same-origin UI calls; avoids sending the key in JS)
 *
 * When `ADMIN_API_KEY` is unset, no request is authorized (fail closed).
 */
export function adminApiKeyValid(request: NextRequest): boolean {
  // Intentionally reads env only — never from config.yaml — to prevent privilege
  // escalation via the UI: if the admin key were readable/writable from config.yaml,
  // an attacker who gained file-write access could replace it and lock out the real admin.
  const expected = process.env.ADMIN_API_KEY?.trim();
  if (!expected) return false;

  const headerKey = request.headers.get("x-admin-key")?.trim();
  if (headerKey === expected) return true;

  const auth = request.headers.get("authorization");
  if (auth?.startsWith("Bearer ") && auth.slice(7).trim() === expected) return true;

  // Also accept the ps_admin session cookie — set by /admin/login and sent
  // automatically by browsers for same-origin fetch(), avoiding the need to
  // embed the raw key in JS/HTML.
  const cookieValue = request.cookies.get("ps_admin")?.value;
  if (cookieValue === expected) return true;

  return false;
}
