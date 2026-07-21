// FILE: wsTransport.test.ts
// Purpose: Verifies browser WebSocket construction around the Effect RPC transport.
// Layer: Web transport tests
// Depends on: the global WebSocket constructor shim and desktop bridge URL contract.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WS_CHANNELS } from "@synara/contracts";
import { Exit, Stream } from "effect";

import {
  EFFECT_RPC_RETRY_CONFIG,
  isConnectionProtocolFailure,
  isConnectionTransportFailure,
  shouldKeepServerLifecycleStream,
  streamRestartDelayMs,
  WsTransport,
} from "./wsTransport";

type WsEventType = "open" | "message" | "close" | "error";
type WsListener = (event?: { data?: unknown }) => void;

const sockets: MockWebSocket[] = [];

class MockWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  readyState = MockWebSocket.CONNECTING;
  readonly sent: unknown[] = [];
  private readonly listeners = new Map<WsEventType, Set<WsListener>>();

  constructor(readonly url: string) {
    sockets.push(this);
  }

  addEventListener(type: WsEventType, listener: WsListener) {
    const listeners = this.listeners.get(type) ?? new Set<WsListener>();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: WsEventType, listener: WsListener) {
    this.listeners.get(type)?.delete(listener);
  }

  send(data: unknown) {
    this.sent.push(data);
  }

  close() {
    this.readyState = MockWebSocket.CLOSED;
    this.emit("close");
  }

  private emit(type: WsEventType, event?: { data?: unknown }) {
    const listeners = this.listeners.get(type);
    if (!listeners) return;
    for (const listener of listeners) {
      listener(event);
    }
  }
}

const originalWebSocket = globalThis.WebSocket;

function makeStreamHarness() {
  const transport = new WsTransport("ws://localhost:3020");
  transport.dispose();
  const exits: Array<(exit: Exit.Exit<void, unknown>) => void> = [];
  const cancels: Array<ReturnType<typeof vi.fn>> = [];
  const runtime = {
    runCallback: vi.fn(
      (
        _effect: unknown,
        options: { readonly onExit: (exit: Exit.Exit<void, unknown>) => void },
      ) => {
        exits.push(options.onExit);
        const cancel = vi.fn();
        cancels.push(cancel);
        return cancel;
      },
    ),
  };
  const session = {
    generation: 1,
    value: { client: {}, clientScope: {}, runtime },
  };
  const supervisor = {
    currentSession: session,
    dispose: vi.fn(),
    invalidate: vi.fn(),
  };
  const internals = transport as unknown as {
    disposed: boolean;
    supervisor: typeof supervisor;
    startStream: (
      activeSession: typeof session,
      key: string,
      streamFactory: () => unknown,
      listener: (event: unknown) => void,
      options: { readonly isDesired: () => boolean; readonly replace?: boolean },
    ) => void;
    stopStream: (key: string) => void;
  };
  internals.disposed = false;
  internals.supervisor = supervisor;
  const start = (replace = true) =>
    internals.startStream(session, "test.stream", () => Stream.never, vi.fn(), {
      isDesired: () => true,
      replace,
    });
  const stop = () => internals.stopStream("test.stream");
  return { cancels, exits, runtime, start, stop, supervisor, transport };
}

beforeEach(() => {
  sockets.length = 0;
  vi.stubEnv("VITE_WS_URL", "");

  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      location: { protocol: "http:", hostname: "localhost", port: "3020" },
      desktopBridge: undefined,
    },
  });

  globalThis.WebSocket = MockWebSocket as unknown as typeof WebSocket;
});

