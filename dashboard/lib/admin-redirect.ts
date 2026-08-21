/**
 * Shared helpers for post-login redirect handling in the admin area.
 *
 * The middleware forwards the originally requested path as `?redirect=<path>`
 * to `/admin/login`. After a successful login, we return the user to that
 * target — but only if the value is a safe *local* path.
 *
 * Rejecting everything else prevents open-redirect attacks where a crafted
 * value like `//evil.example.com` or `https://evil.example.com` would send
 * the user off-site once they hold a valid session cookie.
 */

/**
 * Fallback landing page when no valid redirect target is supplied.
 *
 * Fixed in #653/#636: this used to be `/admin/slow-queries` — a stale value
 * left over from before #638 built the Estado board, so a login with no
 * redirect target (or one that failed validation) landed the owner on a
 * slow-SQL table instead of "what's broken right now". `/admin` IS the Estado
 * board now (`app/admin/page.tsx`, D-144) — the actual landing, not a
 * redirect stub — so this constant doubling as both the default AND the real
 * root is correct, not a special case that needs extra handling below.
 *
 * Invariant: this value must (a) pass all the validation rules in
 * `safeAdminRedirectTarget`, and (b) not be the login page. It is a
 * compile-time constant so there is no runtime loop risk.
 */
export const DEFAULT_ADMIN_LANDING = "/admin";

// Matches ASCII control characters (0x00-0x1F, 0x7F) plus any whitespace.
// These must never appear in a Location header because CR/LF could be abused
// to inject headers, and other whitespace would have been percent-encoded by
// the browser if legitimate.
// eslint-disable-next-line no-control-regex
const CONTROL_OR_WHITESPACE = /[\x00-\x1F\x7F\s]/;

// Matches any local application path.
//
// Previously restricted to `/admin` and `/etl`, back when those were the only
// gated surfaces. Every page is now gated (this is a single-operator tool —
// see `middleware.ts`), so a user can be bounced to login from anywhere and
// must be able to return there. The open-redirect protections below (absolute
// local path only, no protocol-relative `//host`, no backslashes, no control
// characters) are what actually prevent off-site redirection, and they are
// unchanged.
const ADMIN_AREA_PATH = /^\/(?!\/)/;

/**
 * Returns a sanitized local redirect path, or the default landing page if the
 * supplied value is missing, malformed, or not inside the admin area.
 *
 * Accepts only paths that:
 * - start with a single `/` (rejects protocol-relative `//…` and any URL with
 *   a scheme such as `http:`/`https:`/`javascript:`/`data:`).
 * - do not contain a backslash (rejects quirks like `/\evil.example.com`).
 * - contain no control characters or whitespace.
 * - are not the login page itself.
 *
 * A bare `/admin` passes these rules unchanged and is returned as-is — no
 * special-casing needed, since `DEFAULT_ADMIN_LANDING` now equals `/admin`
 * too (see its own comment for why that used to require a workaround here
 * and no longer does).
 */
export function safeAdminRedirectTarget(input: string | null | undefined): string {
  if (typeof input !== "string") return DEFAULT_ADMIN_LANDING;
  const value = input.trim();
  if (value.length === 0) return DEFAULT_ADMIN_LANDING;

  // Must be an absolute local path.
  if (!value.startsWith("/")) return DEFAULT_ADMIN_LANDING;
  // Reject protocol-relative (`//host`) and any backslash tricks.
  if (value.startsWith("//")) return DEFAULT_ADMIN_LANDING;
  if (value.includes("\\")) return DEFAULT_ADMIN_LANDING;

  // Reject any control characters (including CR/LF) or whitespace.
  if (CONTROL_OR_WHITESPACE.test(value)) return DEFAULT_ADMIN_LANDING;

  // Normalize dot-segments (e.g. `/admin/../` → `/`) so that paths like
  // `/admin/../somewhere` cannot pass the allowlist check but resolve to a
  // non-admin path after user-agent normalization.
  let parsed: URL;
  try {
    parsed = new URL(value, "http://local");
  } catch {
    return DEFAULT_ADMIN_LANDING;
  }
  const pathOnly = parsed.pathname;

  // Only admin-area paths are allowed after normalizing dot segments.
  if (!ADMIN_AREA_PATH.test(pathOnly)) return DEFAULT_ADMIN_LANDING;

  // Never bounce back to the login page itself.
  if (pathOnly === "/admin/login" || pathOnly.startsWith("/admin/login/")) {
    return DEFAULT_ADMIN_LANDING;
  }

  return `${pathOnly}${parsed.search}${parsed.hash}`;
}
