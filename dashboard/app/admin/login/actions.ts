"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { safeAdminRedirectTarget } from "@/lib/admin-redirect";

export async function loginAdmin(formData: FormData): Promise<void> {
  const password = String(formData.get("password") ?? "");
  const rawRedirect = formData.get("redirect");
  const target = safeAdminRedirectTarget(typeof rawRedirect === "string" ? rawRedirect : null);

  const expected = process.env.ADMIN_API_KEY?.trim();
  if (!expected) {
    redirect(buildLoginRedirect("/admin/login?error=2", target));
  }
  if (password !== expected) {
    redirect(buildLoginRedirect("/admin/login?error=1", target));
  }

  const jar = cookies();
  const secureFlag = process.env.ADMIN_COOKIE_SECURE === "true";
  // Single root-path cookie so the browser reliably sends it regardless of
  // which admin/etl path triggered the auth check. Path-scoped cookies caused
  // session loss in some Next.js edge-runtime scenarios.
  jar.set("ps_admin", expected, {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: secureFlag,
    maxAge: 60 * 60 * 24 * 30, // 30 days
    path: "/",
  });

  redirect(target);
}

/**
 * Preserve the redirect target when bouncing back to the login page with an
 * error, so the user still ends up where they intended after a retry.
 */
function buildLoginRedirect(base: string, target: string): string {
  const sep = base.includes("?") ? "&" : "?";
  return `${base}${sep}redirect=${encodeURIComponent(target)}`;
}
