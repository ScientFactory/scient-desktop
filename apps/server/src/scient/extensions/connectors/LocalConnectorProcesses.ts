/**
 * Local MCP programs served to the connector proxy as Streamable HTTP. A stdio program serves one
 * client, so each `initialize` starts a process named by the session id. Responses go to their
 * POST; other messages to the oldest open POST, else the GET stream, else a bounded backlog.
 */
import { DuplexProcessId, type DuplexProcessHandle } from "@scientfactory/execution";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import { DuplexProcess } from "../../execution/LocalDuplexProcess.ts";
import type { LocalLaunchError, ResolvedLocalLaunch } from "./LocalConnectorLaunch.ts";

const LOCAL_SESSION_IDLE_MS = 30 * 60_000;
const MAX_LOCAL_SESSIONS_PER_CONNECTOR = 8;
const MAX_LOCAL_SESSIONS = 32;
const MAX_BACKLOG = 100;
/** Same bound as a proxied upstream response. */
const MAX_LINE_CHARS = 32 * 1024 * 1024;
const STDERR_TAIL_CHARS = 4_096;
const STOPPED_CODE = -32001;

export interface LocalConnectorIdentity {
  readonly connectorId: string;
  readonly displayName: string;
}

export interface LocalExchange {
  readonly method: "GET" | "POST" | "DELETE";
  /** The id this host issued at `initialize`; the proxy maps the agent's own id onto it. */
  readonly sessionId: string | undefined;
  readonly body: Uint8Array | undefined;
  readonly signal: AbortSignal;
}

export interface LocalStart {
  readonly launch: ResolvedLocalLaunch;
  /** Key values to remove from the program's error output before Scient shows it. */
  readonly hide: ReadonlyArray<string>;
}

export type LocalConnectorEvent =
  | { readonly type: "started"; readonly connectorId: string }
  /** The program answered its first request. */
  | { readonly type: "ready"; readonly connectorId: string }
  | { readonly type: "failed"; readonly connectorId: string; readonly message: string }
  | { readonly type: "stopped"; readonly connectorId: string };

interface Channel {
  readonly write: (message: string) => void;
  readonly close: () => void;
}

interface PostChannel extends Channel {
  /** Request ids still owed a response, by their JSON spelling. */
  readonly pending: Map<string, unknown>;
}

interface Session {
  readonly id: string;
  readonly identity: LocalConnectorIdentity;
  readonly scope: Scope.Closeable;
  readonly process: DuplexProcessHandle;
  readonly hide: ReadonlyArray<string>;
  readonly posts: Set<PostChannel>;
  get: Channel | undefined;
  readonly backlog: string[];
  lastActivity: number;
  initialized: boolean;
  stopping: boolean;
  stderr: string;
}

type JsonMessage = Readonly<Record<string, unknown>>;

const JsonText = Schema.fromJsonString(Schema.Unknown);
const parseJson = Schema.decodeUnknownExit(JsonText);
const toJson = Schema.encodeSync(JsonText);

const encoder = new TextEncoder();
const sseEvent = (message: string) => encoder.encode(`event: message\ndata: ${message}\n\n`);
const idKey = (id: unknown) => toJson(id);

const jsonResponse = (status: number, value: unknown, headers: Record<string, string> = {}) =>
  new Response(toJson(value), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });

const rpcError = (id: unknown, message: string) => ({
  jsonrpc: "2.0",
  id: id ?? null,
  error: { code: STOPPED_CODE, message },
});

const isMessage = (value: unknown): value is JsonMessage =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isResponse = (message: JsonMessage) =>
  "id" in message && !("method" in message) && ("result" in message || "error" in message);

/** Lines that are not JSON objects (a program logging on stdout) are not messages. */
const messageOf = (line: string): JsonMessage | undefined => {
  const parsed = parseJson(line);
  return Exit.isSuccess(parsed) && isMessage(parsed.value) ? parsed.value : undefined;
};

const lastLine = (text: string) =>
  text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .findLast((line) => line.length > 0)
    ?.slice(0, 300);

const hidden = (text: string, hide: ReadonlyArray<string>) =>
  hide.reduce((current, secret) => current.replaceAll(secret, "[hidden]"), text);

