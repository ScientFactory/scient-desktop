import {
  ProviderDriverKind,
  type ProviderSessionStartInput,
  type ProviderRuntimeEvent,
  type ThreadId,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Semaphore from "effect/Semaphore";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import { ProviderAdapterRequestError, type ProviderAdapterError } from "../Errors.ts";
import type { ProviderAdapterShape } from "../Services/ProviderAdapter.ts";
import type { AntigravityAdapterShape } from "../Services/AntigravityAdapter.ts";

const PROVIDER = ProviderDriverKind.make("antigravity");

type Adapter = ProviderAdapterShape<ProviderAdapterError>;
type Backend = "acp" | "legacy";

function cursorVersion(value: unknown): number | undefined {
  if (value === null || typeof value !== "object" || !("schemaVersion" in value)) {
    return undefined;
  }
  return typeof value.schemaVersion === "number" ? value.schemaVersion : undefined;
}

/** Version 2 is Scient's historical `agy --stream-json` continuation cursor. */
export function isLegacyAntigravityResumeCursor(value: unknown): boolean {
  return cursorVersion(value) === 2;
}

/** Version 1 is the official Antigravity ACP continuation cursor. */
export function isAcpAntigravityResumeCursor(value: unknown): boolean {
  return cursorVersion(value) === 1;
}

/**
 * Route saved legacy conversations to `agy` while keeping official ACP as the
 * default for new sessions. The legacy instance is created only if it is
 * actually needed, so normal ACP use has no duplicate probes or processes.
 */
export const makeAntigravityCompatibilityAdapter = Effect.fn("makeAntigravityCompatibilityAdapter")(
  function* (input: {
    readonly acp: Adapter;
    readonly makeLegacy: Effect.Effect<AntigravityAdapterShape, ProviderAdapterError>;
  }) {
    const owners = new Map<ThreadId, Backend>();
    const legacyLock = yield* Semaphore.make(1);
    const legacyReady = yield* Deferred.make<Stream.Stream<ProviderRuntimeEvent>>();
    const scope = yield* Scope.Scope;
    let legacy: Adapter | undefined;

    const getLegacy = legacyLock.withPermits(1)(
      Effect.suspend(() => {
        if (legacy) return Effect.succeed(legacy);
        return Effect.gen(function* () {
          const created = yield* input.makeLegacy;
          const events = yield* created.subscribeEvents.pipe(
            Effect.provideService(Scope.Scope, scope),
          );
          legacy = created;
          yield* Deferred.succeed(legacyReady, events);
          return created;
        });
      }),
    );

    const backendForStart = (start: ProviderSessionStartInput): Backend => {
      if (isLegacyAntigravityResumeCursor(start.resumeCursor)) return "legacy";
      if (isAcpAntigravityResumeCursor(start.resumeCursor)) return "acp";
      return "acp";
    };

    const resolveOwned = Effect.fn("AntigravityCompatibilityAdapter.resolveOwned")(function* (
      threadId: ThreadId,
    ) {
      const known = owners.get(threadId);
      if (known === "acp") return input.acp;
      if (known === "legacy") return yield* getLegacy;
      if (yield* input.acp.hasSession(threadId)) {
        owners.set(threadId, "acp");
        return input.acp;
      }
      if (legacy && (yield* legacy.hasSession(threadId))) {
        owners.set(threadId, "legacy");
        return legacy;
      }
      return input.acp;
    });

    const startSession: Adapter["startSession"] = (start) =>
      Effect.gen(function* () {
        const backend = backendForStart(start);
        const adapter = backend === "legacy" ? yield* getLegacy : input.acp;
        const session = yield* adapter.startSession(start);
        owners.set(start.threadId, backend);
        return session;
      });

    const stopSession: Adapter["stopSession"] = (threadId) =>
      resolveOwned(threadId).pipe(
        Effect.flatMap((adapter) => adapter.stopSession(threadId)),
        Effect.tap(() =>
          Effect.sync(() => {
            owners.delete(threadId);
          }),
        ),
      );

    const stopLegacy = legacyLock.withPermits(1)(
      Effect.suspend(() => legacy?.stopAll() ?? Effect.void),
    );

    const stopAll: Adapter["stopAll"] = () =>
      Effect.all([input.acp.stopAll(), stopLegacy], {
        concurrency: "unbounded",
        discard: true,
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            owners.clear();
          }),
        ),
      );

    const listSessions: Adapter["listSessions"] = () =>
      Effect.all([input.acp.listSessions(), legacy?.listSessions() ?? Effect.succeed([])], {
        concurrency: "unbounded",
      }).pipe(Effect.map(([acp, old]) => [...acp, ...old]));

    const hasSession: Adapter["hasSession"] = (threadId) =>
      Effect.gen(function* () {
        const known = owners.get(threadId);
        if (known) {
          const adapter = known === "acp" ? input.acp : legacy;
          if (adapter && (yield* adapter.hasSession(threadId))) return true;
          owners.delete(threadId);
        }
        if (yield* input.acp.hasSession(threadId)) return true;
        return legacy ? yield* legacy.hasSession(threadId) : false;
      });

    return {
      provider: PROVIDER,
      // New ACP sessions support in-session model changes. A resumed legacy
      // session still enforces its existing new-thread requirement itself.
      capabilities: {
        ...input.acp.capabilities,
        supportsConversationRollback: false,
      },
      startSession,
      sendTurn: (turn) =>
        resolveOwned(turn.threadId).pipe(Effect.flatMap((adapter) => adapter.sendTurn(turn))),
      interruptTurn: (threadId, turnId) =>
        resolveOwned(threadId).pipe(
          Effect.flatMap((adapter) => adapter.interruptTurn(threadId, turnId)),
        ),
      respondToRequest: (threadId, requestId, decision) =>
        resolveOwned(threadId).pipe(
          Effect.flatMap((adapter) => adapter.respondToRequest(threadId, requestId, decision)),
        ),
      respondToUserInput: (threadId, requestId, answers) =>
        resolveOwned(threadId).pipe(
          Effect.flatMap((adapter) => adapter.respondToUserInput(threadId, requestId, answers)),
        ),
      stopSession,
      listSessions,
      hasSession,
      readThread: (threadId) =>
        resolveOwned(threadId).pipe(Effect.flatMap((adapter) => adapter.readThread(threadId))),
      rollbackThread: (threadId, numTurns) =>
        resolveOwned(threadId).pipe(
          Effect.flatMap((adapter) => adapter.rollbackThread(threadId, numTurns)),
        ),
      stopAll,
      streamEvents: Stream.merge(
        input.acp.streamEvents,
        Stream.unwrap(Deferred.await(legacyReady)),
      ),
    } satisfies Adapter;
  },
);

export function mapLegacyAntigravityCreationError(cause: unknown): ProviderAdapterError {
  return new ProviderAdapterRequestError({
    provider: PROVIDER,
    method: "legacy/session/start",
    detail:
      "This conversation uses Scient's previous Antigravity runtime, but that runtime could not be started. Install or configure the legacy agy CLI to continue it, or start a new ACP conversation.",
    cause,
  });
}
