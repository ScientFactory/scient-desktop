/**
 * Local MCP programs served to the connector proxy as Streamable HTTP. A stdio program serves one
 * client, so each `initialize` starts a process named by the session id. Responses go to their
 * POST; other messages to the oldest open POST, else the GET stream, else a bounded backlog.
 */
import { DuplexProcessId, type DuplexProcessHandle } from "@scientfactory/execution";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import { DuplexProcess } from "../../execution/LocalDuplexProcess.ts";
import { type CredentialSet, redactText } from "./ConnectorRedaction.ts";
import type { LocalLaunchError, ResolvedLocalLaunch } from "./LocalConnectorLaunch.ts";

const LOCAL_SESSION_IDLE_MS = 30 * 60_000;
const MAX_LOCAL_SESSIONS_PER_CONNECTOR = 8;
const MAX_LOCAL_SESSIONS = 32;
const MAX_BACKLOG = 100;
/** Same bound as a proxied upstream response. */
const MAX_LINE_CHARS = 32 * 1024 * 1024;
const STDERR_TAIL_CHARS = 4_096;
const STOPPED_CODE = -32001;
/** What a connector's tool error starts with when the site ended its session. */
const SIGN_IN_EXPIRED_MARKER = "SCIENT_SIGN_IN_EXPIRED";
/** A replacement process answers the replayed handshake within this. */
const RESTART_HANDSHAKE_MS = 30_000;
/** Other calls running when a new sign-in is ready may finish within this before the swap. */
const IN_FLIGHT_GRACE_MS = 30_000;

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
  /** Its keys and session cookies, hidden from its error output before Scient shows it. */
  readonly credentials: CredentialSet;
  /** Which sign-in the program's session files came from, for a connector that signs in. */
  readonly signInGeneration?: number;
}

/**
 * A connector that signs in to a website. When a tool says the site ended its session, the host
 * holds that answer, has Scient sign in again, swaps in a fresh process inside the same agent
 * session and sends the call once more.
 */
export interface LocalSignInHandler {
  readonly expired: (
    generation: number | undefined,
  ) => Effect.Effect<
    { readonly retry: true } | { readonly retry: false; readonly message: string }
  >;
  /** What the agent reads when the call still finds the session ended after a new sign-in. */
  readonly stillExpired: Effect.Effect<string>;
}

export type LocalConnectorEvent =
  | { readonly type: "started"; readonly connectorId: string }
  /** The program answered its first request. */
  | { readonly type: "ready"; readonly connectorId: string }
  | { readonly type: "failed"; readonly connectorId: string; readonly message: string }
  | { readonly type: "stopped"; readonly connectorId: string }
  /** Error output, with the program's keys already hidden. */
  | { readonly type: "stderr"; readonly connectorId: string; readonly text: string };

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
  /** The current process's scope; a replacement process gets its own. */
  scope: Scope.Closeable;
  process: DuplexProcessHandle;
  credentials: CredentialSet;
  readonly posts: Set<PostChannel>;
  get: Channel | undefined;
  readonly backlog: string[];
  lastActivity: number;
  initialized: boolean;
  stopping: boolean;
  stderr: string;
  readonly start: Effect.Effect<LocalStart, LocalLaunchError>;
  readonly signIn: LocalSignInHandler | undefined;
  signInGeneration: number | undefined;
  /** Requests written and not answered yet, resent to a replacement process. */
  readonly inFlight: Map<string, JsonMessage>;
  /** The agent's handshake, replayed to a replacement process. */
  initialize: JsonMessage | undefined;
  initializedNote: JsonMessage | undefined;
  /** Calls already sent again after a new sign-in. */
  readonly retried: Set<string>;
  /** Calls whose "session ended" answer waits for the new sign-in. */
  readonly awaiting: Set<string>;
  /** Set while Scient signs in again: messages from the agent wait here. */
  held: JsonMessage[] | undefined;
  /** Answers Scient itself waits for (a replacement process's handshake). */
  readonly internal: Map<string, Deferred.Deferred<JsonMessage>>;
  /** Done when the current process's error output has been read to its end. */
  stderrDone: Deferred.Deferred<void>;
  /** Called once no call that reached the old process is left running. */
  drained: (() => void) | undefined;
}

