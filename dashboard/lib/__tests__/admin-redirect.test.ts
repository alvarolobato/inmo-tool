import { describe, it, expect } from "vitest";
import { safeAdminRedirectTarget, DEFAULT_ADMIN_LANDING } from "@/lib/admin-redirect";

describe("safeAdminRedirectTarget", () => {
  describe("returns the value for safe admin-area paths", () => {
    it.each([
      "/admin",
      "/admin/",
      "/admin?foo=1",
      "/admin#top",
      "/admin/slow-queries",
      "/admin/tool-calls",
      "/admin/usage",
      "/admin/usage?period=7d",
      "/admin/usage#section",
      "/admin/slow-queries/123",
      "/etl",
      "/etl/",
      "/etl/42",
      "/etl/42?tab=steps",
    ])("accepts %s", (path) => {
      expect(safeAdminRedirectTarget(path)).toBe(path);
    });
  });

  describe("falls back to the default landing page for unsafe or non-admin values", () => {
    it.each([
      // Missing / empty / wrong type.
      [null, "null"],
      [undefined, "undefined"],
      ["", "empty string"],
      ["   ", "whitespace only"],
      // External / protocol-relative / data URLs.
      ["https://evil.example.com/admin", "absolute https URL"],
      ["http://evil.example.com", "absolute http URL"],
      ["//evil.example.com/admin", "protocol-relative URL"],
      ["//evil.example.com", "protocol-relative (short)"],
      ["javascript:alert(1)", "javascript: scheme"],
      ["data:text/html,<script>alert(1)</script>", "data: URL"],
      ["mailto:a@b.c", "mailto: scheme"],
      // Non-admin local paths.
      ["/", "root"],
      ["/dashboard/42", "dashboard path"],
      ["/review", "review page"],
      ["/api/admin/usage", "api path (handled via header auth, not session)"],
      // Admin-login itself would loop.
      ["/admin/login", "login page"],
      ["/admin/login?redirect=/etl", "login page with query"],
      ["/admin/login/", "login trailing slash"],
      // Backslash / CRLF / control chars — header injection attempts.
      ["/admin/\\evil.example.com", "embedded backslash"],
      ["/\\evil.example.com", "backslash protocol trick"],
      ["/admin/slow-queries\r\nSet-Cookie: x=1", "CRLF injection"],
      ["/admin/\tslow-queries", "tab character"],
      ["/admin/ slow-queries", "inner space"],
      // Prefix tricks that must not match `/admin` or `/etl`.
      ["/administrator", "prefix collision /admin"],
      ["/admin-tools", "hyphen after admin"],
      ["/etlsomething", "etl prefix collision"],
      ["/etl-stats", "hyphen after etl"],
      // Missing leading slash.
      ["admin/slow-queries", "relative path"],
      // (Bare /admin is now a valid target — it shows the admin index page.)
      // Dot-segment bypass attempts — normalize to a non-admin path.
      ["/admin/../", "dot-segment escaping admin root"],
      ["/admin/../dashboard", "dot-segment escaping to dashboard"],
      ["/etl/../../somewhere", "double dot-segment escaping etl"],
    ])("rejects %s (%s)", (value, _label) => {
      expect(safeAdminRedirectTarget(value as string | null | undefined)).toBe(DEFAULT_ADMIN_LANDING);
    });
  });

  it("trims surrounding whitespace before deciding", () => {
    expect(safeAdminRedirectTarget("  /admin/usage  ")).toBe("/admin/usage");
  });
});
