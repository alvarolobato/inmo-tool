/**
 * Build-time strings from next.config.js:
 * - NEXT_PUBLIC_APP_PKG_VERSION — package.json "version"
 * - NEXT_PUBLIC_APP_GIT_DESCRIBE — output of `git describe --tags --always --dirty` (or APP_GIT_DESCRIBE in Docker)
 */

export interface AppFooterLines {
  /** e.g. "PowerShop Analytics v0.1.0" */
  primary: string;
  /** Shown under primary when the tree is not an exact release tag (commit id, dirty, etc.) */
  secondary: string | null;
}

function isExactReleaseTag(describe: string): boolean {
  const d = describe.trim();
  return /^v?\d+\.\d+\.\d+$/.test(d);
}

export function formatAppFooterLines(pkgVersion: string, gitDescribe: string): AppFooterLines {
  const v = pkgVersion.trim() || "0.0.0";
  const d = gitDescribe.trim();
  const primary = `PowerShop Analytics v${v}`;

  if (!d || isExactReleaseTag(d)) {
    return { primary, secondary: null };
  }

  const dirty = d.includes("-dirty") ? " · dirty" : "";
  const gMatch = d.match(/-g([0-9a-f]+)(?:-dirty)?$/i);
  const short = gMatch?.[1] ?? (d.replace(/-dirty$/i, "").length <= 12 ? d.replace(/-dirty$/i, "") : d.replace(/-dirty$/i, "").slice(0, 7));

  return { primary, secondary: `${short}${dirty}` };
}

export function getAppFooterLines(): AppFooterLines {
  return formatAppFooterLines(
    process.env.NEXT_PUBLIC_APP_PKG_VERSION ?? "0.0.0",
    process.env.NEXT_PUBLIC_APP_GIT_DESCRIBE?.trim() ?? "",
  );
}
