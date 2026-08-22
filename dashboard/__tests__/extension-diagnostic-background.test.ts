/**
 * Integration tests for browser-extension/background.js's diagnostics/
 * network-capture WIRING (issue #671 — "forzar captura + diagnóstico").
 *
 * Same approach as extension-background-batch-queue.test.ts: background.js
 * loaded via Node's CommonJS `require` against a from-scratch chrome/self/
 * fetch stub, `importScripts` shimmed to `require()` the sibling files —
 * each test gets a byte-for-byte fresh module instance.
 *
 * Covers the state machine around the OPT-IN network-capture reload:
 *   armNetworkRecording  — requires the host permission to ALREADY be
 *                           granted (never requests it itself — a service
 *                           worker has no user-activation signal), then
 *                           registers the MAIN/ISOLATED dynamic content
 *                           scripts scoped to exactly one origin, with
 *                           persistAcrossSessions:false.
 *   recordNetworkEntry   — buffers only for the armed tab, and only with the
 *                           session nonce.
 *   disarmNetworkRecording — ALWAYS unregisters, whether or not anything was
 *                           buffered, and returns the capped entries.
 *   sweepStrandedNetworkRecorders / expireStaleNetworkRecordings — the
 *                           respawn/restart and walked-away nets.
 *   sendDiagnostic       — POSTs to the dedicated diagnostic endpoint, never
 *                           /api/extension/capture.
 *
 * WHAT THESE TESTS CANNOT COVER (issue #684, and stated here so nobody reads
 * a green run as "the lifecycle is fixed"): everything above runs against a
 * hand-written chrome stub in Node. No MAIN-world wrapper is installed, no
 * service worker is evicted, no browser is restarted. The eviction/restart
 * behaviour is asserted STRUCTURALLY — teardown reads chrome.storage.session
 * and chrome.scripting.getRegisteredContentScripts() rather than an
 * in-memory Map, and registration passes persistAcrossSessions:false — which
 * is the right shape, not a live proof. Only the smoke test in the D-164
 * record proves it.
 */

import { describe, it, expect, afterEach, vi } from "vitest";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const EXT_DIR = fileURLToPath(new URL("../../browser-extension/", import.meta.url));
const req = createRequire(import.meta.url);

const SIBLING_FILES = [
  "detect.js",
  "batch.js",
  "capture-search-url.js",
  "observe-search-url.js",
  "network-recorder.js",
  "background.js",
];

function resetRequireCache() {
  for (const file of SIBLING_FILES) {
    const resolved = req.resolve(path.join(EXT_DIR, file));
    delete req.cache[resolved];
  }
}

interface StorageArea {
  get: (keys?: string | string[] | null) => Promise<Record<string, unknown>>;
  set: (obj: Record<string, unknown>) => Promise<void>;
  remove: (keys: string | string[]) => Promise<void>;
}

function makeStorageArea(store: Record<string, unknown>): StorageArea {
  return {
    get: async (keys) => {
      if (keys == null) return { ...store };
      const list = Array.isArray(keys) ? keys : [keys];
      const out: Record<string, unknown> = {};
      for (const k of list) if (k in store) out[k] = store[k];
      return out;
    },
    set: vi.fn(async (obj: Record<string, unknown>) => {
      Object.assign(store, obj);
    }),
    remove: async (keys) => {
      const list = Array.isArray(keys) ? keys : [keys];
      for (const k of list) delete store[k];
    },
  };
}

