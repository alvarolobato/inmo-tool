import type { Metadata } from "next";
import ConfigPageClient from "./ConfigForm";

export const metadata: Metadata = {
  title: "Configuración — Admin",
};

export const dynamic = "force-dynamic";

/**
 * Server component — the page is protected by middleware (ps_admin cookie check).
 * The client component makes fetch() calls to /api/admin/config*; the browser
 * automatically attaches the ps_admin httpOnly cookie on same-origin requests,
 * and adminApiKeyValid() now accepts it. No secret is passed to the browser.
 */
export default function AdminConfigPage() {
  return <ConfigPageClient />;
}
