/**
 * Currently-served extension version — server-only, filesystem-backed (#527).
 *
 * The dashboard serves the packaged extension at `GET /api/extension/download`;
 * to tell an operator "you're on v0.13.2, v0.14.2 is available" the status route
 * needs to know which version that packaged zip actually is — WITHOUT hardcoding
 * it (a hardcoded number silently rots on the next manifest bump).
 *
 * The single source of truth is the extension's `manifest.json` `version`. Two
 * places surface it, tried in order:
 *   1. `<cwd>/public/extension-version.json` — written next to the zip by
 *      scripts/build-extension-zip.sh from that same manifest. This is the ONLY
 *      copy present inside the built container (browser-extension/ lives outside
 *      the ./dashboard build context, so it isn't in the image).
 *   2. `<cwd>/../browser-extension/manifest.json` — the source manifest, a
 *      sibling of ./dashboard at the repo root. Present in local dev and e2e
 *      (`npm run dev`, which never runs the zip build), absent in the container.
 *
 * Both resolve to the same number; the fallback just means "no build step ran".
 * Any read/parse failure yields null → the CTA simply shows no update prompt.
 *
 * Server-only (`node:fs`): never import from a client component. The CTA gets
 * the value through the status API response (`servedVersion`).
 */

import { readFile } from "node:fs/promises";
import path from "node:path";

/** Read a string `key` from a JSON file, or null on any failure. */
async function readJsonStringField(file: string, key: string): Promise<string | null> {
  try {
    const raw = await readFile(file, "utf8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const value = parsed[key];
    return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
  } catch {
    return null;
  }
}

/**
 * The version of the extension this dashboard currently serves, or null when it
 * can't be determined (no packaged version file and no source manifest).
 */
export async function readServedExtensionVersion(): Promise<string | null> {
  // 1. Container / production: build-extension-zip.sh emits this beside the zip.
  const fromPackage = await readJsonStringField(
    path.join(process.cwd(), "public", "extension-version.json"),
    "version",
  );
  if (fromPackage) return fromPackage;

  // 2. Local dev / e2e (no build step): the source manifest at the repo root.
  return readJsonStringField(
    path.join(process.cwd(), "..", "browser-extension", "manifest.json"),
    "version",
  );
}
