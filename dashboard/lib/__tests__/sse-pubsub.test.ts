/**
 * Unit tests for the SSE pub/sub module.
 *
 * Tests: subscribe → publish → listener receives event; unsubscribe → no leak.
 */

import { describe, expect, it, beforeEach } from "vitest";
import { subscribe, publish, subscriberCount, __resetForTests } from "@/lib/sse-pubsub";

const CONV_A = "aaaaaa000001";
const CONV_B = "bbbbbb000002";

beforeEach(() => {
  __resetForTests();
});

describe("sse-pubsub", () => {
  it("delivers a published event to a subscriber", () => {
    const received: unknown[] = [];
    const unsubscribe = subscribe(CONV_A, (e) => received.push(e));

    publish(CONV_A, {
      dbEventId: 1,
      turnId: "turn-1",
      seq: 0,
      eventType: "context",
      payload: { model: "test" },
    });

    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({ dbEventId: 1, eventType: "context" });

    unsubscribe();
  });

  it("delivers an event to multiple subscribers for the same conversation", () => {
    const log1: unknown[] = [];
    const log2: unknown[] = [];
    const unsub1 = subscribe(CONV_A, (e) => log1.push(e));
    const unsub2 = subscribe(CONV_A, (e) => log2.push(e));

    publish(CONV_A, {
      dbEventId: 2,
      turnId: "turn-2",
      seq: 1,
      eventType: "log",
      payload: { text: "hello" },
    });

    expect(log1).toHaveLength(1);
    expect(log2).toHaveLength(1);

    unsub1();
    unsub2();
  });

  it("does not deliver events across conversations", () => {
    const logA: unknown[] = [];
    const logB: unknown[] = [];
    const unsubA = subscribe(CONV_A, (e) => logA.push(e));
    const unsubB = subscribe(CONV_B, (e) => logB.push(e));

    publish(CONV_A, {
      dbEventId: 3,
      turnId: "turn-3",
      seq: 0,
      eventType: "context",
      payload: {},
    });

    expect(logA).toHaveLength(1);
    expect(logB).toHaveLength(0);

    unsubA();
    unsubB();
  });

  it("stops delivering events after unsubscribe", () => {
    const received: unknown[] = [];
    const unsubscribe = subscribe(CONV_A, (e) => received.push(e));

    unsubscribe();

    publish(CONV_A, {
      dbEventId: 4,
      turnId: "turn-4",
      seq: 0,
      eventType: "complete",
      payload: {},
    });

    expect(received).toHaveLength(0);
  });

  it("auto-cleans up the emitter when the last subscriber leaves", () => {
    const unsub1 = subscribe(CONV_A, () => {});
    const unsub2 = subscribe(CONV_A, () => {});

    expect(subscriberCount(CONV_A)).toBe(2);

    unsub1();
    expect(subscriberCount(CONV_A)).toBe(1);

    unsub2();
    expect(subscriberCount(CONV_A)).toBe(0);
  });

  it("does not throw when publishing to a conversation with no subscribers", () => {
    expect(() =>
      publish("zzzzzz999999", {
        dbEventId: 99,
        turnId: "turn-x",
        seq: 0,
        eventType: "log",
        payload: {},
      }),
    ).not.toThrow();
  });

  it("returns a different unsubscribe function per subscription", () => {
    const unsub1 = subscribe(CONV_A, () => {});
    const unsub2 = subscribe(CONV_A, () => {});

    expect(unsub1).not.toBe(unsub2);

    unsub1();
    unsub2();
  });

  it("calling unsubscribe twice does not throw or corrupt the subscriber count", () => {
    const unsubscribe = subscribe(CONV_A, () => {});
    expect(subscriberCount(CONV_A)).toBe(1);
    unsubscribe();
    expect(subscriberCount(CONV_A)).toBe(0);
    expect(() => unsubscribe()).not.toThrow();
    expect(subscriberCount(CONV_A)).toBe(0);
  });
});
