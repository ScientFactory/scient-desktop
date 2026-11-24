import {
  NonNegativeInt,
  ThreadMcpStatusSnapshot,
  type IsoDateTime,
  type ProviderInstanceId,
  type ProviderSessionId,
  type ProviderThreadId,
  type ThreadId,
  type ThreadMcpServerActionKind,
  type ThreadMcpServerObservation,
  type ThreadMcpServerSource,
  type ThreadMcpServerStatusKind,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

/** Bounded thread retention so idle history cannot grow server memory without bound. */
const MAX_RETAINED_THREADS = 1_024;
const MAX_SERVERS_PER_THREAD = 256;
/** The longest name an MCP sign-in accepts; longer ones are not shown. */
const MAX_SERVER_NAME_LENGTH = 256;
const MAX_DISPLAY_LENGTH = 200;
const fitsRow = (server: NativeMcpServerInput) =>
  server.name.trim().length > 0 && server.name.length <= MAX_SERVER_NAME_LENGTH;
const MAX_DETAIL_LENGTH = 240;

const sameSnapshot = Schema.toEquivalence(ThreadMcpStatusSnapshot);

/**
 * Bounded, single-line Scient-authored text (a connector's own status message). Provider error
 * text never reaches this: it can carry keys, cookies or command lines.
 */
export const sanitizeMcpStatusDetail = (raw: string | null | undefined): string | undefined => {
  if (raw == null) return undefined;
  const text = raw
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\bBearer\s+[A-Za-z0-9_~+/=.-]+/gi, "Bearer [redacted]")
    .replace(/https?:\/\/\S+/gi, "[url]");
  if (text.length === 0) return undefined;
  return text.length > MAX_DETAIL_LENGTH ? `${text.slice(0, MAX_DETAIL_LENGTH - 1)}…` : text;
};

/** Why a native server failed, in Scient's words; the provider's own text stays in its logs. */
export const nativeMcpFailureReason = (raw: string | null | undefined): string => {
  const text = raw ?? "";
  if (/\b(?:ENOENT|EACCES|spawn|No such file|command not found)\b/i.test(text)) {
    return "Its program could not be started.";
  }
  if (/\b(?:ECONNREFUSED|ENOTFOUND|EHOSTUNREACH|getaddrinfo|connection refused)\b/i.test(text)) {
    return "It could not be reached.";
  }
  if (/\btimed? ?out\b|\btimeout\b/i.test(text)) return "It did not answer in time.";
  if (/\bhandshak/i.test(text)) return "It did not complete the MCP handshake.";
  return "It failed to start.";
};

export interface NativeMcpServerInput {
  readonly name: string;
  readonly source: Exclude<ThreadMcpServerSource, "managed">;
  readonly status: ThreadMcpServerStatusKind;
  /** Scient-authored copy only; see `nativeMcpFailureReason`. */
  readonly detail?: string | undefined;
  readonly action?: ThreadMcpServerActionKind | undefined;
}

/** Optional host-managed MCP status provider (e.g. Scient Extensions) mounted without coupling. */
export interface ManagedThreadMcpSource {
  readonly snapshot: (input: {
    readonly threadId: ThreadId;
    readonly sessionActive: boolean;
  }) => Effect.Effect<ReadonlyArray<ThreadMcpServerObservation>>;
  /** Emits a ThreadId when one thread changed, or null when any thread may have changed. */
  readonly changes: Stream.Stream<ThreadId | null>;
}

/**
 * The agent asked for one of its own servers' sign-in. `shown`: a Sign in row is in the chat.
 * `not-available`: off or failed. `card`: no row possible, only the thread's MCP status.
 * `inactive`: its session ended. `none`: no such server.
 */
export type McpSignInRequestOutcome =
  | {
      readonly _tag:
        | "shown"
        | "signed-in"
        | "not-available"
        | "card"
        | "checking"
        | "claudeai"
        | "inactive";
      readonly displayName: string;
    }
  | { readonly _tag: "none" };

/** A live session's answer to a sign-in request for one of its servers, from a fresh read. */
export type McpSignInShowResult =
  | "shown"
  | "signed-in"
  | "checking"
  | "not-available"
  | "unavailable";

