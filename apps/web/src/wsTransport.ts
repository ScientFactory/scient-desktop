// FILE: wsTransport.ts
// Purpose: Browser-side Effect RPC transport over the Synara WebSocket endpoint.
// Layer: Web transport
// Exports: WsTransport plus stream-selection helpers used by tests.

import {
  ORCHESTRATION_WS_CHANNELS,
  ORCHESTRATION_WS_METHODS,
  WS_CHANNELS,
  WS_METHODS,
  WsRpcGroup,
  type AutomationStreamEvent,
  type GitActionProgressEvent,
  type GitRunStackedActionResult,
  type OrchestrationEvent,
  type OrchestrationShellStreamItem,
  type OrchestrationThreadStreamItem,
  type ProjectDevServerEvent,
  type ServerConfigStreamEvent,
  type ServerLifecycleStreamEvent,
  type ServerProviderStatusesUpdatedPayload,
  type ServerSettingsUpdatedPayload,
  type TerminalEvent,
  type WsPush,
  type WsPushChannel,
  type WsPushMessage,
} from "@synara/contracts";
import {
  Cause,
  Data,
  Effect,
  Exit,
  Layer,
  ManagedRuntime,
  Option,
  Schedule,
  Schema,
  Scope,
  Stream,
} from "effect";
import { RpcClient, RpcClientError, RpcSerialization } from "effect/unstable/rpc";
import * as Socket from "effect/unstable/socket/Socket";

import { ConnectionSupervisor, type ConnectionSupervisorSession } from "./connectionSupervisor";
import type { WsTransportState } from "./wsTransportEvents";

type PushListener<C extends WsPushChannel> = (message: WsPushMessage<C>) => void;

type RpcClientEffect = typeof makeRpcClient;
type RpcClientInstance =
  RpcClientEffect extends Effect.Effect<infer Client, any, any> ? Client : never;

// A client is only valid on the runtime that constructed it. Handing both out
// together keeps a request from pairing an old session's client with the next
// session's runtime when a reconnect swaps the instance fields mid-await.
type SessionHandle = {
  readonly client: RpcClientInstance;
  readonly runtime: ManagedRuntime.ManagedRuntime<RpcClient.Protocol, never>;
  readonly clientScope: Scope.Closeable;
};

type ActiveSession = ConnectionSupervisorSession<SessionHandle>;

interface StreamCleanup {
  readonly generation: number;
  readonly identity: symbol;
  readonly cancel: () => void;
  readonly settled: Promise<void>;
  readonly healthyTimer: ReturnType<typeof setTimeout>;
}

interface StreamStartToken {
  readonly generation: number;
  readonly identity: symbol;
}

interface StreamRestartTimer {
  readonly generation: number;
  readonly timer: ReturnType<typeof setTimeout>;
}

