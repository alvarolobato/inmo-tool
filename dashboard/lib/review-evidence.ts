/**
 * Attach query snapshots and dashboard URLs to weekly review v2 content.
 */

import type { ReviewQueryResult } from "./review-queries";
import { formatQueryResultAsText } from "./review-queries";
import type { ReviewContent, ReviewEvidenceDetail } from "./review-schema";

function snapshotForQuery(r: ReviewQueryResult): ReviewEvidenceDetail {
  const name = r.query.name;
  if (r.error) {
    return {
      query_name: name,
      snapshot: "(sin snapshot)",
      error: r.error,
    };
  }
  if (!r.result || r.result.rows.length === 0) {
    return { query_name: name, snapshot: "(sin filas)" };
  }
  const text = formatQueryResultAsText(name, r.result.columns, r.result.rows);
  const max = 420;
  return {
    query_name: name,
    snapshot: text.length > max ? `${text.slice(0, max)}…` : text,
  };
}

export function enrichReviewContent(
  content: ReviewContent,
  queryResults: ReviewQueryResult[],
  dashboardUrlsByKey: Record<string, string>,
): ReviewContent {
  const byName = new Map(queryResults.map((qr) => [qr.query.name, qr]));

  const sections = content.sections.map((s) => {
    const evidence = s.evidence_queries.map((q) => {
      const qr = byName.get(q);
      if (!qr) {
        return {
          query_name: q,
          snapshot: "(consulta desconocida)",
          error: "nombre de consulta no reconocido",
        } satisfies ReviewEvidenceDetail;
      }
      return snapshotForQuery(qr);
    });
    return {
      ...s,
      evidence,
      dashboard_url: dashboardUrlsByKey[s.dashboard_key] ?? dashboardUrlsByKey[s.key],
    };
  });

  const action_items = content.action_items.map((a) => {
    const evidence = a.evidence_queries.map((q) => {
      const qr = byName.get(q);
      if (!qr) {
        return {
          query_name: q,
          snapshot: "(consulta desconocida)",
          error: "nombre de consulta no reconocido",
        } satisfies ReviewEvidenceDetail;
      }
      return snapshotForQuery(qr);
    });
    return {
      ...a,
      evidence,
      dashboard_url: dashboardUrlsByKey[a.dashboard_key],
    };
  });

  return { ...content, sections, action_items };
}

export function computeQueryFailureRate(queryResults: ReviewQueryResult[]): number {
  if (queryResults.length === 0) return 0;
  const failed = queryResults.filter((r) => Boolean(r.error)).length;
  return failed / queryResults.length;
}
