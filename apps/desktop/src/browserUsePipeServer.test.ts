// FILE: browserUsePipeServer.test.ts
// Purpose: Guards the desktop browser-use native pipe path helpers.
// Layer: Desktop test
// Depends on: Vitest and browserUsePipeServer path resolution exports

import * as Net from "node:net";
import * as OS from "node:os";
import { basename, dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";

import type { ThreadBrowserState, ThreadId } from "@synara/contracts";

import {
  BrowserUsePipeServer,
  SYNARA_BROWSER_USE_PIPE_ENV,
  resolveConfiguredBrowserUsePipePath,
  resolveDefaultBrowserUsePipePath,
} from "./browserUsePipeServer";
import type { DesktopBrowserManager } from "./browserManager";

interface BrowserUseMessage {
  id?: number;
  method?: string;
  result?: unknown;
  params?: unknown;
}

function encodeFrame(message: unknown): Buffer {
  const payload = Buffer.from(JSON.stringify(message), "utf8");
  const header = Buffer.alloc(4);
  if (OS.endianness() === "LE") {
    header.writeUInt32LE(payload.length, 0);
  } else {
    header.writeUInt32BE(payload.length, 0);
  }
  return Buffer.concat([header, payload]);
}

function makeFrameReader(socket: Net.Socket): {
  next: () => Promise<BrowserUseMessage>;
} {
  let pending = Buffer.alloc(0);
  const messages: BrowserUseMessage[] = [];
  const waiters: Array<(message: BrowserUseMessage) => void> = [];

  socket.on("data", (chunk) => {
    pending = Buffer.concat([pending, chunk]);
    while (pending.length >= 4) {
      const length = OS.endianness() === "LE" ? pending.readUInt32LE(0) : pending.readUInt32BE(0);
      if (pending.length < length + 4) break;
      const message = JSON.parse(pending.subarray(4, length + 4).toString("utf8"));
      pending = pending.subarray(length + 4);
      const waiter = waiters.shift();
      if (waiter) {
        waiter(message);
      } else {
        messages.push(message);
      }
    }
  });

  return {
    next: () => {
      const message = messages.shift();
      if (message) return Promise.resolve(message);
      return new Promise((resolve, reject) => {
        const timeout = setTimeout(
          () => reject(new Error("Timed out waiting for pipe frame")),
          1000,
        );
        waiters.push((nextMessage) => {
          clearTimeout(timeout);
          resolve(nextMessage);
        });
      });
    },
  };
}

function connectToPipe(pipePath: string): Promise<Net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = Net.createConnection(pipePath);
    socket.once("connect", () => resolve(socket));
    socket.once("error", reject);
  });
}

function request(
  socket: Net.Socket,
  id: number,
  method: string,
  params?: Record<string, unknown>,
): void {
  socket.write(encodeFrame({ jsonrpc: "2.0", id, method, ...(params ? { params } : {}) }));
}

function makeFakeBrowserManager() {
  type CdpEvent = { method: string; params?: unknown };
  const threadId = "thread-browser-use" as ThreadId;
  const state: ThreadBrowserState = {
    threadId,
    version: 1,
    open: true,
    activeTabId: "tab-a",
    tabs: [
      {
        id: "tab-a",
        url: "https://example.test/a",
        title: "Tab A",
        status: "live",
        isLoading: false,
        canGoBack: false,
        canGoForward: false,
        faviconUrl: null,
        lastCommittedUrl: "https://example.test/a",
        lastError: null,
      },
      {
        id: "tab-b",
        url: "https://example.test/b",
        title: "Tab B",
        status: "live",
        isLoading: false,
        canGoBack: false,
        canGoForward: false,
        faviconUrl: null,
        lastCommittedUrl: "https://example.test/b",
        lastError: null,
      },
    ],
    lastError: null,
  };
  const listenersByTab = new Map<string, Set<(event: CdpEvent) => void>>();
  const emptyListenerWaitersByTab = new Map<string, Set<() => void>>();
  const manager = {
    getBrowserUseSnapshot: () => ({ threadId, state }),
    attachBrowserUseTab: async () => undefined,
    subscribeToCdpEvents: (input: { tabId: string }, listener: (event: CdpEvent) => void) => {
      const listeners = listenersByTab.get(input.tabId) ?? new Set();
      listeners.add(listener);
      listenersByTab.set(input.tabId, listeners);
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0) {
          for (const resolve of emptyListenerWaitersByTab.get(input.tabId) ?? []) resolve();
          emptyListenerWaitersByTab.delete(input.tabId);
        }
      };
    },
    executeCdp: async () => ({}),
  } as unknown as DesktopBrowserManager;

  return {
    manager,
    emit: (tabId: string, event: CdpEvent) => {
      for (const listener of listenersByTab.get(tabId) ?? []) listener(event);
    },
    listenerCount: (tabId: string) => listenersByTab.get(tabId)?.size ?? 0,
    waitForNoListeners: (tabId: string) => {
      if ((listenersByTab.get(tabId)?.size ?? 0) === 0) return Promise.resolve();
      return new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(
          () => reject(new Error(`Timed out waiting for ${tabId} listener cleanup`)),
          1000,
        );
        const waiters = emptyListenerWaitersByTab.get(tabId) ?? new Set();
        waiters.add(() => {
          clearTimeout(timeout);
          resolve();
        });
        emptyListenerWaitersByTab.set(tabId, waiters);
      });
    },
  };
}

