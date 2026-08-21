/**
 * Guard: no e2e spec may spread a Playwright device descriptor without first
 * stripping `defaultBrowserType`.
 *
 * Why this exists. `playwright.config.ts` declares exactly ONE project
 * (chromium), and CI installs exactly one browser (`npx playwright install
 * chromium --with-deps`). Every `devices["iPhone 13"]`-style descriptor
 * carries `defaultBrowserType: "webkit"`, and a file-level
 * `test.use({ ...devices["iPhone 13"] })` overrides the project's browser —
 * so the worker tries to launch a webkit binary that does not exist on the
 * runner and the spec dies at `browserType.launch` before its first
 * assertion, reported under a `[chromium]` label.
 *
 * That is not hypothetical: PR #683 shipped exactly this and reddened
 * `dashboard-e2e`. It passed locally only because a developer machine happens
 * to have webkit installed from an earlier `playwright install` — which also
 * means the spec was silently exercising the WRONG engine locally, and never
 * testing the chromium mobile emulation (issue #681) it was written for.
 *
 * Thirteen sibling specs already carry the correct destructuring block plus a
 * comment asking that it not be reintroduced. A comment did not hold. This
 * does.
 */
import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";

const E2E_DIR = path.resolve(__dirname, "../../e2e");

/** Strip line and block comments so prose about the rule can't trip the rule. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[^\n]*?\/\/[^\n]*$/gm, "");
}

function specFiles(): string[] {
  return fs
    .readdirSync(E2E_DIR)
    .filter((f) => f.endsWith(".spec.ts"))
    .sort();
}

describe("e2e device-descriptor convention", () => {
  it("finds the e2e specs (guard is not silently scanning nothing)", () => {
    expect(specFiles().length).toBeGreaterThan(0);
  });

  it("no spec spreads `devices[...]` directly — defaultBrowserType must be destructured out first", () => {
    const offenders = specFiles().filter((file) => {
      const code = stripComments(fs.readFileSync(path.join(E2E_DIR, file), "utf8"));
      return /\.\.\.\s*devices\s*\[/.test(code);
    });

    expect(
      offenders,
      `These specs spread a device descriptor whole, which carries ` +
        `defaultBrowserType: "webkit" and switches the worker to a browser CI ` +
        `does not install. Destructure it out first:\n\n` +
        `  const { defaultBrowserType: _defaultBrowserType, ...iPhone13 } = devices["iPhone 13"];\n` +
        `  test.use({ ...iPhone13 });\n`,
    ).toEqual([]);
  });

  it("every spec that uses a device descriptor also names defaultBrowserType", () => {
    const offenders = specFiles().filter((file) => {
      const code = stripComments(fs.readFileSync(path.join(E2E_DIR, file), "utf8"));
      if (!/\bdevices\s*\[/.test(code)) return false;
      return !/\bdefaultBrowserType\b/.test(code);
    });

    expect(
      offenders,
      "These specs reference a Playwright device descriptor but never strip " +
        "defaultBrowserType; see the destructuring block in mobile-dedup.spec.ts.",
    ).toEqual([]);
  });
});