type Routed =
  | { readonly type: "none" }
  | { readonly type: "ready" }
  | { readonly type: "expired"; readonly key: string; readonly again: boolean }
  | {
      readonly type: "internal";
      readonly waiter: Deferred.Deferred<JsonMessage>;
      readonly message: JsonMessage;
    };

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

const isRequest = (message: JsonMessage) => "method" in message && "id" in message;

/** A tool result whose first text starts with the session-ended marker. */
const signInExpired = (message: JsonMessage) => {
  const result = message.result;
  if (typeof result !== "object" || result === null || !("content" in result)) return false;
  const content = result.content;
  if (!Array.isArray(content)) return false;
  const first: unknown = content.find(
    (item: unknown) => typeof item === "object" && item !== null && "text" in item,
  );
  return (
    typeof first === "object" &&
    first !== null &&
    "text" in first &&
    typeof first.text === "string" &&
    first.text.trimStart().startsWith(SIGN_IN_EXPIRED_MARKER)
  );
};

const toolError = (id: unknown, text: string): JsonMessage => ({
  jsonrpc: "2.0",
  id,
  result: { isError: true, content: [{ type: "text", text }] },
});

/** Lines that are not JSON objects (a program logging on stdout) are not messages. */
const messageOf = (line: string): JsonMessage | undefined => {
  const parsed = parseJson(line);
  return Exit.isSuccess(parsed) && isMessage(parsed.value) ? parsed.value : undefined;
};

/** Lines that never say why: Node's version banner, stack frames and closing braces. */
const NOISE = /^(Node\.js v\d|at |\}|\]|\^+$|code: |requireStack: )/u;