function makeChromeMock(opts: { hasPermission?: boolean } = {}) {
  const local: Record<string, unknown> = {};
  const session: Record<string, unknown> = {};
  const sync: Record<string, unknown> = {};
  // Mirrors Chrome's real dynamic-content-script registry closely enough that
  // the #684 respawn sweep is actually exercised: register/unregister mutate
  // it, getRegisteredContentScripts reads it back, and unregistering an
  // UNKNOWN id rejects — which is why unregisterNetworkScripts falls back to
  // one id at a time.
  const registered: Array<{ id: string; [k: string]: unknown }> = [];
  const tabRemovedListeners: Array<(tabId: number) => void> = [];
  const alarmListeners: Array<(alarm: { name: string }) => void> = [];
  const messageListeners: Array<
    (msg: Record<string, unknown>, sender: unknown, respond: (r?: unknown) => void) => unknown
  > = [];
  return {
    __registered: registered,
    __tabRemovedListeners: tabRemovedListeners,
    __alarmListeners: alarmListeners,
    __messageListeners: messageListeners,
    storage: {
      local: makeStorageArea(local),
      session: makeStorageArea(session),
      sync: makeStorageArea(sync),
    },
    tabs: {
      create: vi.fn(async () => ({ id: 1 })),
      update: vi.fn(async () => ({})),
      remove: vi.fn(async () => {}),
      get: vi.fn(async () => ({})),
      query: vi.fn(async () => []),
      sendMessage: vi.fn(async () => null),
      onUpdated: { addListener: vi.fn() },
      onActivated: { addListener: vi.fn() },
      onRemoved: {
        addListener: vi.fn((fn: (tabId: number) => void) => {
          tabRemovedListeners.push(fn);
        }),
      },
    },
    alarms: {
      create: vi.fn(),
      clear: vi.fn(async () => true),
      onAlarm: {
        addListener: vi.fn((fn: (alarm: { name: string }) => void) => {
          alarmListeners.push(fn);
        }),
      },
    },
    runtime: {
      onMessage: {
        addListener: vi.fn(
          (
            fn: (
              msg: Record<string, unknown>,
              sender: unknown,
              respond: (r?: unknown) => void,
            ) => unknown,
          ) => {
            messageListeners.push(fn);
          },
        ),
      },
      onStartup: { addListener: vi.fn() },
      onInstalled: { addListener: vi.fn() },
      getManifest: () => ({ version: "0.16.0-test" }),
      lastError: undefined,
    },
    action: { setBadgeText: vi.fn(), setBadgeBackgroundColor: vi.fn(), setTitle: vi.fn() },
    scripting: {
      executeScript: vi.fn(async () => {}),
      registerContentScripts: vi.fn(async (scripts: Array<{ id: string }>) => {
        for (const script of scripts) registered.push({ ...script });
      }),
      getRegisteredContentScripts: vi.fn(async () => registered.map((r) => ({ ...r }))),
      unregisterContentScripts: vi.fn(async (filter?: { ids?: string[] }) => {
        const ids = filter?.ids;
        if (!ids) {
          registered.length = 0;
          return;
        }
        const missing = ids.filter((id) => !registered.some((r) => r.id === id));
        if (missing.length) throw new Error(`Nonexistent script ID '${missing[0]}'`);
        for (const id of ids) {
          const idx = registered.findIndex((r) => r.id === id);
          if (idx !== -1) registered.splice(idx, 1);
        }
      }),
    },
    permissions: {
      contains: vi.fn(async () => opts.hasPermission !== false),
      request: vi.fn(async () => true),
      remove: vi.fn(async () => true),
    },
  };
}

/** Drive one `chrome.runtime.onMessage` listener chain and resolve its reply. */
function sendMessage(
  chromeMock: ReturnType<typeof makeChromeMock>,
  msg: Record<string, unknown>,
  sender: unknown = {},
): Promise<unknown> {
  return new Promise((resolve) => {
    let settled = false;
    const respond = (r?: unknown) => {
      if (settled) return;
      settled = true;
      resolve(r);
    };
    let handled = false;
    for (const listener of chromeMock.__messageListeners) {
      if (listener(msg, sender, respond) === true) handled = true;
    }
    if (!handled) setTimeout(() => respond(undefined), 0);
  });
}

interface BackgroundModule {
  armNetworkRecording: (
    tabId: number,
    origin: string,
    grantedNow?: boolean,
  ) => Promise<{ success: boolean; error?: { message: string } }>;
  disarmNetworkRecording: (
    tabId: number,
  ) => Promise<{ entries: unknown[]; droppedCount: number } | null>;
  recordNetworkEntry: (tabId: number, entry: unknown, nonce?: string) => Promise<void>;
  getNetworkRecordingState: (
    tabId: number,
  ) => Promise<{ armed: boolean; entryCount: number; expiresAt?: number | null }>;
  sweepStrandedNetworkRecorders: () => Promise<{ swept: string[] }>;
  expireStaleNetworkRecordings: (nowMs?: number) => Promise<{ expired: number[] }>;
  networkScriptIds: (tabId: number) => string[];
  sendDiagnostic: (payload: {
    url: string;
    html: string;
    title?: string | null;
    diagnostic?: unknown;
    network?: unknown;
  }) => Promise<unknown>;
}

function loadBackground(
  chromeMock: ReturnType<typeof makeChromeMock>,
  fetchMock: ReturnType<typeof vi.fn>,
): BackgroundModule {
  resetRequireCache();
  (globalThis as unknown as { self: unknown }).self = globalThis;
  (globalThis as unknown as { chrome: unknown }).chrome = chromeMock;
  (globalThis as unknown as { fetch: unknown }).fetch = fetchMock;
  (globalThis as unknown as { importScripts: (...files: string[]) => void }).importScripts = (
    ...files: string[]
  ) => {
    for (const file of files) req(path.join(EXT_DIR, file));
  };
  return req(path.join(EXT_DIR, "background.js")) as BackgroundModule;
}

