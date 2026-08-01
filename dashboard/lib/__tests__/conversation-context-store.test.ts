/**
 * Unit tests for the conversation context-log file store.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  writeTurnContext,
  readTurnContext,
  relContextPath,
} from "../conversation-context-store";

const CONV = "abcdef012345";
const TURN = "550e8400-e29b-41d4-a716-446655440000";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "ctxstore-"));
  process.env.DASHBOARD_CONTEXT_DIR = dir;
});

afterEach(async () => {
  delete process.env.DASHBOARD_CONTEXT_DIR;
  await rm(dir, { recursive: true, force: true });
});

describe("writeTurnContext / readTurnContext", () => {
  it("round-trips a context object through a per-conversation/per-turn file", async () => {
    const ctx = { system_prompt_stable: "sys", tools: [{ name: "x" }], prior_messages: 3 };
    const rel = await writeTurnContext(CONV, TURN, ctx);
    expect(rel).toBe(relContextPath(CONV, TURN));
    expect(rel).toBe(`${CONV}/${TURN}.json`);

    const loaded = await readTurnContext(rel!);
    expect(loaded).toEqual(ctx);
  });

  it("returns null when the conversation id is unsafe (no traversal)", async () => {
    expect(await writeTurnContext("../etc", TURN, {})).toBeNull();
    expect(await writeTurnContext("bad id", TURN, {})).toBeNull();
  });

  it("readTurnContext returns null for a missing file", async () => {
    expect(await readTurnContext(`${CONV}/${TURN}.json`)).toBeNull();
  });

  it("readTurnContext rejects path traversal and malformed paths", async () => {
    // Plant a secret outside the conversation tree.
    await writeFile(join(dir, "secret.json"), JSON.stringify({ secret: true }), "utf-8");
    expect(await readTurnContext("../secret.json")).toBeNull();
    expect(await readTurnContext("abcdef012345/../../secret.json")).toBeNull();
    expect(await readTurnContext("not-a-valid-path")).toBeNull();
    expect(await readTurnContext("abcdef012345/turn.txt")).toBeNull();
  });

  it("readTurnContext returns null on malformed JSON", async () => {
    await mkdir(join(dir, CONV), { recursive: true });
    await writeFile(join(dir, CONV, `${TURN}.json`), "{ not json", "utf-8");
    expect(await readTurnContext(`${CONV}/${TURN}.json`)).toBeNull();
  });
});