/** One provider attachment's right to report a thread's native servers. */
export interface ThreadMcpAttachment {
  readonly threadId: ThreadId;
  readonly generation: number;
}

interface ThreadNativeState {
  readonly providerInstanceId: ProviderInstanceId;
  readonly providerThreadId: ProviderThreadId;
  readonly providerSessionId: ProviderSessionId;
  readonly generation: number;
  /** False once the attachment ended; its last observations stay visible. */
  readonly sessionActive: boolean;
  readonly servers: ReadonlyMap<string, ThreadMcpServerObservation>;
  /** Puts a Sign in row for the named server in the session's current turn. */
  readonly showSignIn: ((server: string) => Effect.Effect<McpSignInShowResult>) | undefined;
}

const statusRank = (server: ThreadMcpServerObservation): number => {
  const actionable =
    server.status === "needs-sign-in" ||
    server.status === "credential-rejected" ||
    server.status === "permissions-required" ||
    server.status === "unreachable" ||
    server.status === "unavailable";
  if (actionable && (server.source === "managed" || server.source === "native")) return 0;
  if (actionable) return 1;
  if (server.status === "checking") return 2;
  if (server.status === "ready") return 3;
  return 4;
};

const sortObservations = (
  servers: ReadonlyArray<ThreadMcpServerObservation>,
): ReadonlyArray<ThreadMcpServerObservation> =>
  servers.toSorted((left, right) => {
    const rankDiff = statusRank(left) - statusRank(right);
    if (rankDiff !== 0) return rankDiff;
    return left.displayName.localeCompare(right.displayName);
  });

export class ThreadMcpStatusRegistry extends Context.Service<
  ThreadMcpStatusRegistry,
  {
    /**
     * Opens a provider attachment for the thread; it supersedes any earlier one. Earlier
     * observations stay visible until the new attachment reports.
     */
    readonly attach: (input: {
      readonly threadId: ThreadId;
      readonly providerInstanceId: ProviderInstanceId;
      readonly providerThreadId: ProviderThreadId;
      readonly providerSessionId: ProviderSessionId;
      /** Puts a Sign in row for a server in the session's current turn. */
      readonly showSignIn?: (server: string) => Effect.Effect<McpSignInShowResult>;
    }) => Effect.Effect<ThreadMcpAttachment>;
    /** Replaces every native observation; ignored unless `attachment` is current and open. */
    readonly replaceNative: (
      attachment: ThreadMcpAttachment,
      servers: ReadonlyArray<NativeMcpServerInput>,
    ) => Effect.Effect<void>;
    /** Updates one native observation; ignored unless `attachment` is current and open. */
    readonly upsertNative: (
      attachment: ThreadMcpAttachment,
      server: NativeMcpServerInput,
    ) => Effect.Effect<void>;
    /** Ends the attachment; its observations stay as the last known state. */
    readonly detach: (attachment: ThreadMcpAttachment) => Effect.Effect<void>;
    /** A sign-in finished: the server is rechecked until its provider reports it again. */
    readonly markSignInCompleted: (input: {
      readonly threadId: ThreadId;
      readonly providerThreadId: ProviderThreadId;
      readonly server: string;
    }) => Effect.Effect<void>;
    /**
     * The agent asks for one of its own servers' sign-in, by name: the live session that reported
     * it needs one shows the user a Sign in row.
     */
    readonly requestSignIn: (input: {
      readonly threadId: ThreadId;
      readonly server: string;
    }) => Effect.Effect<McpSignInRequestOutcome>;
    /** Attach an optional host-managed status provider; returns an unregister effect. */
    readonly registerManagedSource: (
      source: ManagedThreadMcpSource,
    ) => Effect.Effect<Effect.Effect<void>>;
    readonly snapshot: (threadId: ThreadId) => Effect.Effect<ThreadMcpStatusSnapshot>;
    readonly subscribe: (threadId: ThreadId) => Stream.Stream<ThreadMcpStatusSnapshot>;
  }
>()("t3/mcpApps/ThreadMcpStatusRegistry") {}