afterEach(() => {
  vi.restoreAllMocks();
  resetRequireCache();
  const g = globalThis as Record<string, unknown>;
  delete g.self;
  delete g.chrome;
  delete g.fetch;
  delete g.importScripts;
  delete g.InmoDetect;
  delete g.InmoBatch;
  delete g.InmoSearchUrl;
  delete g.InmoObserve;
  delete g.InmoNetworkRecorder;
});

function makeFetchMock() {
  return vi.fn(async () => ({ ok: true, json: async () => ({ success: true, id: 99 }) }));
}

/** Let queued microtasks/timers settle (top-level sweeps, fire-and-forget). */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/** The nonce background.js minted for `tabId`'s armed session. */
async function armedNonce(
  chromeMock: ReturnType<typeof makeChromeMock>,
  tabId: number,
): Promise<string> {
  const got = (await chromeMock.storage.session.get("diagArmed")) as {
    diagArmed?: Record<string, { nonce?: string }>;
  };
  return got.diagArmed?.[String(tabId)]?.nonce ?? "";
}

describe("armNetworkRecording", () => {
  it("fails without the host permission — and NEVER requests it itself (no user-activation signal in a service worker)", async () => {
    const chrome = makeChromeMock({ hasPermission: false });
    const fetchMock = makeFetchMock();
    const bg = loadBackground(chrome, fetchMock);

    const res = await bg.armNetworkRecording(1, "https://realestate.hipoges.com");

    expect(res.success).toBe(false);
    expect(chrome.permissions.request).not.toHaveBeenCalled();
    expect(chrome.scripting.registerContentScripts).not.toHaveBeenCalled();
  });

  it("registers a MAIN-world + ISOLATED-world content script pair scoped to exactly one origin", async () => {
    const chrome = makeChromeMock({ hasPermission: true });
    const fetchMock = makeFetchMock();
    const bg = loadBackground(chrome, fetchMock);

    const res = await bg.armNetworkRecording(7, "https://realestate.hipoges.com");

    expect(res.success).toBe(true);
    expect(chrome.scripting.registerContentScripts).toHaveBeenCalledTimes(1);
    const registered = chrome.scripting.registerContentScripts.mock.calls[0][0] as Array<{
      matches: string[];
      world: string;
      js: string[];
      persistAcrossSessions?: boolean;
    }>;
    expect(registered).toHaveLength(2);
    const mainEntry = registered.find((r) => r.world === "MAIN");
    const isolatedEntry = registered.find((r) => r.world === "ISOLATED");
    expect(mainEntry?.matches).toEqual(["https://realestate.hipoges.com/*"]);
    expect(mainEntry?.js).toEqual(["network-recorder.js", "network-recorder-main.js"]);
    expect(isolatedEntry?.matches).toEqual(["https://realestate.hipoges.com/*"]);
    expect(isolatedEntry?.js).toEqual(["network-recorder-relay.js"]);
    // Never <all_urls> — a recording session sees traffic for ONE origin only.
    for (const entry of registered) {
      expect(entry.matches).not.toContain("<all_urls>");
    }

    expect(await bg.getNetworkRecordingState(7)).toMatchObject({ armed: true, entryCount: 0 });
  });

  // ── #684 B1, half two ────────────────────────────────────────────────────
  // `chrome.scripting.registerContentScripts` DEFAULTS persistAcrossSessions
  // to TRUE. PR #675 omitted the field, so an armed recorder survived a
  // browser restart — while chrome.storage.session.diagArmed, the only
  // bookkeeping that could have found it again, is wiped on restart by
  // definition. Both scripts must opt out explicitly.
  it("opts BOTH scripts out of persistAcrossSessions — the default is true, and a restart wipes the only state that tracked them", async () => {
    const chrome = makeChromeMock({ hasPermission: true });
    const bg = loadBackground(chrome, makeFetchMock());

    await bg.armNetworkRecording(9, "https://realestate.hipoges.com");

    const registered = chrome.scripting.registerContentScripts.mock.calls[0][0] as Array<{
      persistAcrossSessions?: boolean;
    }>;
    for (const entry of registered) {
      expect(entry.persistAcrossSessions).toBe(false);
    }
  });

  // #684 M2: registerContentScripts is not atomic across the two entries, and
  // unregisterNetworkScripts' own docstring anticipates the half-registered
  // pair. Rolling back only the armed-registry entry left the sweep unable to
  // see the survivor as stranded on THIS worker generation (the registry entry
  // is gone, so it does sweep it — but only on the next respawn). Bounded in
  // practice by the relay's fail-closed HELLO; still contrary to this PR's own
  // unconditional-teardown principle.
  it("unregisters a HALF-registered pair when registration fails, not just the registry entry", async () => {
    const chrome = makeChromeMock({ hasPermission: true });
    const bg = loadBackground(chrome, makeFetchMock());
    // The MAIN script lands, the relay throws — exactly the half-registered
    // pair the docstring anticipates.
    chrome.scripting.registerContentScripts.mockImplementationOnce(
      async (scripts: Array<{ id: string }>) => {
        chrome.__registered.push({ ...scripts[0] });
        throw new Error("Duplicate script ID 'inmo-diag-9-relay'");
      },
    );

    const res = await bg.armNetworkRecording(9, "https://realestate.hipoges.com");

    expect(res.success).toBe(false);
    expect(chrome.__registered).toHaveLength(0); // the survivor is gone too
    expect(await bg.getNetworkRecordingState(9)).toMatchObject({ armed: false });
  });

  it("leaves no phantom armed session behind when registration fails", async () => {
    const chrome = makeChromeMock({ hasPermission: true });
    const bg = loadBackground(chrome, makeFetchMock());
    chrome.scripting.registerContentScripts.mockRejectedValueOnce(new Error("boom"));

    const res = await bg.armNetworkRecording(11, "https://realestate.hipoges.com");

    expect(res.success).toBe(false);
    expect(await bg.getNetworkRecordingState(11)).toMatchObject({ armed: false });
  });
});

