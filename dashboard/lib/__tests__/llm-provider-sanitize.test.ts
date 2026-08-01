import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the system-config loader so getSensitiveLiterals() can return
// deterministic values without reading config.yaml. Each test toggles
// what literals to redact.
const sensitiveLiterals: Array<{ value: string; sensitive: boolean }> = [];
vi.mock("@/lib/system-config/loader", () => ({
  getSystemConfig: () =>
    Object.fromEntries(
      sensitiveLiterals.map((s, i) => [
        `mock.key${i}`,
        { value: s.value, sensitive: s.sensitive, source: "default", key: `mock.key${i}`, env: "X", section: "x", description: "", requires_restart: [], type: "string", default: null },
      ]),
    ),
}));

import { sanitize, sanitizeArgv, sanitizeTail } from "@/lib/llm-provider/sanitize";

beforeEach(() => {
  sensitiveLiterals.length = 0;
});

describe("sanitize()", () => {
  it("returns empty string for null/undefined/empty", () => {
    expect(sanitize(null)).toBe("");
    expect(sanitize(undefined)).toBe("");
    expect(sanitize("")).toBe("");
  });

  it("redacts Bearer tokens (case insensitive)", () => {
    // The Authorization-line pass redacts the entire value after the colon.
    expect(sanitize("Authorization: Bearer abcdefghij1234567890")).not.toContain(
      "abcdefghij1234567890",
    );
    // Bearer pattern alone (no Authorization prefix) is also redacted.
    expect(sanitize("token=Bearer xyz9999999999")).toContain("Bearer [redacted]");
  });

  it("redacts sk-... API keys (OpenAI / OpenRouter shape)", () => {
    expect(
      sanitize("OPENROUTER_API_KEY=sk-or-v1-abcdef0123456789ABCDEF\n"),
    ).toContain("[redacted]");
    expect(sanitize("openrouter ok sk-1234567890ABCDEFghij")).toContain(
      "[redacted]",
    );
  });

  it("redacts sk-ant-... long-lived OAuth tokens", () => {
    expect(sanitize("export sk-ant-oat01-abcdef-ghi-_-12345")).toContain(
      "[redacted]",
    );
  });

  it("redacts JWT-shaped tokens", () => {
    const jwt =
      "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";
    expect(sanitize(`token=${jwt}`)).toBe("token=[redacted]");
  });

  it("redacts postgres DSNs and basic-auth user:pass@host", () => {
    expect(sanitize("postgres://alice:hunter2@db:5432/x")).toContain(
      "postgres://[redacted]",
    );
    expect(sanitize("amqp://u:p@broker")).toContain(":[redacted]@");
  });

  it("redacts password=... fields", () => {
    expect(sanitize("password=topsecret&user=bob")).toContain("password=[redacted]");
  });

  it("redacts refresh_token / access_token JSON values", () => {
    const out = sanitize('{"refresh_token":"abcdef","other":"keep"}');
    expect(out).toContain("[redacted]");
    expect(out).toContain("keep");
    // Critical regression: the old replacement used `$&` which echoed the
    // entire match (including the secret) back into the output. Assert the
    // raw secret value never survives sanitization.
    expect(out).not.toContain("abcdef");
  });

  it("redacts access_token / refreshToken / accessToken JSON values without leaking the value", () => {
    const cases = [
      '{"access_token":"VERYSECRET-AAA"}',
      '{"refreshToken":"VERYSECRET-BBB"}',
      '{"accessToken":"VERYSECRET-CCC"}',
    ];
    for (const input of cases) {
      const out = sanitize(input);
      expect(out).toContain("[redacted]");
      expect(out).not.toMatch(/VERYSECRET-[ABC]{3}/);
    }
  });

  it("redacts realistic Anthropic sk-ant- credentials", () => {
    // Shape mimics `sk-ant-api03-…` long-lived API keys.
    const sample =
      "sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
    const out = sanitize(`Authorization: Bearer ${sample}\n`);
    expect(out).not.toContain(sample);
    expect(out).toContain("[redacted]");
  });

  it("redacts Authorization: Bearer eyJ… (JWT after scheme)", () => {
    const jwt =
      "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJ0ZXN0In0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";
    const out = sanitize(`Authorization: Bearer ${jwt}`);
    expect(out).not.toContain(jwt);
    expect(out).toContain("[redacted]");
  });

  it("redacts Authorization: Basic dXNlcjpwYXNz (basic auth)", () => {
    const value = "dXNlcjpwYXNzMTIzNA==";
    const out = sanitize(`Authorization: Basic ${value}`);
    expect(out).not.toContain(value);
    expect(out).toMatch(/Authorization:\s*Basic\s*\[redacted\]/);
  });

  it("redacts Authorization: Token abc123 (token scheme)", () => {
    const value = "tok_abc123_DEFGHI";
    const out = sanitize(`Authorization: Token ${value}`);
    expect(out).not.toContain(value);
    expect(out).toMatch(/Authorization:\s*Token\s*\[redacted\]/);
  });

  it("redacts known sensitive literal values from config schema", () => {
    sensitiveLiterals.push({ value: "MY-SUPER-SECRET-12345", sensitive: true });
    expect(sanitize("token leaked: MY-SUPER-SECRET-12345 again")).toContain("[redacted]");
    expect(sanitize("token leaked: MY-SUPER-SECRET-12345 again")).not.toContain(
      "MY-SUPER-SECRET-12345",
    );
  });

  it("does not scrub non-sensitive literals from config", () => {
    sensitiveLiterals.push({ value: "harmless-but-flagged", sensitive: false });
    expect(sanitize("harmless-but-flagged stays")).toContain("harmless-but-flagged");
  });

  it("is idempotent — running twice returns the same output", () => {
    const input = "Bearer ABCDEFGH12345 and sk-or-v1-12345abcdef";
    const once = sanitize(input);
    const twice = sanitize(once);
    expect(once).toBe(twice);
  });

  it("preserves clean diagnostic messages verbatim", () => {
    const msg = "claude agentic step: api_error_status=401 Invalid authentication credentials";
    expect(sanitize(msg)).toBe(msg);
  });
});

