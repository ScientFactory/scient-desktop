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
import { Cause, Data, Effect, Exit, Layer, ManagedRuntime, Scope, Stream } from "effect";
import { RpcClient, RpcSerialization } from "effect/unstable/rpc";
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
  readonly cancel: () => void;
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
  return RpcClient.layerProtocolSocket().pipe(
    Layer.provide(Layer.mergeAll(socketLayer, RpcSerialization.layerJson)),
  );
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
  private readonly wakeCleanups: Array<() => void> = [];
  private shellSubscribed = false;
  private readonly threadSubscriptions = new Map<string, unknown>();

  constructor(url?: string) {
    this.explicitUrl = url ?? null;
    this.supervisor = new ConnectionSupervisor({
      connect: () => this.createValidatedSession(),
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
    for (const cleanup of this.streamCleanups.values()) cleanup.cancel();
    this.streamCleanups.clear();
    this.supervisor.dispose();
  }

  private async createValidatedSession(): Promise<SessionHandle> {
    const runtime = ManagedRuntime.make(makeProtocolLayer(makeSocketUrl(this.explicitUrl)));
    const clientScope = runtime.runSync(Scope.make());
    try {
      const client = await runtime.runPromise(Scope.provide(clientScope)(makeRpcClient));
      const session = { client, clientScope, runtime } satisfies SessionHandle;
      await this.validateSession(
        session,
        SESSION_VALIDATION_TIMEOUT_MS,
        WS_METHODS.serverGetConfig,
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
    return session.runtime.runPromise(validation);
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
            client[WS_METHODS.subscribeServerConfig]({}),
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
          );
        } else if (channel === WS_CHANNELS.serverProviderStatusesUpdated) {
          this.startStream(
            session,
            "server.providers",
            client[WS_METHODS.subscribeServerProviderStatuses]({}),
            (payload: ServerProviderStatusesUpdatedPayload) =>
              this.emit(WS_CHANNELS.serverProviderStatusesUpdated, payload),
          );
        } else if (channel === WS_CHANNELS.serverSettingsUpdated) {
          this.startStream(
            session,
            "server.settings",
            client[WS_METHODS.subscribeServerSettings]({}),
            (payload: ServerSettingsUpdatedPayload) =>
              this.emit(WS_CHANNELS.serverSettingsUpdated, payload),
          );
        } else if (channel === WS_CHANNELS.terminalEvent) {
          this.startStream(
            session,
            "terminal.events",
            client[WS_METHODS.subscribeTerminalEvents]({}),
            (event: TerminalEvent) => this.emit(WS_CHANNELS.terminalEvent, event),
          );
        } else if (channel === WS_CHANNELS.projectDevServerEvent) {
          this.startStream(
            session,
            "project.devServers",
            client[WS_METHODS.subscribeProjectDevServerEvents]({}),
            (event: ProjectDevServerEvent) => this.emit(WS_CHANNELS.projectDevServerEvent, event),
          );
        } else if (channel === WS_CHANNELS.automationEvent) {
          this.startStream(
            session,
            "automation.events",
            client[WS_METHODS.subscribeAutomationEvents]({}),
            (event: AutomationStreamEvent) => this.emit(WS_CHANNELS.automationEvent, event),
          );
        } else if (channel === ORCHESTRATION_WS_CHANNELS.domainEvent) {
          this.startStream(
            session,
            "orchestration.domain",
            client[WS_METHODS.subscribeOrchestrationDomainEvents]({}),
            (event: OrchestrationEvent) => this.emit(ORCHESTRATION_WS_CHANNELS.domainEvent, event),
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
      session.value.client[WS_METHODS.subscribeServerLifecycle]({}),
      (event: ServerLifecycleStreamEvent) => {
        if (event.type === "welcome") {
          this.emit(WS_CHANNELS.serverWelcome, event.payload);
        } else if (event.type === "maintenance") {
          this.emit(WS_CHANNELS.serverMaintenanceUpdated, event);
        }
      },
    );
  }

  private startShellStream(session: ActiveSession): void {
    this.startStream(
      session,
      "orchestration.shell",
      session.value.client[ORCHESTRATION_WS_METHODS.subscribeShell]({}),
      (event: OrchestrationShellStreamItem) =>
        this.emit(ORCHESTRATION_WS_CHANNELS.shellEvent, event),
    );
  }

  private startThreadStream(session: ActiveSession, threadId: string, input: unknown): void {
    if (this.supervisor.currentSession?.generation !== session.generation) return;
    const key = `orchestration.thread:${threadId}`;
    this.stopStream(key);
    this.startStream(
      session,
      key,
      session.value.client[ORCHESTRATION_WS_METHODS.subscribeThread](input as never),
      (event: OrchestrationThreadStreamItem) =>
        this.emit(ORCHESTRATION_WS_CHANNELS.threadEvent, event),
    );
  }

  private startStream<T>(
    session: ActiveSession,
    key: string,
    stream: unknown,
    listener: (event: T) => void,
  ): void {
    if (this.supervisor.currentSession?.generation !== session.generation) return;
    const existing = this.streamCleanups.get(key);
    if (existing?.generation === session.generation) return;
    if (existing) {
      this.streamCleanups.delete(key);
      existing.cancel();
    }
    const runnableStream = stream as Stream.Stream<T, WsTransportRpcError, never>;
    const cancel = session.value.runtime.runCallback(
      Stream.runForEach(runnableStream, (event) =>
        Effect.sync(() => {
          if (this.supervisor.currentSession?.generation !== session.generation) return;
          listener(event);
        }),
      ),
      {
        onExit: (exit) => {
          // A replacement or intentional stop removes this exact cleanup from
          // the map before cancellation. Ignore that stale stream's later exit;
          // otherwise it can reconnect over the replacement and lose events.
          if (this.streamCleanups.get(key)?.cancel !== cancel || this.disposed) {
            return;
          }
          this.streamCleanups.delete(key);
          if (Exit.isFailure(exit)) {
            const interrupted = Cause.hasInterruptsOnly(exit.cause);
            if (!interrupted) {
              console.warn(
                `[scient-connection] stream ${key} failed: ${connectionErrorSummary(causeToError(exit.cause))}`,
              );
            }
            this.supervisor.invalidate(
              session.generation,
              interrupted ? `stream ${key} interrupted` : `stream ${key} failed`,
            );
          } else {
            this.supervisor.invalidate(session.generation, `stream ${key} completed`);
          }
        },
      },
    );
    this.streamCleanups.set(key, { generation: session.generation, cancel });
  }

  private stopStream(key: string): void {
    const cleanup = this.streamCleanups.get(key);
    if (!cleanup) return;
    this.streamCleanups.delete(key);
    cleanup.cancel();
  }

  private stopGenerationStreams(generation: number): void {
    for (const [key, cleanup] of this.streamCleanups) {
      if (cleanup.generation !== generation) continue;
      this.streamCleanups.delete(key);
      cleanup.cancel();
    }
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