describe("recordNetworkEntry", () => {
  it("buffers an entry for an armed tab, and does nothing for an unarmed one", async () => {
    const chrome = makeChromeMock({ hasPermission: true });
    const bg = loadBackground(chrome, makeFetchMock());

    await bg.armNetworkRecording(3, "https://realestate.hipoges.com");
    const nonce = await armedNonce(chrome, 3);
    await bg.recordNetworkEntry(3, { url: "https://realestate.hipoges.com/api/assets" }, nonce);
    await bg.recordNetworkEntry(999, { url: "https://example.invalid/should-be-dropped" }, nonce);

    expect(await bg.getNetworkRecordingState(3)).toMatchObject({ armed: true, entryCount: 1 });
    expect(await bg.getNetworkRecordingState(999)).toMatchObject({ armed: false, entryCount: 0 });
  });

  // #684 S5: the relay used to forward any same-origin postMessage carrying
  // `source: "inmo-diag-recorder"` — all forgeable by page script. The nonce
  // is checked in the relay AND again here, so a stale/forged relay message
  // can't inject a fabricated entry into a diagnostic.
  // storage.session has a hard byte quota (1 MB on older Chrome). Losing the
  // WRITE would lose every LATER entry too, silently — the same
  // fails-quietly-forever shape as B1, one layer down.
  it("sheds the oldest entries and keeps recording when the session-storage quota is hit", async () => {
    const chrome = makeChromeMock({ hasPermission: true });
    const bg = loadBackground(chrome, makeFetchMock());
    await bg.armNetworkRecording(41, "https://realestate.hipoges.com");
    const nonce = await armedNonce(chrome, 41);
    for (let i = 0; i < 4; i++) {
      await bg.recordNetworkEntry(41, { url: `https://realestate.hipoges.com/api/${i}` }, nonce);
    }

    const realSet = chrome.storage.session.set;
    let failNext = true;
    chrome.storage.session.set = vi.fn(async (obj: Record<string, unknown>) => {
      if (failNext && Object.keys(obj)[0].startsWith("diagNetBuf:")) {
        failNext = false;
        throw new Error("QUOTA_BYTES quota exceeded");
      }
      return realSet(obj);
    }) as typeof realSet;

    await bg.recordNetworkEntry(41, { url: "https://realestate.hipoges.com/api/newest" }, nonce);

    const state = await bg.getNetworkRecordingState(41);
    expect(state.armed).toBe(true);
    expect(state.entryCount).toBeGreaterThan(0);
    expect(state.entryCount).toBeLessThan(5);
    const result = await bg.disarmNetworkRecording(41);
    // The shed entries are REPORTED, never silently gone.
    expect(result!.droppedCount).toBeGreaterThan(0);
  });

  it("drops an entry whose nonce doesn't match the armed session", async () => {
    const chrome = makeChromeMock({ hasPermission: true });
    const bg = loadBackground(chrome, makeFetchMock());

    await bg.armNetworkRecording(4, "https://realestate.hipoges.com");
    await bg.recordNetworkEntry(4, { url: "https://realestate.hipoges.com/api/x" }, "wrong-nonce");

    expect(await bg.getNetworkRecordingState(4)).toMatchObject({ entryCount: 0 });
  });

  // The buffer lives in chrome.storage.session precisely so it OUTLIVES the
  // service worker. Re-loading the module against the same storage is this
  // suite's stand-in for an eviction + respawn: a fresh worker, the same
  // durable state.
  it("a buffer written before a worker eviction is still there for the disarm after the respawn", async () => {
    const chrome = makeChromeMock({ hasPermission: true });
    const first = loadBackground(chrome, makeFetchMock());
    await first.armNetworkRecording(21, "https://realestate.hipoges.com");
    const nonce = await armedNonce(chrome, 21);
    await first.recordNetworkEntry(21, { url: "https://realestate.hipoges.com/api/list" }, nonce);

    // …worker evicted; every in-memory variable in background.js is gone.
    const respawned = loadBackground(chrome, makeFetchMock());

    const result = await respawned.disarmNetworkRecording(21);
    expect(result).not.toBeNull();
    expect(result!.entries).toHaveLength(1);
  });
});

