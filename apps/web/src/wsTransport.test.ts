// FILE: wsTransport.test.ts
// Purpose: Verifies browser WebSocket construction around the Effect RPC transport.
// Layer: Web transport tests
// Depends on: the global WebSocket constructor shim and desktop bridge URL contract.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WS_CHANNELS, WS_METHODS } from "@synara/contracts";
import { Effect, Exit, Stream } from "effect";
import { RpcClientError } from "effect/unstable/rpc/RpcClientError";
import { SocketCloseError } from "effect/unstable/socket/Socket";

import { ConnectionSupervisor } from "./connectionSupervisor";
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

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

function socketClosedFailure() {
  return new RpcClientError({ reason: new SocketCloseError({ code: 1006 }) });
}

type RpcHarnessFailure = ReturnType<typeof socketClosedFailure>;

interface RpcHarnessInput {
  readonly generation: number;
  readonly input: unknown;
  readonly method: string;
}

function makeRpcRecoveryHarness(options: {
  readonly execute: (input: RpcHarnessInput) => Effect.Effect<unknown, RpcHarnessFailure, never>;
  readonly probe: (generation: number) => Promise<void>;
  readonly beforeConnect?: (generation: number, signal: AbortSignal) => Promise<void>;
}) {
  const attempts: RpcHarnessInput[] = [];
  const connectGenerations: number[] = [];
  const close = vi.fn();
  const probe = vi.fn((session: { readonly generation: number }) =>
    options.probe(session.generation),
  );

  const supervisor = new ConnectionSupervisor({
    connect: async (generation, signal) => {
      connectGenerations.push(generation);
      await options.beforeConnect?.(generation, signal);
      const client = new Proxy<
        Record<string, (input: unknown) => Effect.Effect<unknown, RpcHarnessFailure, never>>
      >(
        {},
        {
          get: (_target, method) => (input: unknown) => {
            const attempt = { generation, input, method: String(method) };
            attempts.push(attempt);
            return options.execute(attempt);
          },
        },
      );
      return {
        client,
        clientScope: {},
        runtime: {
          runPromise: (effect: Effect.Effect<unknown, RpcHarnessFailure, never>) =>
            Effect.runPromise(effect),
        },
      };
    },
    close,
    probe,
    retryBaseDelayMs: 0,
    retryMaxDelayMs: 0,
    retryJitterRatio: 0,
  });

  const transport = Object.assign(Object.create(WsTransport.prototype) as object, {
    disposed: false,
    explicitUrl: null,
    latestPushByChannel: new Map(),
    listeners: new Map(),
    sequence: 0,
    shellSubscribed: false,
    state: "connecting",
    stateListeners: new Set(),
    streamCleanups: new Map(),
    streamRestartTimers: new Map(),
    streamStartTokens: new Map(),
    streamTransitions: new Map(),
    supervisor,
    threadSubscriptions: new Map(),
    wakeCleanups: [],
  }) as unknown as WsTransport;

  supervisor.start();
  return { attempts, close, connectGenerations, probe, supervisor, transport };
}

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
    expect(streamRestartDelayMs(99, () => 1)).toBe(10_000);
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