afterEach(() => {
  vi.useRealTimers();
  globalThis.WebSocket = originalWebSocket;
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("WsTransport", () => {
  it("leaves all Effect RPC reconnects to ConnectionSupervisor", () => {
    expect(EFFECT_RPC_RETRY_CONFIG).toEqual({ retryTransientErrors: false, retryCount: 0 });
  });

  it("distinguishes transport failures from stream-local domain failures", () => {
    expect(isConnectionTransportFailure({ _tag: "SocketCloseError", code: 1006 })).toBe(true);
    expect(
      isConnectionTransportFailure({
        _tag: "RpcClientError",
        reason: { _tag: "SocketOpenError", kind: "Timeout" },
      }),
    ).toBe(true);
    expect(isConnectionTransportFailure(new Error("SocketCloseError in domain text"))).toBe(false);
    expect(
      isConnectionTransportFailure({
        _tag: "WsRpcError",
        message: "Provider request failed",
        cause: { _tag: "SocketCloseError", code: 1006 },
      }),
    ).toBe(false);
    expect(
      isConnectionTransportFailure({
        _tag: "SnapshotOutOfDate",
        message: "Resubscribe from the latest sequence",
      }),
    ).toBe(false);
  });

  it("recognizes only structured protocol failures and computes bounded jittered backoff", () => {
    expect(isConnectionProtocolFailure({ _tag: "ParseError" })).toBe(true);
    expect(isConnectionProtocolFailure(new Error("ParseError in domain text"))).toBe(false);
    expect(streamRestartDelayMs(0, () => 0.5)).toBe(250);
    expect(streamRestartDelayMs(1, () => 0.5)).toBe(500);
    expect(streamRestartDelayMs(99, () => 0.5)).toBe(10_000);
  });

  it("waits for exact old-stream settlement before installing a replacement", async () => {
    const harness = makeStreamHarness();
    harness.start();
    await vi.waitFor(() => expect(harness.runtime.runCallback).toHaveBeenCalledTimes(1));

    harness.start();
    await vi.waitFor(() => expect(harness.cancels[0]).toHaveBeenCalledTimes(1));
    expect(harness.runtime.runCallback).toHaveBeenCalledTimes(1);

    harness.exits[0]!(Exit.void);
    await vi.waitFor(() => expect(harness.runtime.runCallback).toHaveBeenCalledTimes(2));

    harness.transport.dispose();
  });

  it("waits for stream settlement across an unsubscribe-resubscribe race", async () => {
    const harness = makeStreamHarness();
    harness.start();
    await vi.waitFor(() => expect(harness.runtime.runCallback).toHaveBeenCalledTimes(1));

    harness.stop();
    harness.start();
    await vi.waitFor(() => expect(harness.cancels[0]).toHaveBeenCalledTimes(1));
    expect(harness.runtime.runCallback).toHaveBeenCalledTimes(1);

    harness.exits[0]!(Exit.void);
    await vi.waitFor(() => expect(harness.runtime.runCallback).toHaveBeenCalledTimes(2));
    harness.transport.dispose();
  });

  it("invalidates instead of starting a same-generation replacement when cancellation never settles", async () => {
    vi.useFakeTimers();
    const harness = makeStreamHarness();
    harness.start();
    await vi.advanceTimersByTimeAsync(0);

    harness.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(harness.cancels[0]).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(2_000);

    expect(harness.supervisor.invalidate).toHaveBeenCalledWith(
      1,
      "stream test.stream did not settle after cancellation",
    );
    expect(harness.runtime.runCallback).toHaveBeenCalledTimes(1);
    harness.transport.dispose();
  });

  it("restarts a domain-failed stream without replacing its healthy session", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const harness = makeStreamHarness();
    harness.start();
    await vi.advanceTimersByTimeAsync(0);

    harness.exits[0]!(Exit.fail({ _tag: "SnapshotOutOfDate" }));
    await vi.advanceTimersByTimeAsync(250);

    expect(harness.supervisor.invalidate).not.toHaveBeenCalled();
    expect(harness.runtime.runCallback).toHaveBeenCalledTimes(2);
    harness.transport.dispose();
  });

  it("restarts a normally completed stream without replacing its healthy session", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const harness = makeStreamHarness();
    harness.start();
    await vi.advanceTimersByTimeAsync(0);

    harness.exits[0]!(Exit.void);
    await vi.advanceTimersByTimeAsync(250);

    expect(harness.supervisor.invalidate).not.toHaveBeenCalled();
    expect(harness.runtime.runCallback).toHaveBeenCalledTimes(2);
    harness.transport.dispose();
  });

  it("backs off repeated stream-local failures and resets after a sustained stream", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const harness = makeStreamHarness();
    harness.start();
    await vi.advanceTimersByTimeAsync(0);

    harness.exits[0]!(Exit.fail({ _tag: "SnapshotOutOfDate" }));
    await vi.advanceTimersByTimeAsync(250);
    harness.exits[1]!(Exit.fail({ _tag: "SnapshotOutOfDate" }));
    await vi.advanceTimersByTimeAsync(499);
    expect(harness.runtime.runCallback).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(harness.runtime.runCallback).toHaveBeenCalledTimes(3);

    await vi.advanceTimersByTimeAsync(30_000);
    harness.exits[2]!(Exit.fail({ _tag: "SnapshotOutOfDate" }));
    await vi.advanceTimersByTimeAsync(249);
    expect(harness.runtime.runCallback).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(1);
    expect(harness.runtime.runCallback).toHaveBeenCalledTimes(4);
    harness.transport.dispose();
  });

  it("invalidates the session for a structured protocol stream failure", async () => {
    const harness = makeStreamHarness();
    harness.start();
    await vi.waitFor(() => expect(harness.runtime.runCallback).toHaveBeenCalledTimes(1));

    harness.exits[0]!(Exit.fail({ _tag: "ParseError" }));
    await vi.waitFor(() => expect(harness.supervisor.invalidate).toHaveBeenCalledTimes(1));

    expect(harness.supervisor.invalidate).toHaveBeenCalledWith(
      1,
      "stream test.stream protocol failed",
    );
    harness.transport.dispose();
  });

  it("invalidates the session for a genuine transport stream failure", async () => {
    const harness = makeStreamHarness();
    harness.start();
    await vi.waitFor(() => expect(harness.runtime.runCallback).toHaveBeenCalledTimes(1));

    harness.exits[0]!(Exit.fail({ _tag: "SocketCloseError", code: 1006 }));
    await vi.waitFor(() => expect(harness.supervisor.invalidate).toHaveBeenCalledTimes(1));

    expect(harness.supervisor.invalidate).toHaveBeenCalledWith(
      1,
      "stream test.stream transport failed",
    );
    harness.transport.dispose();
  });

  it("keeps the shared lifecycle stream while either lifecycle channel is active", () => {
    expect(shouldKeepServerLifecycleStream(new Set([WS_CHANNELS.serverWelcome]))).toBe(true);
    expect(shouldKeepServerLifecycleStream(new Set([WS_CHANNELS.serverMaintenanceUpdated]))).toBe(
      true,
    );
    expect(
      shouldKeepServerLifecycleStream(
        new Set([WS_CHANNELS.serverWelcome, WS_CHANNELS.serverMaintenanceUpdated]),
      ),
    ).toBe(true);
    expect(shouldKeepServerLifecycleStream(new Set([WS_CHANNELS.serverConfigUpdated]))).toBe(false);
  });

  it("normalizes explicit websocket URLs to the RPC endpoint", () => {
    const transport = new WsTransport("ws://localhost:3020");

    expect(sockets[0]?.url).toBe("ws://localhost:3020/ws");
    expect(transport.getState()).toBe("connecting");

    transport.dispose();
  });

  it("uses the desktop bridge URL before falling back to the browser location", () => {
    const getWsUrl = vi.fn().mockReturnValue("ws://127.0.0.1:53036/?token=old");
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        location: { protocol: "http:", hostname: "localhost", port: "3020" },
        desktopBridge: { getWsUrl },
      },
    });

    const transport = new WsTransport();

    expect(getWsUrl).toHaveBeenCalledTimes(1);
    expect(sockets[0]?.url).toBe("ws://127.0.0.1:53036/ws?token=old");

    transport.dispose();
  });

  it("falls back to the current browser host when no desktop bridge URL exists", () => {
    const transport = new WsTransport();

    expect(sockets[0]?.url).toBe("ws://localhost:3020/ws");

    transport.dispose();
  });

  it("notifies state listeners and replays the current state on demand", () => {
    const transport = new WsTransport();
    const listener = vi.fn();

    const unsubscribe = transport.onStateChange(listener, { replayCurrent: true });

    expect(listener).toHaveBeenCalledWith("connecting");

    listener.mockClear();
    transport.dispose();

    expect(listener).toHaveBeenCalledWith("disposed");

    listener.mockClear();
    unsubscribe();
    transport.dispose();

    expect(listener).not.toHaveBeenCalled();
  });
});