describe("disarmNetworkRecording", () => {
  // ── #684 B1, half one — this assertion is the INVERSE of the one PR #675
  // shipped. That test asserted `unregisterContentScripts` was NOT called
  // when nothing was buffered, which locked in the defect: `networkBuffers`
  // was an in-memory Map in an MV3 service worker Chrome evicts after ~30s
  // idle, so on the DOCUMENTED HAPPY PATH (arm, reload, page settles, worker
  // dies) disarm returned null before ever reaching the unregister — losing
  // the buffer AND leaving the MAIN-world fetch/XHR wrapper registered on
  // every tab of the origin, across restarts.
  //
  // "Is there a buffer for this tab" and "is there a registration for this
  // tab" are independent facts. Disarm now unregisters FIRST, unconditionally,
  // before it consults any state at all.
  it("unregisters the content scripts even when nothing was buffered for the tab", async () => {
    const chrome = makeChromeMock({ hasPermission: true });
    const bg = loadBackground(chrome, makeFetchMock());
    // A registration with no live session — exactly what a post-eviction
    // worker sees.
    await chrome.scripting.registerContentScripts([
      { id: "inmo-diag-42-main" },
      { id: "inmo-diag-42-relay" },
    ]);
    chrome.scripting.unregisterContentScripts.mockClear();

    const result = await bg.disarmNetworkRecording(42);

    expect(result).toBeNull(); // nothing to send…
    expect(chrome.scripting.unregisterContentScripts).toHaveBeenCalledWith({
      ids: ["inmo-diag-42-main", "inmo-diag-42-relay"],
    });
    expect(chrome.__registered).toHaveLength(0); // …but the recorder IS gone
  });

  it("still unregisters when NOTHING is registered either — a cheap no-op that can never leave a recorder behind", async () => {
    const chrome = makeChromeMock({ hasPermission: true });
    const bg = loadBackground(chrome, makeFetchMock());

    const result = await bg.disarmNetworkRecording(77);

    expect(result).toBeNull();
    expect(chrome.scripting.unregisterContentScripts).toHaveBeenCalled();
  });

  it("unregisters the content scripts and returns the buffered entries, then clears the buffer", async () => {
    const chrome = makeChromeMock({ hasPermission: true });
    const bg = loadBackground(chrome, makeFetchMock());

    await bg.armNetworkRecording(5, "https://realestate.hipoges.com");
    const nonce = await armedNonce(chrome, 5);
    await bg.recordNetworkEntry(
      5,
      { url: "https://realestate.hipoges.com/api/assets", method: "GET" },
      nonce,
    );

    const result = await bg.disarmNetworkRecording(5);

    expect(result).not.toBeNull();
    expect(result!.entries).toHaveLength(1);
    expect(result!.droppedCount).toBe(0);
    expect(chrome.scripting.unregisterContentScripts).toHaveBeenCalledWith({
      ids: ["inmo-diag-5-main", "inmo-diag-5-relay"],
    });
    // The buffer is gone — a second disarm is a clean no-op, not a re-send.
    expect(await bg.getNetworkRecordingState(5)).toMatchObject({ armed: false, entryCount: 0 });
    const second = await bg.disarmNetworkRecording(5);
    expect(second).toBeNull();
  });

  // #684 S7: every origin the owner ever diagnosed used to keep a standing
  // host grant, because chrome.permissions.remove appeared nowhere. Hand back
  // only the grant THIS recording created — an origin already granted for
  // capture must survive, or arming a recorder would silently break batch.
  it("revokes a host grant the recording itself created, and only that one", async () => {
    const chrome = makeChromeMock({ hasPermission: true });
    const bg = loadBackground(chrome, makeFetchMock());

    await bg.armNetworkRecording(31, "https://example.invalid", true);
    await bg.disarmNetworkRecording(31);
    expect(chrome.permissions.remove).toHaveBeenCalledWith({
      origins: ["https://example.invalid/*"],
    });

    chrome.permissions.remove.mockClear();
    await bg.armNetworkRecording(32, "https://realestate.hipoges.com", false);
    await bg.disarmNetworkRecording(32);
    expect(chrome.permissions.remove).not.toHaveBeenCalled();
  });
});