describe("browser-use pipe path resolution", () => {
  it("creates a discoverable unix socket path under the Codex browser-use directory", () => {
    const pipePath = resolveDefaultBrowserUsePipePath("darwin");

    expect(dirname(pipePath)).toBe(`${tmpdir()}/codex-browser-use`);
    expect(basename(pipePath)).toMatch(/^scient-iab-\d+\.sock$/);
  });

  it("prefers an explicit Synara pipe path from the environment", () => {
    expect(
      resolveConfiguredBrowserUsePipePath(
        {
          [SYNARA_BROWSER_USE_PIPE_ENV]: "/tmp/codex-browser-use/synara.sock",
        },
        "darwin",
      ),
    ).toBe("/tmp/codex-browser-use/synara.sock");
  });

  it("falls back to the generated path when the environment is empty", () => {
    expect(resolveConfiguredBrowserUsePipePath({}, "darwin")).toMatch(
      /codex-browser-use\/scient-iab-\d+\.sock$/,
    );
  });
});

describe("browser-use pipe session isolation", () => {
  it("routes CDP notifications only to the socket attached to that session", async () => {
    const pipePath =
      process.platform === "win32"
        ? String.raw`\\.\pipe\scient-browser-use-test-${process.pid}-${Date.now()}`
        : join(tmpdir(), `scient-browser-use-test-${process.pid}-${Date.now()}.sock`);
    const fake = makeFakeBrowserManager();
    const server = new BrowserUsePipeServer(fake.manager, { pipePath });
    await server.start();
    const socketA = await connectToPipe(pipePath);
    const socketB = await connectToPipe(pipePath);
    const readerA = makeFrameReader(socketA);
    const readerB = makeFrameReader(socketB);

    try {
      request(socketA, 1, "getTabs", { session_id: "session-a" });
      request(socketB, 1, "getTabs", { session_id: "session-b" });
      expect((await readerA.next()).id).toBe(1);
      expect((await readerB.next()).id).toBe(1);

      request(socketA, 2, "attach", { session_id: "session-a", tabId: 1 });
      request(socketB, 2, "attach", { session_id: "session-b", tabId: 2 });
      expect((await readerA.next()).id).toBe(2);
      expect((await readerB.next()).id).toBe(2);

      fake.emit("tab-a", { method: "Runtime.consoleAPICalled", params: { source: "a" } });
      request(socketA, 3, "ping");
      request(socketB, 3, "ping");

      expect((await readerA.next()).method).toBe("onCDPEvent");
      expect((await readerA.next()).id).toBe(3);
      expect((await readerB.next()).id).toBe(3);

      const socketAClosed = new Promise<void>((resolve) => socketA.once("close", resolve));
      socketA.destroy();
      await socketAClosed;
      await fake.waitForNoListeners("tab-a");
      expect(fake.listenerCount("tab-a")).toBe(0);

      fake.emit("tab-b", { method: "Page.loadEventFired", params: { source: "b" } });
      const remainingNotification = await readerB.next();
      expect(remainingNotification.method).toBe("onCDPEvent");
      expect(remainingNotification.params).toMatchObject({ method: "Page.loadEventFired" });
    } finally {
      socketA.destroy();
      socketB.destroy();
      await server.dispose();
    }
  });
});
