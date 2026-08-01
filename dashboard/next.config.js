const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

/** @type {import('next').NextConfig} */
const nextConfig = {
  output: "standalone",
  // Required on Next.js 14 to actually run instrumentation.ts at server
  // start. Without this flag the file is silently ignored, so the
  // config-bootstrap and init.sql-migration steps in instrumentation.ts
  // never execute. Default-on from Next 15; explicit until we upgrade.
  experimental: {
    instrumentationHook: true,
  },
  env: {
    NEXT_PUBLIC_APP_PKG_VERSION: (() => {
      const raw = fs.readFileSync(path.join(__dirname, "package.json"), "utf8");
      return JSON.parse(raw).version;
    })(),
    NEXT_PUBLIC_APP_GIT_DESCRIBE: (() => {
      const fromEnv = process.env.APP_GIT_DESCRIBE?.trim();
      if (fromEnv) return fromEnv;
      try {
        return execSync("git describe --tags --always --dirty", {
          cwd: __dirname,
          encoding: "utf8",
        }).trim();
      } catch {
        return "";
      }
    })(),
  },
};

module.exports = nextConfig;