// ── #684 H1 ───────────────────────────────────────────────────────────────
// Unregistering the content scripts governs FUTURE injections only: Chrome
// does not retract a script from a document that already ran it. The first cut
// of this PR sent nothing into the armed tab and the relay registered no
// runtime.onMessage listener at all, so after SEND_DIAGNOSTIC / STOP / expiry /
// a sweep the MAIN-world wrapper stayed on window.fetch and the three
// XMLHttpRequest.prototype methods for the life of the document, still posting
// summarised entries (URL, headers, up-to-20 KB response bodies) onto the
// page's own message bus where any page script could read them. Nothing reached
// the DB — recordNetworkEntry drops it — but "a MAIN-world script wrapping
// window.fetch indefinitely" is the exact shape #684 exists to close, and the
// confirm() promises the owner the recording stops on all three of these.
//
// The page half — that the relay turns this message into an actual uninstall —
// is pinned in extension-network-recorder-wiring.test.ts.
describe("NETWORK_RECORDER_DISARM — every teardown path stops the ALREADY-INJECTED wrapper", () => {
  function disarmsSentTo(chrome: ReturnType<typeof makeChromeMock>, tabId: number) {
    const calls = chrome.tabs.sendMessage.mock.calls as unknown as Array<
      [number, { type?: string } | undefined]
    >;
    return calls.filter(
      ([id, msg]) => id === tabId && msg?.type === "NETWORK_RECORDER_DISARM",
    );
  }

  it("SEND_DIAGNOSTIC — the recorder in the page stops even though the send is what the owner asked for", async () => {
    const chrome = makeChromeMock({ hasPermission: true });
    const bg = loadBackground(chrome, makeFetchMock());
    await bg.armNetworkRecording(21, "https://realestate.hipoges.com");
    chrome.tabs.sendMessage.mockClear();

    await sendMessage(chrome, {
      type: "SEND_DIAGNOSTIC",
      tabId: 21,
      url: "https://realestate.hipoges.com/x",
      html: "<html></html>",
      title: "t",
      diagnostic: {},
    });
    await flush();

    expect(disarmsSentTo(chrome, 21)).toHaveLength(1);
  });

  it("STOP_NETWORK_RECORDING — the button the confirm() names by name", async () => {
    const chrome = makeChromeMock({ hasPermission: true });
    const bg = loadBackground(chrome, makeFetchMock());
    await bg.armNetworkRecording(22, "https://realestate.hipoges.com");
    chrome.tabs.sendMessage.mockClear();

    await sendMessage(chrome, { type: "STOP_NETWORK_RECORDING", tabId: 22 });
    await flush();

    expect(disarmsSentTo(chrome, 22)).toHaveLength(1);
  });

  it("expiry — an owner who arms and walks away", async () => {
    const chrome = makeChromeMock({ hasPermission: true });
    const bg = loadBackground(chrome, makeFetchMock());
    await bg.armNetworkRecording(23, "https://realestate.hipoges.com");
    chrome.tabs.sendMessage.mockClear();

    await bg.expireStaleNetworkRecordings(Date.now() + 60 * 60 * 1000);

    expect(disarmsSentTo(chrome, 23)).toHaveLength(1);
  });

  it("tab close — the document is usually gone, so this must not throw when there is no receiver", async () => {
    const chrome = makeChromeMock({ hasPermission: true });
    const bg = loadBackground(chrome, makeFetchMock());
    await bg.armNetworkRecording(24, "https://realestate.hipoges.com");
    chrome.tabs.sendMessage.mockImplementation(async () => {
      throw new Error("Could not establish connection. Receiving end does not exist.");
    });

    for (const listener of chrome.__tabRemovedListeners) listener(24);
    await flush();

    // Teardown completed regardless — a rejected sendMessage must never abort
    // the unregister or strand the armed-registry entry.
    expect(chrome.__registered).toHaveLength(0);
    expect(await bg.getNetworkRecordingState(24)).toMatchObject({ armed: false });
  });

  // A stranded registration whose tab the owner never closed still has a live
  // document with a live wrapper. Usually a no-op after a restart, but it is
  // the same defect.
  it("sweep — a stranded registration on a still-live document is told to uninstall", async () => {
    const chrome = makeChromeMock({ hasPermission: true });
    const bg = loadBackground(chrome, makeFetchMock());
    await chrome.scripting.registerContentScripts([
      { id: "inmo-diag-25-main" },
      { id: "inmo-diag-25-relay" },
    ]);
    chrome.tabs.sendMessage.mockClear();

    await bg.sweepStrandedNetworkRecorders();

    // Once per TAB, not once per script id.
    expect(disarmsSentTo(chrome, 25)).toHaveLength(1);
  });

  it("is sent unconditionally — even for a tab with no armed session and nothing registered", async () => {
    const chrome = makeChromeMock({ hasPermission: true });
    const bg = loadBackground(chrome, makeFetchMock());

    await bg.disarmNetworkRecording(26);

    expect(disarmsSentTo(chrome, 26)).toHaveLength(1);
  });
});

