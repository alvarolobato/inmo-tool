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
  // Issue #642 (P1 + P2, #636's admin-IA deletion pass): the whole `/etl`
  // tree is deleted — no page.tsx anywhere under it, so no route-table
  // entries — replaced by wire-level 301s defined here rather than by
  // page-level `permanentRedirect()` stubs. Two reasons this beats the
  // page-level pattern `/admin/usage/page.tsx` uses:
  //   1. The owner's standing complaint on this tracker is specifically
  //      "solo has añadido, no has eliminado nada" — a redirect STUB
  //      (page.tsx that just calls permanentRedirect()) still counts as a
  //      route in `next build`'s table, so replacing pages with stubs is a
  //      net zero at best, repeating the exact complaint. A config-level
  //      redirect has no page.tsx at all — the route is genuinely gone.
  //   2. It is a REAL wire-level 308 + `Location` header (verified with
  //      curl against a production build), not the page-level "200 +
  //      client-side RSC redirect" caveat documented on
  //      `/admin/usage/page.tsx`. For `/etl/salud` that is not a nicety but
  //      a requirement: an ALREADY-INSTALLED browser extension opens it from
  //      `chrome.notifications.onClicked`, and an extension only picks up the
  //      repointed URL when the owner reloads the zip (D-060). A client-side
  //      RSC redirect would be invisible to anything that inspects the
  //      response instead of running its JS.
  //
  // `/etl/captura`'s `?portal=` maps onto the new route's `[name]` segment;
  // every original query param (`?status=`, and `?portal=` itself — Next
  // forwards the FULL original query string, it does not drop a param just
  // because a `has` rule captured it) is appended to the destination too.
  // Verified with curl: `/etl/captura?portal=aliseda&status=pending` → 308 →
  // `/admin/fuentes/aliseda?portal=aliseda&status=pending` — the duplicated
  // `portal=` is harmless (nothing on the destination page reads it; the
  // route param IS the scope) but real, so don't assert an exact query
  // string without accounting for it. No portal → the Fuentes list.
  //
  // ORDER MATTERS for the `/etl/:id` rule: Next matches these top-to-bottom,
  // so the three named children (`salud`, `extension`, `connectors`/
  // `captura`) are declared before it. The `(\\d+)` constraint is belt and
  // braces on top of that — a run id is always numeric, and without the
  // constraint a future `/etl/<word>` link would silently resolve to a run
  // detail page for a non-numeric id.
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
      // P2. `/etl/salud` → Estado: the extension's block notification lands
      // here, and Estado is where an ACTIVE block now shows as an aviso chip
      // (the episode history lives on Actividad's `bloqueo` rows).
      {
        source: "/etl/salud",
        destination: "/admin",
        permanent: true,
      },
      {
        source: "/etl/extension",
        destination: "/admin/extension",
        permanent: true,
      },
      {
        source: "/etl/:id(\\d+)",
        destination: "/admin/actividad/run/:id",
        permanent: true,
      },
      {
        source: "/etl",
        destination: "/admin/actividad",
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
