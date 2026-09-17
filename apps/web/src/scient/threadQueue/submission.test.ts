import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import { acknowledgeQueueSubmission, queueSubmissionId, prepareQueueMessage } from "./submission";
import { ComposerContextId, type OrchestrationMessageContext } from "@t3tools/contracts";
import { projectComposerContextForProvider } from "@t3tools/shared/composerContextReferences";

describe("queued message context", () => {
  const text = "Explain [Terminal](t3-context://v1/terminal/ctx_terminal)";
  const context: OrchestrationMessageContext = {
    version: 1,
    records: [
      {
        version: 1,
        kind: "terminal",
        contextId: ComposerContextId.make("ctx_terminal"),
        label: "Terminal",
        terminalId: "default",
        terminalLabel: "Terminal",
        lineStart: 1,
        lineEnd: 1,
        text: "measured result: 42",
      },
    ],
  };
  it("retains typed context for capable queues", () => {
    const message = prepareQueueMessage(text, context, true);
    expect(message).toEqual({ text, context });
    expect(
      projectComposerContextForProvider({ text: message.text, records: message.context!.records }),
    ).toContain("measured result: 42");
  });
  it("keeps retry identity when only the host's context delivery mode changes", async () => {
    const identify = (supportsContext: boolean) => {
      const payload = {
        ...prepareQueueMessage(text, context, supportsContext),
        composerSnapshot: "same draft",
        attachments: [],
      };
      const { text: _wireText, context: _wireContext, ...identity } = payload;
      return queueSubmissionId("context-retry", { ...identity, text, context });
    };
    expect(await identify(false)).toBe(await identify(true));
  });
  it("uses the existing context serializer for older queues", () => {
    const message = prepareQueueMessage(text, context, false);
    expect(message.context).toBeUndefined();
    expect(message.text).toContain("measured result: 42");
    expect(message.text).not.toContain("t3-context://");
    expect(prepareQueueMessage("hello", undefined, false)).toEqual({ text: "hello" });
  });
});

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
