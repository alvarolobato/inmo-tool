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
  // Issue #642 P1 (part of #636's admin-IA deletion pass): `/etl/connectors`
  // and `/etl/captura` are deleted outright — no page.tsx, so no route-table
  // entry — replaced by a wire-level 301 defined here rather than a
  // page-level `permanentRedirect()`. Two reasons this beats the page-level
  // pattern `/admin/usage/page.tsx` uses:
  //   1. The owner's standing complaint on this tracker is specifically
  //      "solo has añadido, no has eliminado nada" — a redirect STUB
  //      (page.tsx that just calls permanentRedirect()) still counts as a
  //      route in `next build`'s table, so replacing two config pages with
  //      two stubs plus two new Fuentes pages is a net INCREASE, repeating
  //      the exact complaint. A config-level redirect has no page.tsx at
  //      all — the route is genuinely gone.
  //   2. It is a REAL wire-level 301 + `Location` header (verified with
  //      curl against a production build below), not the page-level
  //      "200 + client-side RSC redirect" caveat documented on
  //      `/admin/usage/page.tsx` — strictly stronger than what P1 required
  //      (both routes are browser-only, so page-level would have been
  //      *acceptable*, just not as good).
  // `/etl/captura`'s `?portal=` maps onto the new route's `[name]` segment;
  // every original query param (`?status=`, and `?portal=` itself — Next
  // forwards the FULL original query string, it does not drop a param just
  // because a `has` rule captured it) is appended to the destination too.
  // Verified with curl: `/etl/captura?portal=aliseda&status=pending` → 308 →
  // `/admin/fuentes/aliseda?portal=aliseda&status=pending` — the duplicated
  // `portal=` is harmless (nothing on the destination page reads it; the
  // route param IS the scope) but real, so don't assert an exact query
  // string without accounting for it. No portal → the Fuentes list.
  async redirects() {
    return [
      {
        source: "/etl/connectors",
        destination: "/admin/fuentes",
        permanent: true,
      },
      {
        source: "/etl/captura",
        has: [{ type: "query", key: "portal", value: "(?<portal>.+)" }],
        destination: "/admin/fuentes/:portal",
        permanent: true,
      },
      {
        source: "/etl/captura",
        destination: "/admin/fuentes",
        permanent: true,
      },
    ];
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