describe("tab close and expiry — the two paths that used to leave a recorder armed forever", () => {
  it("closing the armed tab disarms it (tabs.onRemoved only called endValidation before #684)", async () => {
    const chrome = makeChromeMock({ hasPermission: true });
    const bg = loadBackground(chrome, makeFetchMock());
    await bg.armNetworkRecording(13, "https://realestate.hipoges.com");
    expect(chrome.__registered.map((r) => r.id)).toContain("inmo-diag-13-main");

    for (const listener of chrome.__tabRemovedListeners) listener(13);
    await flush();

    expect(chrome.__registered).toHaveLength(0);
    expect(await bg.getNetworkRecordingState(13)).toMatchObject({ armed: false });
  });

  it("an armed session past its expiry is torn down by the expiry alarm — an owner who never sends is bounded", async () => {
    const chrome = makeChromeMock({ hasPermission: true });
    const bg = loadBackground(chrome, makeFetchMock());
    await bg.armNetworkRecording(14, "https://realestate.hipoges.com");
    expect(chrome.alarms.create).toHaveBeenCalledWith("inmo-diag-expiry", {
      periodInMinutes: 1,
    });

    // Well past DIAG_RECORDING_TTL_MS (5 min).
    const res = await bg.expireStaleNetworkRecordings(Date.now() + 60 * 60 * 1000);

    expect(res.expired).toEqual([14]);
    expect(chrome.__registered).toHaveLength(0);
    expect(chrome.alarms.clear).toHaveBeenCalledWith("inmo-diag-expiry");
  });

  it("does NOT expire a session still inside its window", async () => {
    const chrome = makeChromeMock({ hasPermission: true });
    const bg = loadBackground(chrome, makeFetchMock());
    await bg.armNetworkRecording(15, "https://realestate.hipoges.com");

    const res = await bg.expireStaleNetworkRecordings(Date.now() + 1000);

    expect(res.expired).toEqual([]);
    expect(chrome.__registered.map((r) => r.id)).toContain("inmo-diag-15-main");
  });
});

