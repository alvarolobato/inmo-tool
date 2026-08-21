import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { buildPgPoolConfig } from "../db-shared";

describe("buildPgPoolConfig", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.POSTGRES_DSN;
    delete process.env.POSTGRES_HOST;
    delete process.env.POSTGRES_PORT;
    delete process.env.POSTGRES_USER;
    delete process.env.POSTGRES_PASSWORD;
    delete process.env.POSTGRES_DB;
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("uses connectionString when POSTGRES_DSN is set", () => {
    process.env.POSTGRES_DSN = "postgres://user:pass@host/db";
    const cfg = buildPgPoolConfig({ max: 10 });
    expect(cfg.connectionString).toBe("postgres://user:pass@host/db");
    expect(cfg.max).toBe(10);
  });

  it("uses individual env vars when POSTGRES_DSN is absent", () => {
    process.env.POSTGRES_HOST = "myhost";
    process.env.POSTGRES_PORT = "5433";
    process.env.POSTGRES_USER = "myuser";
    process.env.POSTGRES_PASSWORD = "secret";
    process.env.POSTGRES_DB = "mydb";
    const cfg = buildPgPoolConfig({ max: 5 });
    expect(cfg.host).toBe("myhost");
    expect(cfg.port).toBe(5433);
    expect(cfg.user).toBe("myuser");
    expect(cfg.password).toBe("secret");
    expect(cfg.database).toBe("mydb");
    expect(cfg.max).toBe(5);
  });

  it("passes the caller's max through unchanged — db.ts/db-write.ts each own their own literal", () => {
    // This is a pure-function test of buildPgPoolConfig itself, not an
    // assertion about what db.ts/db-write.ts actually pass — see #666/D-149
    // for why db-write.ts's own `max` is 12, not 5.
    const readCfg = buildPgPoolConfig({ max: 10 });
    const writeCfg = buildPgPoolConfig({ max: 12 });
    expect(readCfg.max).toBe(10);
    expect(writeCfg.max).toBe(12);
  });

  it("applies statement_timeout and connectionTimeoutMillis", () => {
    const cfg = buildPgPoolConfig({ max: 10 });
    expect(typeof cfg.statement_timeout).toBe("number");
    expect(typeof cfg.connectionTimeoutMillis).toBe("number");
  });

  it("defaults host to localhost when env var absent", () => {
    const cfg = buildPgPoolConfig({ max: 10 });
    expect(cfg.host).toBe("localhost");
  });
});