const channelStream = (
  onCancel: () => void,
): { readonly stream: ReadableStream<Uint8Array>; readonly channel: Channel } => {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  let closed = false;
  const stream = new ReadableStream<Uint8Array>({
    start(created) {
      controller = created;
    },
    cancel() {
      closed = true;
      onCancel();
    },
  });
  return {
    stream,
    channel: {
      write: (message) => {
        if (!closed) controller.enqueue(sseEvent(message));
      },
      close: () => {
        if (closed) return;
        closed = true;
        controller.close();
      },
    },
  };
};

export const makeLocalConnectorHost = Effect.fn("LocalConnectorHost.make")(function* (options: {
  readonly onEvent: (event: LocalConnectorEvent) => Effect.Effect<void>;
}) {
  const duplex = yield* DuplexProcess;
  const clock = yield* Clock.Clock;
  const now = () => clock.currentTimeMillisUnsafe();
  const sessions = new Map<string, Session>();
  /** Bumped by `stop`, so a start that was still preparing when it ran does not register. */
  const generations = new Map<string, number>();
  let sequence = 0;

  /** Returns true when this is the program's first answer. */
  const route = (session: Session, message: JsonMessage): boolean => {
    const text = toJson(message);
    if (isResponse(message)) {
      const key = idKey(message.id);
      for (const post of session.posts) {
        if (!post.pending.has(key)) continue;
        post.write(text);
        post.pending.delete(key);
        if (post.pending.size === 0) {
          post.close();
          session.posts.delete(post);
        }
        session.lastActivity = now();
        if (session.initialized) return false;
        session.initialized = true;
        return true;
      }
      return false;
    }
    const target = session.posts.values().next().value ?? session.get;
    if (target !== undefined) target.write(text);
    else {
      session.backlog.push(text);
      if (session.backlog.length > MAX_BACKLOG) session.backlog.shift();
    }
    return false;
  };

  /** Owed responses become errors so no agent waits on a program that is gone. */
  const settle = (session: Session, message: string) => {
    for (const post of session.posts) {
      for (const id of post.pending.values()) post.write(toJson(rpcError(id, message)));
      post.close();
    }
    session.posts.clear();
    session.get?.close();
    session.get = undefined;
  };

  const stopSession = Effect.fn("LocalConnectorHost.stopSession")(function* (
    session: Session,
    message: string,
  ) {
    if (session.stopping) return;
    session.stopping = true;
    sessions.delete(session.id);
    settle(session, message);
    yield* Scope.close(session.scope, Exit.void);
    yield* options.onEvent({ type: "stopped", connectorId: session.identity.connectorId });
  });

  const exited = Effect.fn("LocalConnectorHost.exited")(function* (session: Session, code: number) {
    if (session.stopping) return;
    const detail = lastLine(hidden(session.stderr, session.hide));
    const reason = detail ? `: ${detail}` : ` (exit code ${code})`;
    const message = session.initialized
      ? `${session.identity.displayName} stopped${reason}.`
      : `${session.identity.displayName} could not start${reason}.`;
    // Recorded first, so the failure is visible by the time a waiting agent hears of it.
    yield* options.onEvent({ type: "failed", connectorId: session.identity.connectorId, message });
    yield* stopSession(session, message);
  });

  const readStdout = Effect.fn("LocalConnectorHost.readStdout")(function* (session: Session) {
    let buffer = "";
    const lines = Effect.fnUntraced(function* (chunk: string) {
      buffer += chunk;
      let ready = false;
      let newline = buffer.indexOf("\n");
      while (newline !== -1) {
        const message = messageOf(buffer.slice(0, newline).trim());
        buffer = buffer.slice(newline + 1);
        if (message !== undefined && route(session, message)) ready = true;
        newline = buffer.indexOf("\n");
      }
      if (buffer.length > MAX_LINE_CHARS) {
        // Stopping closes this reader's own scope, so it runs outside it.
        yield* stopSession(
          session,
          `${session.identity.displayName} sent a message larger than 32 MB.`,
        ).pipe(Effect.forkDetach);
        return;
      }
      if (ready)
        yield* options.onEvent({ type: "ready", connectorId: session.identity.connectorId });
    });
    yield* session.process.stdout.pipe(
      Stream.decodeText(),
      Stream.runForEach(lines),
      Effect.ignore,
    );
  });

  const readStderr = (session: Session) =>
    session.process.stderr.pipe(
      Stream.decodeText(),
      Stream.runForEach((chunk) =>
        Effect.sync(() => {
          session.stderr = (session.stderr + chunk).slice(-STDERR_TAIL_CHARS);
        }),
      ),
      Effect.ignore,
    );

  const countFor = (connectorId: string) =>
    [...sessions.values()].filter((session) => session.identity.connectorId === connectorId).length;

  /** Frees a slot by stopping the least recently used session with nothing in flight. */
  const makeRoom = Effect.fn("LocalConnectorHost.makeRoom")(function* (connectorId: string) {
    const all = [...sessions.values()];
    const limits = [
      [
        all.filter((session) => session.identity.connectorId === connectorId),
        MAX_LOCAL_SESSIONS_PER_CONNECTOR,
      ],
      [all, MAX_LOCAL_SESSIONS],
    ] as const;
    for (const [candidates, limit] of limits) {
      if (candidates.length < limit) continue;
      const evict = candidates
        .filter((session) => !session.stopping && session.posts.size === 0)
        .toSorted((a, b) => a.lastActivity - b.lastActivity)[0];
      if (evict === undefined) return false;
      yield* stopSession(evict, "Stopped to make room for another chat.");
    }
    return true;
  });

  const startSession = Effect.fn("LocalConnectorHost.startSession")(function* (
    identity: LocalConnectorIdentity,
    start: Effect.Effect<LocalStart, LocalLaunchError>,
  ) {
    const generation = generations.get(identity.connectorId) ?? 0;
    const prepared = yield* start;
    const scope = yield* Scope.make();
    const id = `local-${++sequence}-${now().toString(36)}`;
    const process = yield* duplex
      .start({
        processId: DuplexProcessId.make(id),
        executable: prepared.launch.executable,
        args: prepared.launch.args,
        cwd: prepared.launch.cwd,
        environment: prepared.launch.environment,
        extendEnv: false,
        shell: prepared.launch.shell,
      })
      .pipe(
        Scope.provide(scope),
        Effect.onError(() => Scope.close(scope, Exit.void)),
        Effect.mapError(() => ({
          message: `${identity.displayName} could not start: ${prepared.launch.executable} did not run.`,
        })),
      );
    if ((generations.get(identity.connectorId) ?? 0) !== generation) {
      yield* Scope.close(scope, Exit.void);
      return yield* Effect.fail({
        message: `${identity.displayName} was stopped while it was starting. Retry to start it again.`,
      });
    }
    const session: Session = {
      id,
      identity,
      scope,
      process,
      hide: prepared.hide.filter((secret) => secret.length > 0),
      posts: new Set(),
      get: undefined,
      backlog: [],
      lastActivity: now(),
      initialized: false,
      stopping: false,
      stderr: "",
    };
    sessions.set(id, session);
    yield* readStdout(session).pipe(Effect.forkIn(scope));
    yield* readStderr(session).pipe(Effect.forkIn(scope));
    // Detached: a crash stops the session, which closes its scope.
    yield* process.exitCode.pipe(
      Effect.orElseSucceed(() => -1),
      Effect.flatMap((code) => exited(session, code)),
      Effect.forkDetach,
    );
    yield* options.onEvent({ type: "started", connectorId: identity.connectorId });
    return session;
  });

  const write = (session: Session, messages: ReadonlyArray<JsonMessage>) =>
    Effect.forEach(
      messages,
      (message) => session.process.write(encoder.encode(`${toJson(message)}\n`)),
      { discard: true },
    );

  const post = Effect.fn("LocalConnectorHost.post")(function* (
    identity: LocalConnectorIdentity,
    request: LocalExchange,
    start: Effect.Effect<LocalStart, LocalLaunchError>,
  ) {
    const parsed = parseJson(new TextDecoder().decode(request.body ?? new Uint8Array()));
    if (Exit.isFailure(parsed)) return jsonResponse(400, { error: "The request is not JSON." });
    const messages = Array.isArray(parsed.value) ? parsed.value : [parsed.value];
    if (!messages.every(isMessage)) return jsonResponse(400, { error: "Not a JSON-RPC message." });
    const requests = messages.filter((message) => "method" in message && "id" in message);
    const initialize = requests.find((message) => message.method === "initialize");

    let session: Session | undefined;
    let issued = false;
    if (request.sessionId === undefined) {
      if (initialize === undefined) {
        return jsonResponse(400, { error: "Start a session with initialize first." });
      }
      if (!(yield* makeRoom(identity.connectorId))) {
        return jsonResponse(
          200,
          rpcError(
            initialize.id,
            `Too many copies of ${identity.displayName} are running. Close other chats that use it, or restart it in Scient Settings → Extensions.`,
          ),
        );
      }
      const generation = generations.get(identity.connectorId) ?? 0;
      const started = yield* startSession(identity, start).pipe(Effect.result);
      if (started._tag === "Failure") {
        const message = started.failure.message;
        // A stop the user asked for while it started is not the program's failure.
        if ((generations.get(identity.connectorId) ?? 0) === generation) {
          yield* options.onEvent({ type: "failed", connectorId: identity.connectorId, message });
        }
        return jsonResponse(200, rpcError(initialize.id, message));
      }
      session = started.success;
      issued = true;
    } else {
      session = sessions.get(request.sessionId);
      if (session === undefined || session.identity.connectorId !== identity.connectorId) {
        return jsonResponse(404, { error: "Session not found." });
      }
    }
    const owner = session;
    owner.lastActivity = now();
    const headers: Record<string, string> = issued ? { "mcp-session-id": owner.id } : {};
    if (requests.length === 0) {
      yield* write(owner, messages).pipe(Effect.ignore);
      return new Response(null, { status: 202, headers });
    }
    const pending = new Map(requests.map((message) => [idKey(message.id), message.id]));
    let channel: PostChannel | undefined;
    const { stream, channel: base } = channelStream(() => {
      if (channel !== undefined) owner.posts.delete(channel);
    });
    channel = { ...base, pending };
    const registered = channel;
    // Registered before writing, so a fast response always finds its stream.
    owner.posts.add(registered);
    for (const waiting of owner.backlog.splice(0)) registered.write(waiting);
    request.signal.addEventListener("abort", () => {
      owner.posts.delete(registered);
      registered.close();
    });
    const written = yield* write(owner, messages).pipe(Effect.exit);
    if (Exit.isFailure(written)) {
      yield* stopSession(owner, `${identity.displayName} stopped before it could answer.`);
    }
    return new Response(stream, {
      status: 200,
      headers: { ...headers, "content-type": "text/event-stream" },
    });
  });

  const exchange = Effect.fn("LocalConnectorHost.exchange")(function* (
    identity: LocalConnectorIdentity,
    request: LocalExchange,
    start: Effect.Effect<LocalStart, LocalLaunchError>,
  ) {
    if (request.method === "POST") return yield* post(identity, request, start);
    const session = request.sessionId === undefined ? undefined : sessions.get(request.sessionId);
    if (session === undefined || session.identity.connectorId !== identity.connectorId) {
      return request.method === "GET"
        ? new Response(null, { status: 405 })
        : jsonResponse(404, { error: "Session not found." });
    }
    if (request.method === "DELETE") {
      yield* stopSession(session, `${identity.displayName} was closed.`);
      return new Response(null, { status: 204 });
    }
    session.get?.close();
    let channel: Channel | undefined;
    const opened = channelStream(() => {
      if (session.get === channel) session.get = undefined;
    });
    channel = opened.channel;
    const current = channel;
    session.get = current;
    for (const waiting of session.backlog.splice(0)) current.write(waiting);
    request.signal.addEventListener("abort", () => {
      if (session.get === current) session.get = undefined;
      current.close();
    });
    return new Response(opened.stream, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
  });

  const stop = Effect.fn("LocalConnectorHost.stop")(function* (
    connectorId: string,
    reason: string,
  ) {
    generations.set(connectorId, (generations.get(connectorId) ?? 0) + 1);
    for (const session of sessions.values()) {
      if (session.identity.connectorId === connectorId) yield* stopSession(session, reason);
    }
  });

  /** Stops sessions with no request in flight and no traffic for the idle period. */
  const sweepIdle = Effect.gen(function* () {
    const cutoff = now() - LOCAL_SESSION_IDLE_MS;
    for (const session of sessions.values()) {
      if (session.posts.size === 0 && session.lastActivity < cutoff) {
        yield* stopSession(session, `${session.identity.displayName} stopped after being idle.`);
      }
    }
  });

  yield* Effect.addFinalizer(() =>
    Effect.forEach([...sessions.values()], (session) =>
      stopSession(session, "Scient is shutting down."),
    ),
  );

  return { exchange, stop, sweepIdle, running: countFor };
});
