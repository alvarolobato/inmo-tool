/**
 * GET /api/extension/download — serve the browser extension as a .zip (issue #256).
 *
 * The operator loads the extension via chrome://extensions → Load unpacked, but
 * first needs the files on disk. This streams a packaged copy so they never have
 * to locate `browser-extension/` in a git checkout.
 *
 * PACKAGING (see scripts/build-extension-zip.sh): `browser-extension/` lives at
 * the repo root, OUTSIDE the `./dashboard` docker build context, so it is zipped
 * into `dashboard/public/inmo-tool-extension.zip` on the host before the image is
 * built. In the standalone runtime `process.cwd()` is `/app` and public/ is copied
 * to `/app/public`, so the file resolves at `<cwd>/public/inmo-tool-extension.zip`
 * both in the container and in local dev. If the packaging step never ran, the file
 * is absent and we answer 503 — the setup page then shows the manual-folder fallback.
 *
 * Admin-gated: `/api/extension/*` is gate-by-default in middleware (not on the
 * public allow-list). The explicit `adminApiKeyValid` check here is defense in
 * depth and makes the "rejects without auth" unit test independent of middleware.
 */

import { NextRequest, NextResponse } from "next/server";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { adminApiKeyValid, adminUnauthorized } from "@/lib/admin-api-auth";

// Not exported: Next.js route modules may only export HTTP-method handlers and
// a fixed set of route-config fields — any other named export fails the build.
const EXTENSION_ZIP_FILENAME = "inmo-tool-extension.zip";

/** Absolute path to the packaged extension inside the running app. */
function zipPath(): string {
  return path.join(process.cwd(), "public", EXTENSION_ZIP_FILENAME);
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  if (!adminApiKeyValid(request)) {
    return adminUnauthorized();
  }

  let bytes: Buffer;
  try {
    bytes = await readFile(zipPath());
  } catch {
    return NextResponse.json(
      {
        error: "extension_package_unavailable",
        detail:
          "El paquete de la extensión no está disponible en esta imagen. " +
          "Ejecuta scripts/build-extension-zip.sh antes de construir el contenedor, " +
          "o carga la carpeta browser-extension/ del repositorio manualmente.",
      },
      { status: 503 },
    );
  }

  // Copy into a fresh, definitely-non-shared ArrayBuffer: the current DOM lib
  // types reject a Node Buffer / Uint8Array<ArrayBufferLike> as `BodyInit`
  // because its backing buffer could in principle be a SharedArrayBuffer.
  // `Uint8Array.from` yields a Uint8Array<ArrayBuffer>, which is a valid body.
  const body = Uint8Array.from(bytes);
  return new NextResponse(body, {
    status: 200,
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="${EXTENSION_ZIP_FILENAME}"`,
      "Content-Length": String(bytes.byteLength),
      // A freshly-built extension should always be re-fetched, not cached.
      "Cache-Control": "no-store",
    },
  });
}
