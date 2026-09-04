import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import { acknowledgeQueueSubmission, queueSubmissionId } from "./submission";

function createLocalStorageStub(): Storage {
  const store = new Map<string, string>();
  return {
    getItem: (key) => store.get(key) ?? null,
    setItem: (key, value) => {
      store.set(key, value);
    },
    removeItem: (key) => {
      store.delete(key);
    },
    clear: () => {
      store.clear();
    },
    key: (index) => [...store.keys()][index] ?? null,
    get length() {
      return store.size;
    },
  };
}

const target = "environment-1:thread-1";
const payload = { text: "hello", attachments: [] };
const globals = globalThis as typeof globalThis & { localStorage?: Storage };
let originalLocalStorage: Storage | undefined;
const originalCrypto = globalThis.crypto;

beforeEach(() => {
  originalLocalStorage = globals.localStorage;
  globals.localStorage = createLocalStorageStub();
});

afterEach(() => {
  if (originalLocalStorage === undefined) delete globals.localStorage;
  else globals.localStorage = originalLocalStorage;
  Object.defineProperty(globalThis, "crypto", {
    value: originalCrypto,
    configurable: true,
    writable: true,
  });
});

/** Drops `crypto.subtle` the way a non-secure context (plain-HTTP remote access) does. */
function withoutWebCrypto() {
  Object.defineProperty(globalThis, "crypto", {
    value: { getRandomValues: originalCrypto.getRandomValues.bind(originalCrypto) },
    configurable: true,
    writable: true,
  });
}

describe("queueSubmissionId", () => {
  it("reuses one identity for an unacknowledged retry of the same payload", async () => {
    const first = await queueSubmissionId(target, payload);
    expect(await queueSubmissionId(target, payload)).toBe(first);
  });

  it("issues a new identity once the payload changes", async () => {
    const first = await queueSubmissionId(target, payload);
    expect(await queueSubmissionId(target, { ...payload, text: "hello again" })).not.toBe(first);
  });

  it("issues a new identity after the previous submission is acknowledged", async () => {
    const first = await queueSubmissionId(target, payload);
    acknowledgeQueueSubmission(target, first);
    expect(await queueSubmissionId(target, payload)).not.toBe(first);
  });

  it("uses the existing SHA-256 receipt when Web Crypto is unavailable", async () => {
    const first = await queueSubmissionId(target, payload);
    withoutWebCrypto();
    expect(await queueSubmissionId(target, payload)).toBe(first);
  });

  it("scopes retries to the owning thread and environment", async () => {
    const first = await queueSubmissionId(target, payload);
    expect(await queueSubmissionId("environment-1:thread-2", payload)).not.toBe(first);
    expect(await queueSubmissionId("environment-2:thread-1", payload)).not.toBe(first);
    expect(await queueSubmissionId(target, payload)).toBe(first);
  });

  it("keeps working without Web Crypto, as on plain-HTTP remote access", async () => {
    withoutWebCrypto();
    const first = await queueSubmissionId(target, payload);
    expect(first).toMatch(/^qitem_/);
    expect(await queueSubmissionId(target, payload)).toBe(first);
    expect(await queueSubmissionId(target, { ...payload, text: "changed" })).not.toBe(first);
  });
});
