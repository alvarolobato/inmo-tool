import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { isApiPath, isPublicApiPath } from "@/lib/api-auth-policy";

/**
 * UI paths that require the `ps_admin` session cookie.
 *
 * This is a single-operator tool (issue #1 §16 rules out multi-tenancy), so
 * every surface is an operator surface: the candidate list, map, property
 * detail and conversations all render the operator's own private investment
 * research. They are gated on the same cookie as `/admin/*`, which also keeps
 * each page consistent with the APIs it calls — gating the APIs alone would
 * leave pages that render nothing but errors for a logged-out visitor.
 *
 * `/admin/login` must stay reachable, otherwise there is no way to obtain the
 * cookie in the first place.
 */
function isAdminUiPath(pathname: string): boolean {
  if (pathname === "/admin/login") return false;
  // API routes are handled by the gated-API branch, which answers with 401 for
  // machine callers. Falling through to the UI branch here would redirect a
  // *valid* header-authenticated API request to the login page (307), breaking
  // server-to-server callers such as the ETL post-run scoring callback.
  if (isApiPath(pathname)) return false;
  // Next.js internals and static assets never reach here (see `config.matcher`),
  // so anything left is an application page.
  return true;
}

/**
 * API routes requiring the admin credential: everything under `/api/` except
 * the small public allow-list in `lib/api-auth-policy.ts`.
 *
 * Gate-by-default is deliberate — see that module for why.
 *
 * Exported so `dashboard/__tests__/api-auth-coverage.test.ts` can assert
 * against the actual runtime gating decision rather than re-deriving an
 * equivalent (and, per #164, accidentally tautological) predicate of its own.
 */
export function isGatedApiPath(pathname: string): boolean {
  return isApiPath(pathname) && !isPublicApiPath(pathname);
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

  // Public probes are served before any credential check so container
  // orchestrators can reach them (they have no way to hold a credential).
  if (isPublicApiPath(pathname)) {
    return NextResponse.next();
  }

  const adminKey = process.env.ADMIN_API_KEY?.trim();
  if (!adminKey) {
    // Fail closed: with no key configured nothing can be authorized, so no
    // gated surface may be served.
    if (isGatedApiPath(pathname)) {
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

  if (isGatedApiPath(pathname)) {
    // Accept x-admin-key / Bearer header (server-to-server callers such as the
    // ETL orchestrator and the browser extension) OR the ps_admin session
    // cookie, which browsers attach automatically to same-origin fetches from
    // the UI.
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
  // Match everything except Next.js internals, the favicon, and static assets.
  // Gating is then decided in `middleware()` above (gate-by-default for
  // `/api/*`; every UI page except `/admin/login`), so a newly added route or
  // page is protected without touching this matcher.
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico|txt|xml|webmanifest)$).*)"],
};
