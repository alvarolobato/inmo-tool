/**
 * "Forzar captura + diagnóstico" — server-only DB access (issue #671).
 *
 * `extension_diagnostic` is a DIAGNOSTIC channel, never an ingest path — see
 * etl/schema/init.sql's table comment and the D-153 record for this feature.
 * `insertDiagnostic` uses the write pool (@/lib/db-write); never import this
 * from a client component. The list/get readers use the read-only pool
 * (@/lib/db), same split as every other admin data reader in this repo.
 *
 * Retrieval is admin-surface-only (no SQL needed) — see `/admin/diagnostics`
 * (app/admin/diagnostics/page.tsx), which lists recent diagnostics with their
 * detection summary + size, links to the raw HTML, and offers delete.
 */

import { query } from "@/lib/db";
import { sql } from "@/lib/db-write";
import { stripNulBytesDeep } from "@/lib/strip-nul-bytes";

/** Mirrors browser-extension/diagnostic.js buildDiagnosticBlock's output —
 * read here only for the admin list's summary columns; stored as opaque
 * JSONB otherwise (this repo never re-derives it server-side, see the
 * "single shared computation" rule in diagnostic.js's own header). */
export interface DiagnosticDetectionBlock {
  url?: string;
  timestamp?: string;
  extensionVersion?: string | null;
  detection?: {
    detailPortal?: string | null;
    listingPortal?: string | null;
    supportedPortal?: string | null;
    pageRole?: string | null;
  };
  renderReady?: {
    ready?: boolean;
    selector?: string | null;
    reason?: string | null;
    bodyTextLength?: number;
  };
  harvest?: {
    anchorCount?: number;
    extractDetailUrlsCount?: number;
  };
  block?: {
    blocked?: boolean;
    signature?: string | null;
  };
  mode?: {
    discoverSignalPresent?: boolean;
    validationActive?: boolean;
    autoCaptureEnabled?: boolean;
  };
  autoCaptureWouldFire?: boolean;
}

export interface NetworkEntry {
  url: string;
  method: string;
  status: number | null;
  type: "fetch" | "xhr";
  body: string | null;
  bodyTruncated: boolean;
  startedAtMs: number | null;
  finishedAtMs: number | null;
}

export interface DiagnosticNetworkCapture {
  entries: NetworkEntry[];
  droppedCount: number;
}

export interface InsertDiagnosticInput {
  url: string;
  html: string;
  title?: string | null;
  extensionVersion?: string | null;
  detection?: DiagnosticDetectionBlock | null;
  network?: DiagnosticNetworkCapture | null;
}

export interface DiagnosticSummary {
  id: number;
  url: string;
  title: string | null;
  createdAt: string;
  htmlBytes: number;
  extensionVersion: string | null;
  detailPortal: string | null;
  listingPortal: string | null;
  pageRole: string | null;
  renderReady: boolean | null;
  renderReadySelector: string | null;
  // WHY the verdict came out that way, and how much text the page actually
  // had -- the two fields that explain a `ready === false` (captured too
  // early) without opening the HTML. PR #675 review, B3.
  renderReadyReason: string | null;
  renderReadyBodyTextLength: number | null;
  // The "0 of 17" numbers: how many anchors the page carried vs. how many
  // detail URLs the harvest actually extracted from them. This gap IS the
  // Hipoges empty-shell bug the whole feature exists to make visible
  // (issue #671), so it belongs on the list, not behind a SQL query.
  anchorCount: number | null;
  extractDetailUrlsCount: number | null;
  blocked: boolean | null;
  blockSignature: string | null;
  autoCaptureWouldFire: boolean | null;
  networkEntryCount: number | null;
  networkDroppedCount: number | null;
}

export interface DiagnosticFull extends DiagnosticSummary {
  html: string;
  detection: DiagnosticDetectionBlock | null;
  network: DiagnosticNetworkCapture | null;
}

/**
 * Insert one diagnostic row. Returns the new row's id.
 *
 * `detection`/`network` are deep-sanitised HERE rather than at the route, so
 * the guarantee holds for every caller: a NUL surviving into either block
 * makes Postgres reject the whole INSERT with "unsupported Unicode escape
 * sequence" and the owner's diagnostic is lost with a 500 that says nothing
 * useful. The route's own `stripNulBytes` on `url`/`html`/`title` cannot
 * cover these -- they are `jsonb`, and `JSON.stringify` escapes a NUL rather
 * than emitting it raw, so sanitising the serialised text is a no-op (see
 * `stripNulBytesDeep`'s docstring). PR #675 review, B4.
 */