/** The line that best says why a program stopped: the last naming an error, else the last. */
const lastLine = (text: string) => {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !NOISE.test(line));
  return (
    lines.findLast((line) => /\b(?:[A-Z]\w*)?Error\b|\berror\b/u.test(line)) ?? lines.at(-1)
  )?.slice(0, 300);
};

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
  /** How long other running calls may finish before a new sign-in swaps the process. */
  readonly inFlightGraceMs?: number;
}) {
  const duplex = yield* DuplexProcess;
  const clock = yield* Clock.Clock;
  const now = () => clock.currentTimeMillisUnsafe();
  const sessions = new Map<string, Session>();
  /** Bumped by `stop`, so a start that was still preparing when it ran does not register. */
  const generations = new Map<string, number>();
  let sequence = 0;

  /** Calls the current process has and still owes, other than those waiting on a sign-in. */
  const outstanding = (session: Session) => {
    const unsent = new Set(session.held);
    return [...session.inFlight.entries()].flatMap(([key, message]) =>
      session.awaiting.has(key) || unsent.has(message) ? [] : [message],
    );
  };

  /** Delivers one message from the program; says whether it was its first answer. */
  const route = (session: Session, message: JsonMessage): Routed => {
    if (isResponse(message)) {
      const key = idKey(message.id);
      const waiter = session.internal.get(key);
      if (waiter !== undefined) {
        session.internal.delete(key);
        return { type: "internal", waiter, message };
      }
      const request = session.inFlight.get(key);
      if (
        request?.method === "tools/call" &&
        session.signIn !== undefined &&
        signInExpired(message)
      ) {
        return { type: "expired", key, again: session.retried.has(key) };
      }
      session.inFlight.delete(key);
      session.retried.delete(key);
      const first = deliver(session, message, key);
      if (session.drained !== undefined && outstanding(session).length === 0) {
        const drained = session.drained;
        session.drained = undefined;
        drained();
      }
      return first ? { type: "ready" } : { type: "none" };
    }
    deliver(session, message, undefined);
    return { type: "none" };
  };

  /** Returns true when this is the program's first answer. */
  const deliver = (session: Session, message: JsonMessage, key: string | undefined): boolean => {
    const text = toJson(message);
    if (key !== undefined) {
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
    // A new sign-in waiting for other calls stops waiting; it then sees the session is gone.
    const drained = session.drained;
    session.drained = undefined;
    drained?.();
    sessions.delete(session.id);
    session.inFlight.clear();
    session.held = undefined;
    settle(session, message);
    yield* Scope.close(session.scope, Exit.void);
    yield* options.onEvent({ type: "stopped", connectorId: session.identity.connectorId });
  });

  const exited = Effect.fn("LocalConnectorHost.exited")(function* (
    session: Session,
    process: DuplexProcessHandle,
    code: number,
  ) {
    // A process replaced after a new sign-in ends on purpose.
    if (session.stopping || session.process !== process) return;
    // Its last words explain the exit; they may still be in the pipe.
    yield* Deferred.await(session.stderrDone).pipe(Effect.timeout("2 seconds"), Effect.ignore);
    if (session.stopping) return;
    const detail = lastLine(redactText(session.stderr, session.credentials));
    const reason = detail ? `: ${detail}` : ` (exit code ${code})`;
    const message = session.initialized
      ? `${session.identity.displayName} stopped${reason}.`
      : `${session.identity.displayName} could not start${reason}.`;
    // Recorded first, so the failure is visible by the time a waiting agent hears of it.
    yield* options.onEvent({ type: "failed", connectorId: session.identity.connectorId, message });
    yield* stopSession(session, message);
  });

  const readStdout = Effect.fn("LocalConnectorHost.readStdout")(function* (
    session: Session,
    process: DuplexProcessHandle,
  ): Effect.fn.Return<void> {
    let buffer = "";
    const lines = Effect.fnUntraced(function* (chunk: string) {
      buffer += chunk;
      let ready = false;
      let newline = buffer.indexOf("\n");
      while (newline !== -1) {
        const message = messageOf(buffer.slice(0, newline).trim());
        buffer = buffer.slice(newline + 1);
        const routed = message === undefined ? undefined : route(session, message);
        if (routed?.type === "ready") ready = true;
        else if (routed?.type === "internal")
          yield* Deferred.succeed(routed.waiter, routed.message);
        else if (routed?.type === "expired")
          // Detached: signing in again replaces this process, which ends this reader.
          yield* expired(session, routed.key, routed.again).pipe(Effect.forkDetach);
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
    yield* process.stdout.pipe(Stream.decodeText(), Stream.runForEach(lines), Effect.ignore);
  });

  /** Whole lines go to the log, so a key split across two chunks is still hidden. */
  const readStderr = (session: Session, process: DuplexProcessHandle) => {
    let partial = "";
    const emit = (text: string) =>
      text.length === 0
        ? Effect.void
        : options.onEvent({
            type: "stderr",
            connectorId: session.identity.connectorId,
            text: redactText(text, session.credentials),
          });
    return process.stderr.pipe(
      Stream.decodeText(),
      Stream.runForEach((chunk) => {
        session.stderr = (session.stderr + chunk).slice(-STDERR_TAIL_CHARS);
        partial += chunk;
        const end = partial.lastIndexOf("\n");
        if (end === -1 && partial.length < STDERR_TAIL_CHARS) return Effect.void;
        const cut = end === -1 ? partial.length : end + 1;
        const complete = partial.slice(0, cut);
        partial = partial.slice(cut);
        return emit(complete);
      }),
      Effect.ensuring(Effect.suspend(() => emit(partial))),
      Effect.ignore,
    );
  };

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

  /** Starts the program in a scope of its own. */
  const spawn = Effect.fn("LocalConnectorHost.spawn")(function* (
    identity: LocalConnectorIdentity,
    prepared: LocalStart,
    id: string,
  ) {
    const scope = yield* Scope.make();
    const process = yield* duplex
      .start({
        processId: DuplexProcessId.make(`${id}-${++sequence}`),
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
    return { scope, process };
  });

  /** Readers live in the process's scope; the exit watch is detached and stops the session. */
  const watch = Effect.fn("LocalConnectorHost.watch")(function* (
    session: Session,
  ): Effect.fn.Return<void> {
    const { process, scope } = session;
    const stderrDone = yield* Deferred.make<void>();
    session.stderrDone = stderrDone;
    yield* readStdout(session, process).pipe(Effect.forkIn(scope));
    yield* readStderr(session, process).pipe(
      Effect.ensuring(Deferred.succeed(stderrDone, undefined)),
      Effect.forkIn(scope),
    );
    yield* process.exitCode.pipe(
      Effect.orElseSucceed(() => -1),
      Effect.flatMap((code) => exited(session, process, code)),
      Effect.forkDetach,
    );
  });

  const startSession = Effect.fn("LocalConnectorHost.startSession")(function* (
    identity: LocalConnectorIdentity,
    start: Effect.Effect<LocalStart, LocalLaunchError>,
    signIn: LocalSignInHandler | undefined,
  ) {
    const generation = generations.get(identity.connectorId) ?? 0;
    const prepared = yield* start;
    const id = `local-${++sequence}-${now().toString(36)}`;
    const { scope, process } = yield* spawn(identity, prepared, id);
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
      credentials: prepared.credentials,
      posts: new Set(),
      get: undefined,
      backlog: [],
      lastActivity: now(),
      initialized: false,
      stopping: false,
      stderr: "",
      start,
      signIn,
      signInGeneration: prepared.signInGeneration,
      inFlight: new Map(),
      initialize: undefined,
      initializedNote: undefined,
      retried: new Set(),
      awaiting: new Set(),
      held: undefined,
      internal: new Map(),
      stderrDone: yield* Deferred.make<void>(),
      drained: undefined,
    };
    sessions.set(id, session);
    yield* watch(session);
    yield* options.onEvent({ type: "started", connectorId: identity.connectorId });
    return session;
  });

  const writeTo = (process: DuplexProcessHandle, messages: ReadonlyArray<JsonMessage>) =>
    Effect.forEach(messages, (message) => process.write(encoder.encode(`${toJson(message)}\n`)), {
      discard: true,
    });

  /** Agent messages: requests are remembered until answered; while signing in they wait. */
  const write = (session: Session, messages: ReadonlyArray<JsonMessage>) => {
    for (const message of messages) {
      if (isRequest(message)) session.inFlight.set(idKey(message.id), message);
      if (message.method === "initialize") session.initialize = message;
      else if (message.method === "notifications/initialized") session.initializedNote = message;
    }
    if (session.held !== undefined) {
      session.held.push(...messages);
      return Effect.void;
    }
    return writeTo(session.process, messages);
  };

  /** Answers every call waiting on the new sign-in with `text` instead. */
  const answerAwaiting = (session: Session, text: string) => {
    for (const key of session.awaiting) {
      const request = session.inFlight.get(key);
      session.inFlight.delete(key);
      session.retried.delete(key);
      if (request !== undefined) deliver(session, toolError(request.id, text), key);
    }
    session.awaiting.clear();
  };

  /**
   * A fresh process for the session after a new sign-in: the agent's handshake is replayed
   * before anything else reaches it.
   */
  const replaceProcess = Effect.fn("LocalConnectorHost.replaceProcess")(function* (
    session: Session,
  ): Effect.fn.Return<void, { readonly message: string }> {
    const gone = { message: `${session.identity.displayName} was closed.` };
    const prepared = yield* session.start;
    if (session.stopping) return yield* Effect.fail(gone);
    const next = yield* spawn(session.identity, prepared, session.id);
    // The session stopped while this one started: it must not outlive it.
    if (session.stopping) {
      yield* Scope.close(next.scope, Exit.void);
      return yield* Effect.fail(gone);
    }
    const previous = session.scope;
    session.scope = next.scope;
    session.process = next.process;
    session.credentials = prepared.credentials;
    session.signInGeneration = prepared.signInGeneration;
    session.stderr = "";
    yield* Scope.close(previous, Exit.void);
    yield* watch(session);
    const handshake = session.initialize;
    if (handshake === undefined) return;
    const replayId = `scient-restart-${++sequence}`;
    const answered = yield* Deferred.make<JsonMessage>();
    session.internal.set(idKey(replayId), answered);
    yield* writeTo(next.process, [{ ...handshake, id: replayId }]).pipe(
      Effect.mapError(() => ({ message: `${session.identity.displayName} did not start again.` })),
    );
    yield* Deferred.await(answered).pipe(
      Effect.timeoutOrElse({
        duration: RESTART_HANDSHAKE_MS,
        orElse: () =>
          Effect.fail({ message: `${session.identity.displayName} did not start again.` }),
      }),
    );
    if (session.initializedNote !== undefined)
      yield* writeTo(next.process, [session.initializedNote]).pipe(Effect.ignore);
  });

  const expired = Effect.fn("LocalConnectorHost.expired")(function* (
    session: Session,
    key: string,
    again: boolean,
  ): Effect.fn.Return<void> {
    const signIn = session.signIn;
    const request = session.inFlight.get(key);
    if (signIn === undefined || request === undefined || session.stopping) return;
    if (again) {
      session.inFlight.delete(key);
      session.retried.delete(key);
      deliver(session, toolError(request.id, yield* signIn.stillExpired), key);
      return;
    }
    session.retried.add(key);
    session.awaiting.add(key);
    // Another call already started the new sign-in; this one is sent again with the rest.
    if (session.held !== undefined) return;
    session.held = [];
    const outcome = yield* signIn.expired(session.signInGeneration);
    if (session.stopping) return;
    const release = Effect.suspend(() => {
      const waiting = session.held ?? [];
      session.held = undefined;
      return writeTo(session.process, waiting).pipe(Effect.ignore);
    });
    if (!outcome.retry) {
      answerAwaiting(session, outcome.message);
      yield* release;
      return;
    }
    // Other calls on the old process may have done something that can't be repeated: they finish
    // first, within a bound, and are never sent again.
    if (outstanding(session).length > 0) {
      yield* Effect.promise(
        () =>
          new Promise<void>((resolve) => {
            session.drained = resolve;
          }),
      ).pipe(Effect.timeoutOption(options.inFlightGraceMs ?? IN_FLIGHT_GRACE_MS));
      session.drained = undefined;
    }
    if (session.stopping) return;
    const unknown = `${session.identity.displayName} restarted to sign in again while this call was running, so its outcome is unknown. Check whether it took effect before trying it again.`;
    for (const message of outstanding(session)) {
      const pending = idKey(message.id);
      session.inFlight.delete(pending);
      session.retried.delete(pending);
      deliver(
        session,
        message.method === "tools/call"
          ? toolError(message.id, unknown)
          : rpcError(message.id, unknown),
        pending,
      );
    }
    const replaced = yield* replaceProcess(session).pipe(Effect.result);
    if (session.stopping) return;
    if (replaced._tag === "Failure") {
      const message = `${session.identity.displayName} could not start again after signing in: ${replaced.failure.message}`;
      answerAwaiting(session, message);
      yield* stopSession(session, message);
      return;
    }
    // Only the calls that found the session ended are sent again, then what waited, in order.
    const retried = [...session.awaiting].flatMap((pending) => {
      const message = session.inFlight.get(pending);
      return message === undefined ? [] : [message];
    });
    session.awaiting.clear();
    session.held = [...retried, ...(session.held ?? [])];
    yield* release;
  });

  const post = Effect.fn("LocalConnectorHost.post")(function* (
    identity: LocalConnectorIdentity,
    request: LocalExchange,
    start: Effect.Effect<LocalStart, LocalLaunchError>,
    signIn: LocalSignInHandler | undefined,
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
      const started = yield* startSession(identity, start, signIn).pipe(Effect.result);
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
    signIn?: LocalSignInHandler,
  ) {
    if (request.method === "POST") return yield* post(identity, request, start, signIn);
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

export type LocalConnectorHost = Effect.Success<ReturnType<typeof makeLocalConnectorHost>>;
