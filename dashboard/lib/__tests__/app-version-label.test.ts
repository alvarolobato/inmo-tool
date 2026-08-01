import { describe, expect, it } from "vitest";
import { formatAppFooterLines } from "../app-version-label";

describe("formatAppFooterLines", () => {
  it("shows only primary for empty git describe", () => {
    expect(formatAppFooterLines("0.1.0", "")).toEqual({
      primary: "PowerShop Analytics v0.1.0",
      secondary: null,
    });
  });

  it("treats exact semver tag as release (no secondary)", () => {
    expect(formatAppFooterLines("0.1.0", "v0.1.0")).toEqual({
      primary: "PowerShop Analytics v0.1.0",
      secondary: null,
    });
    expect(formatAppFooterLines("0.1.0", "1.2.3")).toEqual({
      primary: "PowerShop Analytics v0.1.0",
      secondary: null,
    });
  });

  it("shows short sha after tag for describe with distance", () => {
    expect(formatAppFooterLines("0.1.0", "v0.1.0-3-gdeadbeef")).toEqual({
      primary: "PowerShop Analytics v0.1.0",
      secondary: "deadbeef",
    });
  });

  it("shows abbreviated id for untagged describe", () => {
    const r = formatAppFooterLines("0.1.0", "abc1234");
    expect(r.primary).toBe("PowerShop Analytics v0.1.0");
    expect(r.secondary).toBe("abc1234");
  });

  it("marks dirty trees", () => {
    expect(formatAppFooterLines("0.1.0", "v0.1.0-3-gdeadbeef-dirty")).toEqual({
      primary: "PowerShop Analytics v0.1.0",
      secondary: "deadbeef · dirty",
    });
    expect(formatAppFooterLines("0.1.0", "abc1234-dirty")).toEqual({
      primary: "PowerShop Analytics v0.1.0",
      secondary: "abc1234 · dirty",
    });
  });
});