export async function insertDiagnostic(input: InsertDiagnosticInput): Promise<number> {
  const htmlBytes = Buffer.byteLength(input.html, "utf8");
  const detection = input.detection ? stripNulBytesDeep(input.detection) : null;
  const network = input.network ? stripNulBytesDeep(input.network) : null;
  const rows = await sql<{ id: number }>(
    `INSERT INTO extension_diagnostic
       (url, html, html_bytes, title, extension_version, detection, network, network_dropped_count)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING id`,
    [
      input.url,
      input.html,
      htmlBytes,
      input.title ?? null,
      input.extensionVersion ?? null,
      detection ? JSON.stringify(detection) : null,
      network ? JSON.stringify(network) : null,
      input.network ? input.network.droppedCount ?? 0 : null,
    ],
  );
  return rows[0].id;
}

const LIST_LIMIT_DEFAULT = 50;

function rowToSummary(row: unknown[]): DiagnosticSummary {
  const detection = row[6] as DiagnosticDetectionBlock | null;
  return {
    id: Number(row[0]),
    url: String(row[1]),
    title: row[2] == null ? null : String(row[2]),
    createdAt: new Date(row[3] as string).toISOString(),
    htmlBytes: Number(row[4]),
    extensionVersion: row[5] == null ? null : String(row[5]),
    detailPortal: detection?.detection?.detailPortal ?? null,
    listingPortal: detection?.detection?.listingPortal ?? null,
    pageRole: detection?.detection?.pageRole ?? null,
    renderReady: detection?.renderReady?.ready ?? null,
    renderReadySelector: detection?.renderReady?.selector ?? null,
    renderReadyReason: detection?.renderReady?.reason ?? null,
    renderReadyBodyTextLength: detection?.renderReady?.bodyTextLength ?? null,
    anchorCount: detection?.harvest?.anchorCount ?? null,
    extractDetailUrlsCount: detection?.harvest?.extractDetailUrlsCount ?? null,
    blocked: detection?.block?.blocked ?? null,
    blockSignature: detection?.block?.signature ?? null,
    autoCaptureWouldFire: detection?.autoCaptureWouldFire ?? null,
    networkEntryCount: row[7] == null ? null : Number(row[7]),
    networkDroppedCount: row[8] == null ? null : Number(row[8]),
  };
}

/** Most recent diagnostics, newest first — the /admin/diagnostics list. */
export async function listDiagnostics(limit = LIST_LIMIT_DEFAULT): Promise<DiagnosticSummary[]> {
  const res = await query(
    `SELECT id, url, title, created_at, html_bytes, extension_version, detection,
            jsonb_array_length(COALESCE(network->'entries', '[]'::jsonb)) AS network_entry_count,
            network_dropped_count
       FROM extension_diagnostic
      ORDER BY created_at DESC
      LIMIT $1`,
    [limit],
  );
  return res.rows.map(rowToSummary);
}

/** Total row count + storage used — the size-visibility requirement (issue
 * #671: "make size visible, so old ones prunable"). */
export async function getDiagnosticsStorageSummary(): Promise<{
  count: number;
  totalBytes: number;
}> {
  const res = await query(
    `SELECT COUNT(*)::bigint AS count, COALESCE(SUM(html_bytes), 0)::bigint AS total_bytes
       FROM extension_diagnostic`,
  );
  const row = res.rows[0];
  return { count: Number(row[0]), totalBytes: Number(row[1]) };
}

/** One full diagnostic (including the raw HTML), or null if it doesn't exist. */
export async function getDiagnostic(id: number): Promise<DiagnosticFull | null> {
  const res = await query(
    `SELECT id, url, title, created_at, html_bytes, extension_version, detection,
            jsonb_array_length(COALESCE(network->'entries', '[]'::jsonb)) AS network_entry_count,
            network_dropped_count, html, network
       FROM extension_diagnostic
      WHERE id = $1`,
    [id],
  );
  if (res.rows.length === 0) return null;
  const row = res.rows[0];
  return {
    ...rowToSummary(row),
    html: String(row[9]),
    detection: (row[6] as DiagnosticDetectionBlock | null) ?? null,
    network: (row[10] as DiagnosticNetworkCapture | null) ?? null,
  };
}

/** Delete one diagnostic. Returns true if a row was actually removed. */
export async function deleteDiagnostic(id: number): Promise<boolean> {
  const rows = await sql<{ id: number }>(
    `DELETE FROM extension_diagnostic WHERE id = $1 RETURNING id`,
    [id],
  );
  return rows.length > 0;
}