const make = Effect.gen(function* () {
  const threads = yield* Ref.make<ReadonlyMap<ThreadId, ThreadNativeState>>(new Map());
  const nextGeneration = yield* Ref.make(1);
  const revision = yield* Ref.make(0);
  // Per-thread change counters; `null` (a managed source) counts for every thread.
  const threadRevisions = yield* Ref.make<ReadonlyMap<ThreadId, number>>(new Map());
  const anyRevision = yield* Ref.make(0);
  // Wake-ups only, coalesced: a subscriber that falls behind still sees the latest, then compares
  // its thread's counters.
  const changes = yield* PubSub.sliding<void>(1);
  const managedSources = yield* Ref.make<ReadonlySet<ManagedThreadMcpSource>>(new Set());

  const nowIso = Clock.currentTimeMillis.pipe(
    Effect.map((millis) => DateTime.formatIso(DateTime.makeUnsafe(millis)) as IsoDateTime),
  );

  // Stamped with the registry's own revision, so a thread evicted and seen again never repeats one.
  const publishChange = (threadId: ThreadId | null) =>
    Ref.updateAndGet(revision, (value) => value + 1).pipe(
      Effect.flatMap((stamp) =>
        threadId === null
          ? Ref.set(anyRevision, stamp)
          : Ref.update(threadRevisions, (current) => {
              const next = new Map(current);
              next.delete(threadId);
              next.set(threadId, stamp);
              for (const key of next.keys()) {
                if (next.size <= MAX_RETAINED_THREADS) break;
                next.delete(key);
              }
              return next;
            }),
      ),
      Effect.andThen(PubSub.publish(changes, undefined)),
      Effect.asVoid,
    );
  const changeMarker = (threadId: ThreadId) =>
    Effect.all([Ref.get(anyRevision), Ref.get(threadRevisions)]).pipe(
      Effect.map(([any, perThread]) => `${String(any)}:${String(perThread.get(threadId) ?? 0)}`),
    );

  /** Applies `update` to the thread's state when `attachment` owns it; publishes on change. */
  const updateOwned = (
    attachment: ThreadMcpAttachment,
    update: (state: ThreadNativeState) => ThreadNativeState | undefined,
  ) =>
    Ref.modify(threads, (current) => {
      const state = current.get(attachment.threadId);
      if (state === undefined || state.generation !== attachment.generation) {
        return [false, current] as const;
      }
      const next = update(state);
      if (next === undefined) return [false, current] as const;
      const map = new Map(current);
      map.set(attachment.threadId, next);
      return [true, map] as const;
    }).pipe(
      Effect.flatMap((changed) => (changed ? publishChange(attachment.threadId) : Effect.void)),
    );

  const toObservation = (
    input: NativeMcpServerInput,
    providerThreadId: ProviderThreadId,
    observedAt: IsoDateTime,
  ): ThreadMcpServerObservation => {
    const detail = sanitizeMcpStatusDetail(input.detail);
    return {
      id: `${input.source}:${input.name}`,
      name: input.name,
      displayName: input.name,
      source: input.source,
      status: input.status,
      observedAt,
      ...(detail === undefined ? {} : { detail }),
      ...(input.action === undefined ? {} : { action: input.action }),
      providerThreadId,
      sessionActive: true,
    };
  };

  const attach = Effect.fn("ThreadMcpStatusRegistry.attach")(function* (input: {
    readonly threadId: ThreadId;
    readonly providerInstanceId: ProviderInstanceId;
    readonly providerThreadId: ProviderThreadId;
    readonly providerSessionId: ProviderSessionId;
    readonly showSignIn?: (server: string) => Effect.Effect<McpSignInShowResult>;
  }) {
    const generation = yield* Ref.getAndUpdate(nextGeneration, (value) => value + 1);
    yield* Ref.update(threads, (current) => {
      const previous = current.get(input.threadId);
      const map = new Map(current);
      // Re-inserted last, so eviction drops the least recently attached thread first.
      map.delete(input.threadId);
      map.set(input.threadId, {
        providerInstanceId: input.providerInstanceId,
        providerThreadId: input.providerThreadId,
        providerSessionId: input.providerSessionId,
        generation,
        sessionActive: true,
        showSignIn: input.showSignIn,
        servers: new Map(
          [...(previous?.servers ?? new Map<string, ThreadMcpServerObservation>())].map(
            // Last known, but not this session's until it reports them: no action targets them.
            ([id, server]) => [id, { ...server, sessionActive: false }],
          ),
        ),
      });
      for (const key of map.keys()) {
        if (map.size <= MAX_RETAINED_THREADS) break;
        map.delete(key);
      }
      return map;
    });
    yield* publishChange(input.threadId);
    return { threadId: input.threadId, generation } satisfies ThreadMcpAttachment;
  });

  const replaceNative = Effect.fn("ThreadMcpStatusRegistry.replaceNative")(function* (
    attachment: ThreadMcpAttachment,
    servers: ReadonlyArray<NativeMcpServerInput>,
  ) {
    const observedAt = yield* nowIso;
    yield* updateOwned(attachment, (state) => {
      if (!state.sessionActive) return undefined;
      const next = new Map<string, ThreadMcpServerObservation>();
      for (const server of servers.filter(fitsRow).slice(0, MAX_SERVERS_PER_THREAD)) {
        const observation = toObservation(server, state.providerThreadId, observedAt);
        next.set(observation.id, observation);
      }
      return { ...state, servers: next };
    });
  });

  const upsertNative = Effect.fn("ThreadMcpStatusRegistry.upsertNative")(function* (
    attachment: ThreadMcpAttachment,
    server: NativeMcpServerInput,
  ) {
    if (!fitsRow(server)) return;
    const observedAt = yield* nowIso;
    yield* updateOwned(attachment, (state) => {
      if (!state.sessionActive) return undefined;
      const observation = toObservation(server, state.providerThreadId, observedAt);
      if (!state.servers.has(observation.id) && state.servers.size >= MAX_SERVERS_PER_THREAD) {
        return undefined;
      }
      const next = new Map(state.servers);
      next.set(observation.id, observation);
      return { ...state, servers: next };
    });
  });

  const detach = Effect.fn("ThreadMcpStatusRegistry.detach")(function* (
    attachment: ThreadMcpAttachment,
  ) {
    yield* updateOwned(attachment, (state) =>
      state.sessionActive
        ? {
            ...state,
            sessionActive: false,
            // The ended session's adapter is not kept reachable through its last report.
            showSignIn: undefined,
            servers: new Map(
              [...state.servers].map(([id, server]) => [id, { ...server, sessionActive: false }]),
            ),
          }
        : undefined,
    );
  });

  const markSignInCompleted = Effect.fn("ThreadMcpStatusRegistry.markSignInCompleted")(
    function* (input: {
      readonly threadId: ThreadId;
      readonly providerThreadId: ProviderThreadId;
      readonly server: string;
    }) {
      const state = (yield* Ref.get(threads)).get(input.threadId);
      if (state === undefined || state.providerThreadId !== input.providerThreadId) return;
      const observedAt = yield* nowIso;
      yield* updateOwned({ threadId: input.threadId, generation: state.generation }, (current) => {
        if (!current.sessionActive) return undefined;
        let changed = false;
        const next = new Map(current.servers);
        for (const [id, server] of next) {
          if (
            server.source === "managed" ||
            server.name !== input.server ||
            server.status !== "needs-sign-in"
          ) {
            continue;
          }
          const { detail: _detail, action: _action, ...rest } = server;
          next.set(id, { ...rest, status: "checking", observedAt });
          changed = true;
        }
        return changed ? { ...current, servers: next } : undefined;
      });
    },
  );

  const requestSignIn = Effect.fn("ThreadMcpStatusRegistry.requestSignIn")(function* (input: {
    readonly threadId: ThreadId;
    readonly server: string;
  }) {
    const state = (yield* Ref.get(threads)).get(input.threadId);
    const needle = input.server.trim().toLowerCase();
    const server =
      state === undefined
        ? undefined
        : [...state.servers.values()].find(
            (candidate) =>
              candidate.name.toLowerCase() === needle ||
              candidate.displayName.toLowerCase() === needle,
          );
    if (state === undefined || server === undefined) return { _tag: "none" } as const;
    const { displayName } = server;
    if (server.status === "ready") return { _tag: "signed-in", displayName } as const;
    if (server.status !== "needs-sign-in" && server.status !== "checking")
      return { _tag: "not-available", displayName } as const;
    if (server.source === "claudeai") return { _tag: "claudeai", displayName } as const;
    if (!state.sessionActive || !server.sessionActive)
      return { _tag: "inactive", displayName } as const;
    if (state.showSignIn === undefined)
      return { _tag: server.status === "checking" ? "checking" : "card", displayName } as const;
    // The session reads its servers again first: a status that was still settling is not trusted.
    const shown = yield* state
      .showSignIn(server.name)
      .pipe(Effect.orElseSucceed((): McpSignInShowResult => "unavailable"));
    if (shown !== "unavailable") return { _tag: shown, displayName } as const;
    return { _tag: server.status === "checking" ? "checking" : "card", displayName } as const;
  });

  const serviceScope = yield* Effect.scope;
  const registerManagedSource = Effect.fn("ThreadMcpStatusRegistry.registerManagedSource")(
    function* (source: ManagedThreadMcpSource) {
      yield* Ref.update(managedSources, (current) => new Set(current).add(source));
      const fiber = yield* source.changes.pipe(
        Stream.runForEach((changedThreadId) => publishChange(changedThreadId)),
        Effect.forkIn(serviceScope),
      );
      yield* publishChange(null);
      return Effect.gen(function* () {
        yield* Ref.update(managedSources, (current) => {
          const next = new Set(current);
          next.delete(source);
          return next;
        });
        yield* Fiber.interrupt(fiber);
      });
    },
  );

  const snapshot = Effect.fn("ThreadMcpStatusRegistry.snapshot")(function* (threadId: ThreadId) {
    const nativeState = (yield* Ref.get(threads)).get(threadId);
    const sessionActive = nativeState?.sessionActive ?? false;
    const observations: ThreadMcpServerObservation[] = nativeState
      ? [...nativeState.servers.values()]
      : [];
    for (const source of yield* Ref.get(managedSources)) {
      const managed = yield* source
        .snapshot({ threadId, sessionActive })
        .pipe(Effect.orElseSucceed((): ReadonlyArray<ThreadMcpServerObservation> => []));
      observations.push(...managed);
    }
    return {
      threadId,
      revision: NonNegativeInt.make(yield* Ref.get(revision)),
      ...(nativeState === undefined
        ? {}
        : {
            providerInstanceId: nativeState.providerInstanceId,
            providerThreadId: nativeState.providerThreadId,
          }),
      sessionActive,
      // Capped after sorting, so the rows that need the person are the ones kept.
      servers: sortObservations(
        observations.map((server) =>
          server.displayName.length > MAX_DISPLAY_LENGTH
            ? { ...server, displayName: `${server.displayName.slice(0, MAX_DISPLAY_LENGTH - 1)}…` }
            : server,
        ),
      ).slice(0, MAX_SERVERS_PER_THREAD),
    } satisfies ThreadMcpStatusSnapshot;
  });

  const withoutRevision = (value: ThreadMcpStatusSnapshot) => ({
    ...value,
    revision: NonNegativeInt.make(0),
  });

  // Subscribed, and the thread's counters read, before the first snapshot: no change between
  // them is lost, and a dropped wake-up is covered by the next one.
  const subscribe = (threadId: ThreadId) =>
    Stream.unwrap(
      Effect.gen(function* () {
        const subscription = yield* PubSub.subscribe(changes);
        const seen = yield* Ref.make(yield* changeMarker(threadId));
        const first = yield* snapshot(threadId);
        const updates = Stream.fromSubscription(subscription).pipe(
          Stream.mapEffect(() =>
            changeMarker(threadId).pipe(
              Effect.flatMap((marker) =>
                Ref.getAndSet(seen, marker).pipe(Effect.map((previous) => previous !== marker)),
              ),
            ),
          ),
          Stream.filter((changed) => changed),
          Stream.mapEffect(() => snapshot(threadId)),
        );
        return Stream.concat(Stream.make(first), updates);
      }),
    ).pipe(
      Stream.changesWith((left, right) =>
        sameSnapshot(withoutRevision(left), withoutRevision(right)),
      ),
    );

  return ThreadMcpStatusRegistry.of({
    attach,
    replaceNative,
    upsertNative,
    detach,
    markSignInCompleted,
    requestSignIn,
    registerManagedSource,
    snapshot,
    subscribe,
  });
});

export const layer = Layer.effect(ThreadMcpStatusRegistry, make);