class WsTransportRpcError extends Data.TaggedError("WsTransportRpcError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

const makeRpcClient = RpcClient.make(WsRpcGroup);

// Every RPC promise must settle: React Query (and any other awaiting caller)
// can only retry or surface an error once the request rejects. The socket
// layer bounds connect (10s open timeout) and dead sockets (ping/pong), but a
// request whose response never arrives — server handler hung, response lost
// across a reconnect — would otherwise stay pending forever. `timeoutMs: null`
// opts out for known long-running calls (git actions, compaction, provider
// updates) whose duration is bounded elsewhere.
const REQUEST_TIMEOUT_MS = 60_000;
const SESSION_VALIDATION_TIMEOUT_MS = 15_000;
const WAKE_PROBE_TIMEOUT_MS = 5_000;
const STREAM_RESTART_BASE_DELAY_MS = 250;
const STREAM_RESTART_MAX_DELAY_MS = 10_000;
const STREAM_RESTART_JITTER_RATIO = 0.2;
const STREAM_RESTART_RESET_AFTER_MS = 30_000;
const STREAM_SETTLEMENT_TIMEOUT_MS = 2_000;

export const EFFECT_RPC_RETRY_CONFIG = {
  retryTransientErrors: false,
  retryCount: 0,
} as const;

export function streamRestartDelayMs(attempt: number, random = Math.random): number {
  const boundedAttempt = Math.max(0, Math.floor(attempt));
  const exponential = Math.min(
    STREAM_RESTART_BASE_DELAY_MS * 2 ** boundedAttempt,
    STREAM_RESTART_MAX_DELAY_MS,
  );
  const jitter = 1 + (random() * 2 - 1) * STREAM_RESTART_JITTER_RATIO;
  return Math.max(0, Math.round(exponential * jitter));
}

function resolveRpcUrl(rawUrl: string): string {
  const url = new URL(rawUrl);
  url.pathname = "/ws";
  return url.toString();
}

function makeSocketUrl(explicitUrl: string | null): string {
  if (explicitUrl) return resolveRpcUrl(explicitUrl);
  const bridgeUrl = window.desktopBridge?.getWsUrl();
  const envUrl = import.meta.env.VITE_WS_URL as string | undefined;
  const rawUrl =
    bridgeUrl && bridgeUrl.length > 0
      ? bridgeUrl
      : envUrl && envUrl.length > 0
        ? envUrl
        : `${window.location.protocol === "https:" ? "wss" : "ws"}://${window.location.hostname}:${window.location.port}`;
  return resolveRpcUrl(rawUrl);
}

function makeProtocolLayer(url: string) {
  const socketLayer = Socket.layerWebSocket(url).pipe(
    Layer.provide(Socket.layerWebSocketConstructorGlobal),
  );
  // JSON keeps the wire format symmetric with any server build: a serialization
  // mismatch on this single multiplexed socket is a hard connect failure, and the
  // desktop/dev setup routinely runs web and server on independently-built copies.
  const protocolLayer = Layer.effect(
    RpcClient.Protocol,
    RpcClient.makeProtocolSocket({
      retryTransientErrors: EFFECT_RPC_RETRY_CONFIG.retryTransientErrors,
      retryPolicy: Schedule.recurs(EFFECT_RPC_RETRY_CONFIG.retryCount),
    }),
  );
  return protocolLayer.pipe(Layer.provide(Layer.mergeAll(socketLayer, RpcSerialization.layerJson)));
}

function causeToError(cause: Cause.Cause<unknown>): Error {
  const error = Cause.squash(cause);
  return error instanceof Error ? error : new Error(String(error));
}

function connectionErrorSummary(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const socketCloseCode = message.match(/SocketCloseError:\s*(\d{4})/i)?.[1];
  if (socketCloseCode) return `socket closed (${socketCloseCode})`;
  if (/timed?\s*out|timeout/i.test(message)) return "connection timed out";
  if (/schema|decode|encode|protocol/i.test(message)) return "protocol validation failed";
  if (/ECONNREFUSED|connection refused|server unavailable/i.test(message)) {
    return "server unavailable";
  }
  if (/disposed|interrupt/i.test(message)) return "connection closed";
  return "connection operation failed";
}

export function isConnectionTransportFailure(error: unknown): boolean {
  const seen = new Set<object>();
  const visit = (value: unknown): boolean => {
    if (!value || typeof value !== "object") return false;
    if (seen.has(value)) return false;
    seen.add(value);
    if (Socket.isSocketError(value) || Schema.is(RpcClientError.RpcClientError)(value)) return true;
    const record = value as Record<string, unknown>;
    // A server-declared RPC failure is stream-local even when its diagnostic
    // cause resembles a transport error from the server's own dependencies.
    if (record._tag === "WsRpcError") return false;
    if (
      typeof record._tag === "string" &&
      /^(?:SocketCloseError|SocketOpenError|SocketError|RpcClientError|RpcClientDefect)$/.test(
        record._tag,
      )
    ) {
      return true;
    }
    return [record.cause, record.reason, record.error, record.failure].some(visit);
  };
  return visit(error);
}

export function isConnectionProtocolFailure(error: unknown): boolean {
  const seen = new Set<object>();
  const visit = (value: unknown): boolean => {
    if (!value || typeof value !== "object" || seen.has(value)) return false;
    seen.add(value);
    const record = value as Record<string, unknown>;
    if (
      typeof record._tag === "string" &&
      /^(?:ParseError|SchemaError|DecodeError|EncodeError|ProtocolError)$/.test(record._tag)
    ) {
      return true;
    }
    return [record.cause, record.reason, record.error, record.failure].some(visit);
  };
  return visit(error);
}

function omitNullUserInputAnswers(input: unknown): unknown {
  if (!input || typeof input !== "object") {
    return input;
  }
  const command = input as { type?: unknown; answers?: unknown };
  if (command.type !== "thread.user-input.respond" || !command.answers) {
    return input;
  }
  if (typeof command.answers !== "object") {
    return input;
  }
  return {
    ...command,
    answers: Object.fromEntries(
      Object.entries(command.answers).filter(
        ([, answer]) => answer !== null && answer !== undefined,
      ),
    ),
  };
}

export function isServerLifecyclePushChannel(channel: string): boolean {
  return channel === WS_CHANNELS.serverWelcome || channel === WS_CHANNELS.serverMaintenanceUpdated;
}

export function shouldKeepServerLifecycleStream(activeChannels: ReadonlySet<string>): boolean {
  return (
    activeChannels.has(WS_CHANNELS.serverWelcome) ||
    activeChannels.has(WS_CHANNELS.serverMaintenanceUpdated)
  );
}

export class WsTransport {
  private readonly explicitUrl: string | null;
  private readonly listeners = new Map<string, Set<(message: WsPush) => void>>();
  private readonly stateListeners = new Set<(state: WsTransportState) => void>();
  private readonly latestPushByChannel = new Map<string, WsPush>();
  private sequence = 0;
  private state: WsTransportState = "connecting";
  private disposed = false;
  private readonly supervisor: ConnectionSupervisor<SessionHandle>;
  private readonly streamCleanups = new Map<string, StreamCleanup>();
  private readonly streamStartTokens = new Map<string, StreamStartToken>();
  private readonly streamTransitions = new Map<string, Promise<void>>();
  private readonly streamRestartTimers = new Map<string, StreamRestartTimer>();
  private readonly streamRestartAttempts = new Map<
    string,
    { readonly generation: number; readonly attempt: number }
  >();
  private readonly wakeCleanups: Array<() => void> = [];
  private shellSubscribed = false;
  private readonly threadSubscriptions = new Map<string, unknown>();

  constructor(url?: string) {
    this.explicitUrl = url ?? null;
    this.supervisor = new ConnectionSupervisor({
      connect: (_generation, signal) => this.createValidatedSession(signal),
      close: ({ value }) => this.closeSession(value),
      probe: ({ value }) =>
        this.validateSession(value, WAKE_PROBE_TIMEOUT_MS, WS_METHODS.serverGetEnvironment),
      onReady: (session) => this.restoreStreams(session),
      onInvalidated: (session) => this.stopGenerationStreams(session.generation),
      onSnapshot: (snapshot) => {
        if (snapshot.phase === "ready") this.setState("open");
        else if (snapshot.phase === "reconnecting") this.setState("reconnecting");
        else if (snapshot.phase === "connecting") this.setState("connecting");
        else this.setState("disposed");
      },
      onError: (error, context) => {
        if (!this.disposed) {
          console.warn(`[scient-connection] ${context}: ${connectionErrorSummary(error)}`);
        }
      },
    });
    this.installWakeRecovery();
    this.supervisor.start();
  }

  async request<T = unknown>(
    method: string,
    params?: unknown,
    options?: { readonly timeoutMs?: number | null },
  ): Promise<T> {
    if (this.disposed) throw new Error("Transport disposed");
    const timeoutMs = options?.timeoutMs === undefined ? REQUEST_TIMEOUT_MS : options.timeoutMs;

    if (method === ORCHESTRATION_WS_METHODS.subscribeShell) {
      this.shellSubscribed = true;
      const session = await this.getSession(REQUEST_TIMEOUT_MS);
      if (!this.shellSubscribed) return undefined as T;
      this.startShellStream(session);
      return undefined as T;
    }
    if (method === ORCHESTRATION_WS_METHODS.unsubscribeShell) {
      this.shellSubscribed = false;
      this.stopStream("orchestration.shell");
      return undefined as T;
    }
    if (method === ORCHESTRATION_WS_METHODS.subscribeThread) {
      const threadId = (params as { threadId: string }).threadId;
      this.threadSubscriptions.set(threadId, params);
      const session = await this.getSession(REQUEST_TIMEOUT_MS);
      if (this.threadSubscriptions.get(threadId) !== params) return undefined as T;
      this.startThreadStream(session, threadId, params as never);
      return undefined as T;
    }
    if (method === ORCHESTRATION_WS_METHODS.unsubscribeThread) {
      const threadId = (params as { threadId: string }).threadId;
      this.threadSubscriptions.delete(threadId);
      this.stopStream(`orchestration.thread:${threadId}`);
      return undefined as T;
    }

    const session = await this.getSession(REQUEST_TIMEOUT_MS);

    if (method === WS_METHODS.gitRunStackedAction) {
      return (await this.runGitActionStream(session, params)) as T;
    }

    const rpcInput =
      method === ORCHESTRATION_WS_METHODS.dispatchCommand
        ? (params as { command: unknown }).command
        : (params ?? {});
    const normalizedRpcInput = omitNullUserInputAnswers(rpcInput);
    const call = (
      session.value.client as unknown as Record<
        string,
        (input: unknown) => Effect.Effect<unknown, WsTransportRpcError, never>
      >
    )[method];
    if (!call) throw new WsTransportRpcError({ message: `Unknown RPC method: ${method}` });
    const rpcEffect =
      timeoutMs === null
        ? call(normalizedRpcInput)
        : Effect.timeoutOrElse(call(normalizedRpcInput), {
            duration: timeoutMs,
            onTimeout: () =>
              Effect.fail(
                new WsTransportRpcError({
                  message: `RPC request timed out after ${timeoutMs}ms: ${method}`,
                }),
              ),
          });
    return (await session.value.runtime.runPromise(rpcEffect)) as T;
  }

  subscribe<C extends WsPushChannel>(
    channel: C,
    listener: PushListener<C>,
    options?: { readonly replayLatest?: boolean },
  ): () => void {
    let channelListeners = this.listeners.get(channel);
    if (!channelListeners) {
      channelListeners = new Set<(message: WsPush) => void>();
      this.listeners.set(channel, channelListeners);
      this.startChannelStream(channel);
    }

    const wrappedListener = (message: WsPush) => listener(message as WsPushMessage<C>);
    channelListeners.add(wrappedListener);

    if (options?.replayLatest) {
      const latest = this.latestPushByChannel.get(channel);
      if (latest) wrappedListener(latest);
    }

    return () => {
      channelListeners?.delete(wrappedListener);
      if (channelListeners?.size === 0) {
        this.listeners.delete(channel);
        this.stopChannelStream(channel);
      }
    };
  }

  getLatestPush<C extends WsPushChannel>(channel: C): WsPushMessage<C> | null {
    const latest = this.latestPushByChannel.get(channel);
    return latest ? (latest as WsPushMessage<C>) : null;
  }

  onStateChange(
    listener: (state: WsTransportState) => void,
    options?: { readonly replayCurrent?: boolean },
  ): () => void {
    this.stateListeners.add(listener);
    if (options?.replayCurrent) {
      listener(this.state);
    }

    return () => {
      this.stateListeners.delete(listener);
    };
  }

  getState(): WsTransportState {
    return this.state;
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    for (const cleanup of this.wakeCleanups.splice(0)) cleanup();
    for (const key of new Set([
      ...this.streamCleanups.keys(),
      ...this.streamStartTokens.keys(),
      ...this.streamRestartTimers.keys(),
    ])) {
      this.stopStream(key);
    }
    this.supervisor.dispose();
  }

  private async createValidatedSession(signal: AbortSignal): Promise<SessionHandle> {
    const runtime = ManagedRuntime.make(makeProtocolLayer(makeSocketUrl(this.explicitUrl)));
    const clientScope = runtime.runSync(Scope.make());
    try {
      const client = await runtime.runPromise(Scope.provide(clientScope)(makeRpcClient), {
        signal,
      });
      const session = { client, clientScope, runtime } satisfies SessionHandle;
      await this.validateSession(
        session,
        SESSION_VALIDATION_TIMEOUT_MS,
        WS_METHODS.serverGetConfig,
        signal,
      );
      return session;
    } catch (error) {
      await this.closeRuntime(runtime, clientScope);
      throw error;
    }
  }

  private validateSession(
    session: SessionHandle,
    timeoutMs: number,
    method: string,
    signal?: AbortSignal,
  ): Promise<void> {
    const validate = (
      session.client as unknown as Record<
        string,
        (input: unknown) => Effect.Effect<unknown, WsTransportRpcError, never>
      >
    )[method];
    if (!validate)
      return Promise.reject(new Error(`Connection validation RPC unavailable: ${method}`));
    const validation = validate({}).pipe(
      Effect.timeoutOrElse({
        duration: timeoutMs,
        onTimeout: () =>
          Effect.fail(
            new WsTransportRpcError({
              message: `Connection validation timed out after ${timeoutMs}ms: ${method}`,
            }),
          ),
      }),
      Effect.asVoid,
    );
    return session.runtime.runPromise(validation, signal ? { signal } : undefined);
  }

  private closeSession(session: SessionHandle): Promise<void> {
    return this.closeRuntime(session.runtime, session.clientScope);
  }

  private async closeRuntime(
    runtime: ManagedRuntime.ManagedRuntime<RpcClient.Protocol, never>,
    clientScope: Scope.Closeable,
  ): Promise<void> {
    try {
      await runtime.runPromise(Scope.close(clientScope, Exit.void)).catch(() => undefined);
    } finally {
      await runtime.dispose().catch(() => undefined);
    }
  }

  private getSession(timeoutMs: number): Promise<ActiveSession> {
    if (this.disposed) return Promise.reject(new Error("Transport disposed"));
    return this.supervisor.waitForSession({ timeoutMs });
  }

  private setState(state: WsTransportState): void {
    if (this.state === state) return;
    this.state = state;
    for (const listener of this.stateListeners) {
      try {
        listener(state);
      } catch {
        // Listener errors must not break reconnect or RPC state transitions.
      }
    }
  }

  private restoreStreams(session: ActiveSession): void {
    if (this.disposed || this.supervisor.currentSession?.generation !== session.generation) return;
    for (const channel of this.listeners.keys()) {
      this.startChannelStream(channel as WsPushChannel);
    }
    if (this.shellSubscribed) {
      this.startShellStream(session);
    }
    for (const [threadId, input] of this.threadSubscriptions) {
      this.startThreadStream(session, threadId, input);
    }
  }

  private installWakeRecovery(): void {
    const probe = (reason: string) => {
      void this.supervisor.probe(reason);
    };
    if (typeof window.addEventListener === "function") {
      const handleFocus = () => probe("window focus");
      window.addEventListener("focus", handleFocus);
      this.wakeCleanups.push(() => window.removeEventListener("focus", handleFocus));
    }
    if (typeof document !== "undefined" && typeof document.addEventListener === "function") {
      const handleVisibilityChange = () => {
        if (document.visibilityState === "visible") probe("document visible");
      };
      document.addEventListener("visibilitychange", handleVisibilityChange);
      this.wakeCleanups.push(() =>
        document.removeEventListener("visibilitychange", handleVisibilityChange),
      );
    }
    const onConnectionWake = window.desktopBridge?.onConnectionWake;
    if (onConnectionWake) {
      this.wakeCleanups.push(onConnectionWake((reason) => probe(`desktop ${reason}`)));
    }
  }

  private emit<C extends WsPushChannel>(channel: C, data: WsPushMessage<C>["data"]): void {
    const message = {
      type: "push" as const,
      sequence: ++this.sequence,
      channel,
      data,
    } as WsPush;
    this.latestPushByChannel.set(channel, message);
    const listeners = this.listeners.get(channel);
    if (!listeners) return;
    for (const listener of listeners) {
      try {
        listener(message);
      } catch {
        // Listener errors must not break transport streams.
      }
    }
  }

  private startChannelStream(channel: WsPushChannel): void {
    void this.supervisor
      .waitForSession()
      .then((session) => {
        if (
          this.disposed ||
          !this.listeners.has(channel) ||
          this.supervisor.currentSession?.generation !== session.generation
        ) {
          return;
        }
        const { client } = session.value;

        if (isServerLifecyclePushChannel(channel)) {
          this.startLifecycleStream(session);
        } else if (channel === WS_CHANNELS.serverConfigUpdated) {
          this.startStream(
            session,
            "server.config",
            () => client[WS_METHODS.subscribeServerConfig]({}),
            (event: ServerConfigStreamEvent) => {
              if (event.type === "snapshot") {
                this.emit(WS_CHANNELS.serverConfigUpdated, {
                  issues: event.config.issues,
                  providers: event.config.providers,
                });
              } else if (event.type === "configUpdated") {
                this.emit(WS_CHANNELS.serverConfigUpdated, event.payload);
              }
            },
            { isDesired: () => this.listeners.has(channel) },
          );
        } else if (channel === WS_CHANNELS.serverProviderStatusesUpdated) {
          this.startStream(
            session,
            "server.providers",
            () => client[WS_METHODS.subscribeServerProviderStatuses]({}),
            (payload: ServerProviderStatusesUpdatedPayload) =>
              this.emit(WS_CHANNELS.serverProviderStatusesUpdated, payload),
            { isDesired: () => this.listeners.has(channel) },
          );
        } else if (channel === WS_CHANNELS.serverSettingsUpdated) {
          this.startStream(
            session,
            "server.settings",
            () => client[WS_METHODS.subscribeServerSettings]({}),
            (payload: ServerSettingsUpdatedPayload) =>
              this.emit(WS_CHANNELS.serverSettingsUpdated, payload),
            { isDesired: () => this.listeners.has(channel) },
          );
        } else if (channel === WS_CHANNELS.terminalEvent) {
          this.startStream(
            session,
            "terminal.events",
            () => client[WS_METHODS.subscribeTerminalEvents]({}),
            (event: TerminalEvent) => this.emit(WS_CHANNELS.terminalEvent, event),
            { isDesired: () => this.listeners.has(channel) },
          );
        } else if (channel === WS_CHANNELS.projectDevServerEvent) {
          this.startStream(
            session,
            "project.devServers",
            () => client[WS_METHODS.subscribeProjectDevServerEvents]({}),
            (event: ProjectDevServerEvent) => this.emit(WS_CHANNELS.projectDevServerEvent, event),
            { isDesired: () => this.listeners.has(channel) },
          );
        } else if (channel === WS_CHANNELS.automationEvent) {
          this.startStream(
            session,
            "automation.events",
            () => client[WS_METHODS.subscribeAutomationEvents]({}),
            (event: AutomationStreamEvent) => this.emit(WS_CHANNELS.automationEvent, event),
            { isDesired: () => this.listeners.has(channel) },
          );
        } else if (channel === ORCHESTRATION_WS_CHANNELS.domainEvent) {
          this.startStream(
            session,
            "orchestration.domain",
            () => client[WS_METHODS.subscribeOrchestrationDomainEvents]({}),
            (event: OrchestrationEvent) => this.emit(ORCHESTRATION_WS_CHANNELS.domainEvent, event),
            { isDesired: () => this.listeners.has(channel) },
          );
        }
      })
      .catch((error) => {
        if (!this.disposed && this.listeners.has(channel)) {
          console.warn(
            `[scient-connection] channel ${channel} failed to start: ${connectionErrorSummary(error)}`,
          );
        }
      });
  }

  private stopChannelStream(channel: WsPushChannel): void {
    if (isServerLifecyclePushChannel(channel)) {
      if (!this.shouldKeepLifecycleStream()) this.stopStream("server.lifecycle");
    } else if (channel === WS_CHANNELS.serverConfigUpdated) this.stopStream("server.config");
    else if (channel === WS_CHANNELS.serverProviderStatusesUpdated)
      this.stopStream("server.providers");
    else if (channel === WS_CHANNELS.serverSettingsUpdated) this.stopStream("server.settings");
    else if (channel === WS_CHANNELS.terminalEvent) this.stopStream("terminal.events");
    else if (channel === WS_CHANNELS.projectDevServerEvent) this.stopStream("project.devServers");
    else if (channel === WS_CHANNELS.automationEvent) this.stopStream("automation.events");
    else if (channel === ORCHESTRATION_WS_CHANNELS.domainEvent)
      this.stopStream("orchestration.domain");
  }

  private shouldKeepLifecycleStream(): boolean {
    return shouldKeepServerLifecycleStream(new Set(this.listeners.keys()));
  }

  private startLifecycleStream(session: ActiveSession): void {
    this.startStream(
      session,
      "server.lifecycle",
      () => session.value.client[WS_METHODS.subscribeServerLifecycle]({}),
      (event: ServerLifecycleStreamEvent) => {
        if (event.type === "welcome") {
          this.emit(WS_CHANNELS.serverWelcome, event.payload);
        } else if (event.type === "maintenance") {
          this.emit(WS_CHANNELS.serverMaintenanceUpdated, event);
        }
      },
      { isDesired: () => this.shouldKeepLifecycleStream() },
    );
  }

  private startShellStream(session: ActiveSession): void {
    this.startStream(
      session,
      "orchestration.shell",
      () => session.value.client[ORCHESTRATION_WS_METHODS.subscribeShell]({}),
      (event: OrchestrationShellStreamItem) =>
        this.emit(ORCHESTRATION_WS_CHANNELS.shellEvent, event),
      { isDesired: () => this.shellSubscribed },
    );
  }

  private startThreadStream(session: ActiveSession, threadId: string, input: unknown): void {
    if (this.supervisor.currentSession?.generation !== session.generation) return;
    const key = `orchestration.thread:${threadId}`;
    this.startStream(
      session,
      key,
      () => session.value.client[ORCHESTRATION_WS_METHODS.subscribeThread](input as never),
      (event: OrchestrationThreadStreamItem) =>
        this.emit(ORCHESTRATION_WS_CHANNELS.threadEvent, event),
      {
        isDesired: () => this.threadSubscriptions.get(threadId) === input,
        replace: true,
      },
    );
  }

  private startStream<T>(
    session: ActiveSession,
    key: string,
    streamFactory: () => unknown,
    listener: (event: T) => void,
    options: {
      readonly isDesired: () => boolean;
      readonly replace?: boolean;
    },
  ): void {
    if (this.supervisor.currentSession?.generation !== session.generation) return;
    const existing = this.streamCleanups.get(key);
    const pending = this.streamStartTokens.get(key);
    if (
      !options.replace &&
      (existing?.generation === session.generation || pending?.generation === session.generation)
    ) {
      return;
    }
    this.clearStreamRestartTimer(key);
    const identity = Symbol(key);
    this.streamStartTokens.set(key, { generation: session.generation, identity });
    const previous = this.streamTransitions.get(key) ?? Promise.resolve();
    const transition = previous
      .catch(() => undefined)
      .then(() => this.replaceStream(session, key, identity, streamFactory, listener, options))
      .finally(() => {
        if (this.streamTransitions.get(key) === transition) {
          this.streamTransitions.delete(key);
        }
      });
    this.streamTransitions.set(key, transition);
  }

  private async replaceStream<T>(
    session: ActiveSession,
    key: string,
    identity: symbol,
    streamFactory: () => unknown,
    listener: (event: T) => void,
    options: {
      readonly isDesired: () => boolean;
      readonly replace?: boolean;
    },
  ): Promise<void> {
    if (this.streamStartTokens.get(key)?.identity !== identity) return;
    const existing = this.streamCleanups.get(key);
    if (existing) {
      this.streamCleanups.delete(key);
      clearTimeout(existing.healthyTimer);
      existing.cancel();
      const settled = await this.waitForStreamSettlement(existing.settled);
      if (!settled) {
        if (this.streamStartTokens.get(key)?.identity === identity) {
          this.streamStartTokens.delete(key);
        }
        this.supervisor.invalidate(
          existing.generation,
          `stream ${key} did not settle after cancellation`,
        );
        return;
      }
    }
    if (
      this.disposed ||
      this.streamStartTokens.get(key)?.identity !== identity ||
      this.supervisor.currentSession?.generation !== session.generation ||
      !options.isDesired()
    ) {
      if (this.streamStartTokens.get(key)?.identity === identity) {
        this.streamStartTokens.delete(key);
      }
      return;
    }

    let resolveSettled!: () => void;
    const settled = new Promise<void>((resolve) => {
      resolveSettled = resolve;
    });
    let cleanup!: StreamCleanup;
    try {
      const runnableStream = streamFactory() as Stream.Stream<T, WsTransportRpcError, never>;
      const cancel = session.value.runtime.runCallback(
        Stream.runForEach(runnableStream, (event) =>
          Effect.sync(() => {
            if (
              this.supervisor.currentSession?.generation !== session.generation ||
              this.streamCleanups.get(key) !== cleanup
            ) {
              return;
            }
            listener(event);
          }),
        ),
        {
          onExit: (exit) => {
            resolveSettled();
            queueMicrotask(() => {
              this.handleStreamExit(session, key, cleanup, exit, streamFactory, listener, options);
            });
          },
        },
      );
      const healthyTimer = setTimeout(() => {
        if (this.streamCleanups.get(key) === cleanup) {
          this.streamRestartAttempts.delete(key);
        }
      }, STREAM_RESTART_RESET_AFTER_MS);
      cleanup = { generation: session.generation, identity, cancel, settled, healthyTimer };
      this.streamCleanups.set(key, cleanup);
      if (this.streamStartTokens.get(key)?.identity === identity) {
        this.streamStartTokens.delete(key);
      }
    } catch (error) {
      resolveSettled();
      if (this.streamStartTokens.get(key)?.identity === identity) {
        this.streamStartTokens.delete(key);
      }
      this.handleStreamFailure(session, key, error, streamFactory, listener, options);
    }
  }

  private handleStreamExit<T>(
    session: ActiveSession,
    key: string,
    cleanup: StreamCleanup,
    exit: Exit.Exit<void, WsTransportRpcError>,
    streamFactory: () => unknown,
    listener: (event: T) => void,
    options: {
      readonly isDesired: () => boolean;
      readonly replace?: boolean;
    },
  ): void {
    if (this.streamCleanups.get(key) !== cleanup || this.disposed) return;
    this.streamCleanups.delete(key);
    clearTimeout(cleanup.healthyTimer);
    if (Exit.isFailure(exit)) {
      const error = causeToError(exit.cause);
      const failure = Cause.findErrorOption(exit.cause);
      if (
        (Option.isSome(failure) && isConnectionTransportFailure(failure.value)) ||
        isConnectionTransportFailure(error)
      ) {
        this.supervisor.invalidate(session.generation, `stream ${key} transport failed`);
        return;
      }
      if (
        (Option.isSome(failure) && isConnectionProtocolFailure(failure.value)) ||
        isConnectionProtocolFailure(error)
      ) {
        this.supervisor.invalidate(session.generation, `stream ${key} protocol failed`);
        return;
      }
      if (!Cause.hasInterruptsOnly(exit.cause)) {
        console.warn(
          `[scient-connection] stream ${key} failed without closing the session: ${connectionErrorSummary(error)}`,
        );
      }
    }
    this.scheduleStreamRestart(session, key, streamFactory, listener, options);
  }

  private handleStreamFailure<T>(
    session: ActiveSession,
    key: string,
    error: unknown,
    streamFactory: () => unknown,
    listener: (event: T) => void,
    options: {
      readonly isDesired: () => boolean;
      readonly replace?: boolean;
    },
  ): void {
    if (isConnectionTransportFailure(error)) {
      this.supervisor.invalidate(session.generation, `stream ${key} transport failed to start`);
      return;
    }
    if (isConnectionProtocolFailure(error)) {
      this.supervisor.invalidate(session.generation, `stream ${key} protocol failed to start`);
      return;
    }
    console.warn(
      `[scient-connection] stream ${key} failed to start without closing the session: ${connectionErrorSummary(error)}`,
    );
    this.scheduleStreamRestart(session, key, streamFactory, listener, options);
  }

  private scheduleStreamRestart<T>(
    session: ActiveSession,
    key: string,
    streamFactory: () => unknown,
    listener: (event: T) => void,
    options: {
      readonly isDesired: () => boolean;
      readonly replace?: boolean;
    },
  ): void {
    if (
      this.disposed ||
      this.supervisor.currentSession?.generation !== session.generation ||
      !options.isDesired()
    ) {
      return;
    }
    this.clearStreamRestartTimer(key);
    const previousAttempt = this.streamRestartAttempts.get(key);
    const attempt =
      previousAttempt?.generation === session.generation ? previousAttempt.attempt + 1 : 0;
    this.streamRestartAttempts.set(key, { generation: session.generation, attempt });
    const delayMs = streamRestartDelayMs(attempt);
    const timer = setTimeout(() => {
      if (this.streamRestartTimers.get(key)?.timer !== timer) return;
      this.streamRestartTimers.delete(key);
      if (
        this.disposed ||
        this.supervisor.currentSession?.generation !== session.generation ||
        !options.isDesired()
      ) {
        return;
      }
      this.startStream(session, key, streamFactory, listener, options);
    }, delayMs);
    this.streamRestartTimers.set(key, { generation: session.generation, timer });
  }

  private stopStream(key: string): void {
    this.streamStartTokens.delete(key);
    this.clearStreamRestartTimer(key);
    this.streamRestartAttempts.delete(key);
    const previous = this.streamTransitions.get(key) ?? Promise.resolve();
    const transition = previous
      .catch(() => undefined)
      .then(async () => {
        const cleanup = this.streamCleanups.get(key);
        if (!cleanup) return;
        this.streamCleanups.delete(key);
        clearTimeout(cleanup.healthyTimer);
        cleanup.cancel();
        const settled = await this.waitForStreamSettlement(cleanup.settled);
        if (!settled) {
          this.supervisor.invalidate(
            cleanup.generation,
            `stream ${key} did not settle after cancellation`,
          );
        }
      })
      .finally(() => {
        if (this.streamTransitions.get(key) === transition) {
          this.streamTransitions.delete(key);
        }
      });
    this.streamTransitions.set(key, transition);
  }

  private async waitForStreamSettlement(settled: Promise<void>): Promise<boolean> {
    let timeout: ReturnType<typeof setTimeout> | null = null;
    try {
      return await Promise.race([
        settled.then(() => true),
        new Promise<boolean>((resolve) => {
          timeout = setTimeout(() => resolve(false), STREAM_SETTLEMENT_TIMEOUT_MS);
        }),
      ]);
    } finally {
      if (timeout !== null) clearTimeout(timeout);
    }
  }

  private clearStreamRestartTimer(key: string): void {
    const restart = this.streamRestartTimers.get(key);
    if (!restart) return;
    clearTimeout(restart.timer);
    this.streamRestartTimers.delete(key);
  }

  private stopGenerationStreams(generation: number): void {
    const keys = new Set<string>();
    for (const [key, cleanup] of this.streamCleanups) {
      if (cleanup.generation === generation) keys.add(key);
    }
    for (const [key, pending] of this.streamStartTokens) {
      if (pending.generation === generation) keys.add(key);
    }
    for (const [key, restart] of this.streamRestartTimers) {
      if (restart.generation === generation) keys.add(key);
    }
    for (const key of keys) this.stopStream(key);
  }

  private async runGitActionStream(
    session: ActiveSession,
    params: unknown,
  ): Promise<GitRunStackedActionResult> {
    let result: GitRunStackedActionResult | null = null;
    await session.value.runtime.runPromise(
      Stream.runForEach(
        session.value.client[WS_METHODS.gitRunStackedAction](params as never),
        (event) =>
          Effect.sync(() => {
            if (this.supervisor.currentSession?.generation !== session.generation) return;
            this.emit(WS_CHANNELS.gitActionProgress, event as GitActionProgressEvent);
            if ((event as GitActionProgressEvent).kind === "action_finished") {
              result = (event as Extract<GitActionProgressEvent, { kind: "action_finished" }>)
                .result;
            }
          }),
      ),
    );
    if (!result) throw new Error("Git action stream completed without a final result.");
    return result;
  }
}
