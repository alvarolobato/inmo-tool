import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

/**
 * Paths that require the `ps_admin` session cookie (same auth as `/admin/*`).
 * The ETL monitor lives outside `/admin` but is still an administration
 * surface, so we gate it here instead of duplicating the flow.
 */
function isAdminUiPath(pathname: string): boolean {
  if (pathname === "/admin/login") return false;
  if (pathname === "/admin" || pathname.startsWith("/admin/")) return true;
  if (pathname === "/etl" || pathname.startsWith("/etl/")) return true;
  return false;
}

/**
 * ETL data API routes. Gated by the `ps_admin` cookie — the ETL UI calls
 * these same-origin and the browser attaches the cookie automatically.
 * Leaving them ungated would expose sync status and manual-trigger POSTs
 * even when the UI itself is protected.
 */
function isEtlApiPath(pathname: string): boolean {
  return pathname === "/api/etl" || pathname.startsWith("/api/etl/");
}

function buildLoginRedirect(request: NextRequest, errorCode?: "2"): URL {
  const url = new URL("/admin/login", request.url);
  if (errorCode) {
    url.searchParams.set("error", errorCode);
  }
  // Preserve the original path (+ query string) so the login action can
  // send the user back after authenticating. Only an internal path is
  // forwarded — see `safeAdminRedirectTarget` for the final validation.
  const originalPath = request.nextUrl.pathname + request.nextUrl.search;
  if (originalPath && originalPath !== "/admin/login") {
    url.searchParams.set("redirect", originalPath);
  }
  return url;
}

/**
 * Returns true when at least one of the two API-key header schemes carries the
 * expected admin key. Both `x-admin-key` and `Authorization: Bearer …` are
 * treated as equals (OR, not precedence) so a valid credential is accepted even
 * when a client accidentally includes an incorrect second header.
 */
function adminBearerValid(request: NextRequest, expected: string): boolean {
  const headerKey = request.headers.get("x-admin-key")?.trim();
  if (headerKey === expected) return true;
  const auth = request.headers.get("authorization");
  if (auth?.startsWith("Bearer ") && auth.slice(7).trim() === expected) return true;
  return false;
}

export function middleware(request: NextRequest): NextResponse {
  const { pathname } = request.nextUrl;

  const adminKey = process.env.ADMIN_API_KEY?.trim();
  if (!adminKey) {
    if (pathname.startsWith("/api/admin")) {
      return NextResponse.json(
        { error: "admin_not_configured", detail: "Set ADMIN_API_KEY in the environment." },
        { status: 503 },
      );
    }
    if (isEtlApiPath(pathname)) {
      return NextResponse.json(
        { error: "admin_not_configured", detail: "Set ADMIN_API_KEY in the environment." },
        { status: 503 },
      );
    }
    if (isAdminUiPath(pathname)) {
      return NextResponse.redirect(buildLoginRedirect(request, "2"));
    }
    return NextResponse.next();
  }

  if (pathname.startsWith("/api/admin")) {
    // Accept x-admin-key / Bearer header (server-to-server) OR the ps_admin
    // session cookie (same-origin UI calls from /admin/* pages).
    const cookie = request.cookies.get("ps_admin")?.value;
    if (cookie !== adminKey && !adminBearerValid(request, adminKey)) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }
  }

  if (isEtlApiPath(pathname)) {
    // Same-origin UI calls carry the `ps_admin` cookie set by /admin/login.
    // Also accept the header/Bearer scheme for server-to-server callers that
    // already authenticate against /api/admin/*.
    const cookie = request.cookies.get("ps_admin")?.value;
    if (cookie !== adminKey && !adminBearerValid(request, adminKey)) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }
  }

  if (isAdminUiPath(pathname)) {
    const cookie = request.cookies.get("ps_admin")?.value;
    if (cookie !== adminKey) {
      return NextResponse.redirect(buildLoginRedirect(request));
    }
  }

  return NextResponse.next();
}

export const config = {
  matcher: [
    "/api/admin/:path*",
    "/api/etl/:path*",
    "/admin/:path*",
    "/etl",
    "/etl/:path*",
  ],
};