describe("WsTransport RPC recovery integration", () => {
  it("replays a reviewed read once on one replacement generation", async () => {
    const failure = socketClosedFailure();
    const harness = makeRpcRecoveryHarness({
      execute: ({ generation }) =>
        generation === 1 ? Effect.fail(failure) : Effect.succeed("recovered"),
      probe: async () => Promise.reject(failure),
    });

    await expect(
      harness.transport.request(WS_METHODS.filesystemBrowse, {}, { timeoutMs: null }),
    ).resolves.toBe("recovered");

    expect(harness.connectGenerations).toEqual([1, 2]);
    expect(harness.attempts.map(({ generation }) => generation)).toEqual([1, 2]);
    expect(harness.probe).toHaveBeenCalledOnce();
    harness.transport.dispose();
  });

  it("recovers the failed generation without replaying a mutation", async () => {
    const failure = socketClosedFailure();
    const harness = makeRpcRecoveryHarness({
      execute: ({ generation, method }) =>
        generation === 1 && method === WS_METHODS.projectsWriteFile
          ? Effect.fail(failure)
          : Effect.succeed("next call recovered"),
      probe: async () => Promise.reject(failure),
    });

    await expect(
      harness.transport.request(WS_METHODS.projectsWriteFile, {}, { timeoutMs: null }),
    ).rejects.toBe(failure);

    await vi.waitFor(() => expect(harness.connectGenerations).toEqual([1, 2]));
    await expect(
      harness.transport.request(WS_METHODS.serverGetConfig, {}, { timeoutMs: null }),
    ).resolves.toBe("next call recovered");
    expect(
      harness.attempts.filter(({ method }) => method === WS_METHODS.projectsWriteFile),
    ).toEqual([{ generation: 1, input: {}, method: WS_METHODS.projectsWriteFile }]);
    expect(harness.attempts.map(({ generation }) => generation)).toEqual([1, 2]);
    expect(harness.probe).toHaveBeenCalledOnce();
    harness.transport.dispose();
  });

  it("shares one probe and one replacement generation across concurrent failed reads", async () => {
    const failure = socketClosedFailure();
    const probeGate = deferred<void>();
    const harness = makeRpcRecoveryHarness({
      execute: ({ generation, input }) =>
        generation === 1
          ? Effect.fail(failure)
          : Effect.succeed((input as { readonly requestId: string }).requestId),
      probe: () => probeGate.promise,
    });

    const left = harness.transport.request(
      WS_METHODS.filesystemBrowse,
      { requestId: "left" },
      { timeoutMs: null },
    );
    const right = harness.transport.request(
      WS_METHODS.filesystemBrowse,
      { requestId: "right" },
      { timeoutMs: null },
    );
    await vi.waitFor(() => {
      expect(harness.attempts).toHaveLength(2);
      expect(harness.probe).toHaveBeenCalledOnce();
    });

    probeGate.reject(failure);

    await expect(Promise.all([left, right])).resolves.toEqual(["left", "right"]);
    expect(harness.connectGenerations).toEqual([1, 2]);
    expect(harness.attempts.map(({ generation }) => generation)).toEqual([1, 1, 2, 2]);
    expect(harness.probe).toHaveBeenCalledOnce();
    harness.transport.dispose();
  });

  it("does not replay when the same generation passes its recovery probe", async () => {
    const failure = socketClosedFailure();
    const harness = makeRpcRecoveryHarness({
      execute: () => Effect.fail(failure),
      probe: async () => undefined,
    });

    await expect(
      harness.transport.request(WS_METHODS.gitStatus, {}, { timeoutMs: null }),
    ).rejects.toBe(failure);

    expect(harness.connectGenerations).toEqual([1]);
    expect(harness.attempts.map(({ generation }) => generation)).toEqual([1]);
    expect(harness.probe).toHaveBeenCalledOnce();
    harness.transport.dispose();
  });

  it("settles a recovering request when transport disposal cancels replacement creation", async () => {
    const failure = socketClosedFailure();
    const replacementGate = deferred<void>();
    const harness = makeRpcRecoveryHarness({
      beforeConnect: (generation) =>
        generation === 2 ? replacementGate.promise : Promise.resolve(),
      execute: () => Effect.fail(failure),
      probe: async () => Promise.reject(failure),
    });
    const request = harness.transport.request(WS_METHODS.serverGetConfig, {}, { timeoutMs: null });
    await vi.waitFor(() => expect(harness.connectGenerations).toEqual([1, 2]));

    harness.transport.dispose();

    await expect(request).rejects.toThrow("disposed");
    expect(harness.attempts.map(({ generation }) => generation)).toEqual([1]);
    replacementGate.resolve();
    await vi.waitFor(() => expect(harness.close).toHaveBeenCalledTimes(2));
  });

  it("does not execute a third time when the one allowed replay also fails", async () => {
    const firstFailure = socketClosedFailure();
    const replayFailure = socketClosedFailure();
    const harness = makeRpcRecoveryHarness({
      execute: ({ generation }) => Effect.fail(generation === 1 ? firstFailure : replayFailure),
      probe: async () => Promise.reject(firstFailure),
    });

    await expect(
      harness.transport.request(WS_METHODS.serverGetConfig, {}, { timeoutMs: null }),
    ).rejects.toBe(replayFailure);

    expect(harness.connectGenerations).toEqual([1, 2]);
    expect(harness.attempts.map(({ generation }) => generation)).toEqual([1, 2]);
    expect(harness.probe).toHaveBeenCalledOnce();
    harness.transport.dispose();
  });
});