describe("sweepStrandedNetworkRecorders — the browser-restart net", () => {
  // After a restart chrome.storage.session is empty by definition, so EVERY
  // surviving inmo-diag-* registration is stranded. This matters even with
  // persistAcrossSessions:false in place today: a recorder armed by an
  // 0.18.0-or-earlier build was registered persistently and would otherwise
  // wrap fetch on that origin forever, with nothing in the extension aware.
  it("unregisters every inmo-diag-* script when no session claims it", async () => {
    const chrome = makeChromeMock({ hasPermission: true });
    const bg = loadBackground(chrome, makeFetchMock());
    await chrome.scripting.registerContentScripts([
      { id: "inmo-diag-8-main" },
      { id: "inmo-diag-8-relay" },
      { id: "inmo-diag-99-main" },
    ]);

    const res = await bg.sweepStrandedNetworkRecorders();

    expect(res.swept.sort()).toEqual([
      "inmo-diag-8-main",
      "inmo-diag-8-relay",
      "inmo-diag-99-main",
    ]);
    expect(chrome.__registered).toHaveLength(0);
  });

  it("leaves an ACTIVE session's scripts alone — a worker respawn mid-recording must not kill the recording", async () => {
    const chrome = makeChromeMock({ hasPermission: true });
    const bg = loadBackground(chrome, makeFetchMock());
    await bg.armNetworkRecording(8, "https://realestate.hipoges.com");
    await chrome.scripting.registerContentScripts([{ id: "inmo-diag-99-main" }]);

    const res = await bg.sweepStrandedNetworkRecorders();

    expect(res.swept).toEqual(["inmo-diag-99-main"]);
    expect(chrome.__registered.map((r) => r.id).sort()).toEqual([
      "inmo-diag-8-main",
      "inmo-diag-8-relay",
    ]);
  });

  it("never touches a registration that isn't ours", async () => {
    const chrome = makeChromeMock({ hasPermission: true });
    const bg = loadBackground(chrome, makeFetchMock());
    await chrome.scripting.registerContentScripts([{ id: "some-other-feature" }]);

    const res = await bg.sweepStrandedNetworkRecorders();

    expect(res.swept).toEqual([]);
    expect(chrome.__registered.map((r) => r.id)).toEqual(["some-other-feature"]);
  });

  it("runs on worker spawn, so an eviction respawn that no lifecycle event covers still cleans up", async () => {
    const chrome = makeChromeMock({ hasPermission: true });
    // A leftover from a previous browser session, with no live armed state.
    await chrome.scripting.registerContentScripts([{ id: "inmo-diag-4-main" }]);

    loadBackground(chrome, makeFetchMock());
    await flush();

    expect(chrome.__registered).toHaveLength(0);
  });
});

describe("NETWORK_RECORDER_HELLO — interception is confined to the armed tab (#684 B2)", () => {
  // registerContentScripts has no per-tab filter, so the recorder pair is
  // installed on EVERY tab of the armed origin. This handshake is how a tab
  // learns it isn't the one: the worker answers from _sender.tab.id, which
  // page script cannot forge, and a tab told `armed:false` makes the
  // MAIN-world recorder uninstall itself.
  it("tells the armed tab it is armed, and every other tab on the same origin that it is not", async () => {
    const chrome = makeChromeMock({ hasPermission: true });
    const bg = loadBackground(chrome, makeFetchMock());
    await bg.armNetworkRecording(51, "https://realestate.hipoges.com");

    const armedReply = (await sendMessage(chrome, { type: "NETWORK_RECORDER_HELLO" }, {
      tab: { id: 51 },
    })) as { armed: boolean; nonce?: string };
    const otherReply = (await sendMessage(chrome, { type: "NETWORK_RECORDER_HELLO" }, {
      tab: { id: 52 },
    })) as { armed: boolean };

    expect(armedReply.armed).toBe(true);
    expect(typeof armedReply.nonce).toBe("string");
    expect(otherReply.armed).toBe(false);
  });

  it("an entry relayed from a non-armed tab on the same origin is neither recorded nor answered as armed", async () => {
    const chrome = makeChromeMock({ hasPermission: true });
    const bg = loadBackground(chrome, makeFetchMock());
    await bg.armNetworkRecording(61, "https://realestate.hipoges.com");
    const nonce = await armedNonce(chrome, 61);

    // Same origin, same nonce (imagine it leaked) — but a different tab.
    await bg.recordNetworkEntry(62, { url: "https://realestate.hipoges.com/api/other" }, nonce);

    expect(await bg.getNetworkRecordingState(62)).toMatchObject({ armed: false, entryCount: 0 });
    expect(await bg.getNetworkRecordingState(61)).toMatchObject({ entryCount: 0 });
  });
});

describe("sendDiagnostic", () => {
  it("POSTs to /api/extension/diagnostic — NEVER /api/extension/capture", async () => {
    const chrome = makeChromeMock({ hasPermission: true });
    const fetchMock = makeFetchMock();
    const bg = loadBackground(chrome, fetchMock);

    await bg.sendDiagnostic({
      url: "https://realestate.hipoges.com/es/venta/pisos/espana/sevilla",
      html: "<html></html>",
      title: "t",
      diagnostic: { renderReady: { ready: true } },
      network: null,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [calledUrl, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(calledUrl).toMatch(/\/api\/extension\/diagnostic$/);
    expect(calledUrl).not.toContain("/api/extension/capture");
    const body = JSON.parse(init.body as string);
    expect(body.url).toBe("https://realestate.hipoges.com/es/venta/pisos/espana/sevilla");
    expect(body.diagnostic).toEqual({ renderReady: { ready: true } });
  });
});