describe("sanitizeArgv()", () => {
  it("redacts the value following known credential flags", () => {
    expect(sanitizeArgv(["claude", "--api-key", "sk-or-v1-XXXX", "-p", "hi"])).toEqual(
      ["claude", "--api-key", "[redacted]", "-p", "hi"],
    );
  });

  it("sanitizes individual argv entries that themselves contain secrets", () => {
    const out = sanitizeArgv(["claude", "--header=Authorization: Bearer abcdefghij12345"]);
    // Either the Authorization rule or Bearer rule catches it — both are redacted.
    expect(out[1]).not.toContain("abcdefghij12345");
    expect(out[1]).toContain("[redacted]");
  });

  it("returns empty array unchanged", () => {
    expect(sanitizeArgv([])).toEqual([]);
  });

  it("truncates long prompt values after -p / --prompt", () => {
    const longPrompt = "x".repeat(500);
    const out = sanitizeArgv(["claude", "-p", longPrompt, "--model", "sonnet"]);
    expect(out[0]).toBe("claude");
    expect(out[1]).toBe("-p");
    expect(out[2].length).toBeLessThanOrEqual(260);
    expect(out[2]).toMatch(/truncated/);
    expect(out[3]).toBe("--model");
    expect(out[4]).toBe("sonnet");
  });

  it("redacts secrets that appear inside prompt-flag values", () => {
    const promptWithSecret =
      "Please summarize Authorization: Bearer abcdefghij1234567890 quickly";
    const out = sanitizeArgv(["claude", "--prompt", promptWithSecret]);
    expect(out[2]).not.toContain("abcdefghij1234567890");
    expect(out[2]).toContain("[redacted]");
  });
});

describe("sanitizeTail()", () => {
  it("returns sanitized tail of long input", () => {
    const big = "x".repeat(8192) + "\nBearer abcdefghij12345";
    const tail = sanitizeTail(big, 32);
    expect(tail.length).toBe(32);
    expect(tail).not.toContain("abcdefghij12345");
  });

  it("returns whole string when shorter than max", () => {
    expect(sanitizeTail("hello", 1000)).toBe("hello");
  });

  it("handles null/undefined", () => {
    expect(sanitizeTail(null, 100)).toBe("");
    expect(sanitizeTail(undefined, 100)).toBe("");
  });
});
