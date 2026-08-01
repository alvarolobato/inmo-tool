/**
 * Drift guard: ensures SYNC_NAMES_WITH_WATERMARK in dashboard/lib/etl-sync-names.ts
 * stays in sync with the Python tuple in etl/main.py.
 */
import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";
import { SYNC_NAMES_WITH_WATERMARK } from "@/lib/etl-sync-names";

function parsePythonSyncNames(src: string): string[] {
  // Match the tuple: SYNC_NAMES_WITH_WATERMARK: tuple[str, ...] = ( ... )
  const match = src.match(
    /SYNC_NAMES_WITH_WATERMARK\s*:\s*tuple\[str,\s*\.\.\.\]\s*=\s*\(([\s\S]*?)\)/,
  );
  if (!match) throw new Error("Could not find SYNC_NAMES_WITH_WATERMARK tuple in etl/main.py");
  const body = match[1];
  // Extract all quoted strings
  const names = [...body.matchAll(/"([^"]+)"|'([^']+)'/g)].map(
    (m) => m[1] ?? m[2],
  );
  return names;
}

describe("sync-names-drift", () => {
  const pyPath = path.resolve(__dirname, "../../etl/main.py");
  const pySrc = fs.readFileSync(pyPath, "utf8");
  const pyNames = parsePythonSyncNames(pySrc);

  it("detects drift between Python and TS sync names", () => {
    const tsSet = new Set(SYNC_NAMES_WITH_WATERMARK);
    const pySet = new Set(pyNames);

    const onlyInTs = [...tsSet].filter((n) => !pySet.has(n));
    const onlyInPy = [...pySet].filter((n) => !tsSet.has(n));

    expect(onlyInTs, `Names in TS but not Python: ${onlyInTs.join(", ")}`).toHaveLength(0);
    expect(onlyInPy, `Names in Python but not TS: ${onlyInPy.join(", ")}`).toHaveLength(0);
  });

  it("both lists have the same length", () => {
    expect(SYNC_NAMES_WITH_WATERMARK.length).toBe(pyNames.length);
  });
});
