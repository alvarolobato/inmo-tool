"use client";

/**
 * One connector sweep, in full (issue #642 P2).
 *
 * Moved here from `/etl/[id]` when the `/etl` tree was retired. Actividad is
 * where a run is now *found* (its `crawl`/`sweep`/`manual` rows link here), so
 * the drill-down lives under Actividad rather than under a monitor page that
 * no longer exists. The old path keeps a wire-level 308 in `next.config.js` —
 * run URLs are the one `/etl/*` shape that gets bookmarked and pasted.
 *
 * The route is nested under `/admin/actividad/` deliberately: the admin strip
 * highlights Actividad while you are here (longest-prefix match in
 * `lib/admin-nav.ts`), so the drill-down never orphans the tab you came from.
 */

import { useParams } from "next/navigation";
import { RunDetail } from "@/components/actividad/RunDetail";

export default function ActividadRunDetailPage() {
  const { id } = useParams<{ id: string }>();
  return <RunDetail runId={id} />;
}
