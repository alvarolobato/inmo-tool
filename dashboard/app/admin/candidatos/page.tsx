import { redirect } from "next/navigation";

/**
 * Legacy route stub (#508). "Candidatos a promoción" was renamed to
 * "Clasificación" and moved to `/admin/clasificacion`; this permanent redirect
 * keeps old bookmarks and deep links (and the browser extension's, if any)
 * working. Delete once no external link points here.
 */
export default function AdminCandidatosRedirect() {
  redirect("/admin/clasificacion");
}
