import { ExtensionsError, type PluginKeyTarget, type VaultSecretRef } from "@t3tools/contracts";
import * as KeyedLock from "@t3tools/shared/KeyedLock";
import { Clock, Effect, Redacted, Stream } from "effect";
import type { AccountsServiceShape } from "../accounts/AccountsService.ts";

export type PluginKeyResolveInput = PluginKeyTarget & {
  readonly envName: string;
  readonly origin?: string;
  readonly expectedRef?: VaultSecretRef | undefined;
  readonly auditAllowed?: boolean;
};
const WINDOW = 3 * 60 * 1000;
const LIMIT = 4096;
const identity = (value: unknown) => JSON.stringify(value);
const unavailable = () =>
  new ExtensionsError({
    reason: "state-unavailable",
    message: "The plugin key changed while it was being resolved. Retry with the current account.",
  });
const trim = <K, V>(map: Map<K, V>) => {
  if (map.size >= LIMIT) map.delete(map.keys().next().value!);
};

/** Values never cross the server boundary. Revision reads are lock-free and contain no secrets. */
export const makePluginKeySessionCache = Effect.fn("PluginKeySessionCache.make")(function* (
  accounts:
    | Pick<AccountsServiceShape, "bindingRevision" | "changes" | "recordBoundDenial">
    | undefined,
  resolve: (
    input: PluginKeyResolveInput,
  ) => Effect.Effect<Redacted.Redacted<string>, ExtensionsError>,
) {
  const values = new Map<
    string,
    { sessionId: string; revision: number; until: number; value: Redacted.Redacted<string> }
  >();
  const audited = new Map<string, { sessionId: string; at: number }>();
  const sessions = new Map<string, symbol>();
  const ended = new Set<string>();
  const locks = yield* KeyedLock.make<string>();
  let epoch = 0;
  let closed = false;
  const invalidate = Effect.sync(() => {
    epoch++;
    values.clear();
  });
  const clearSession = (sessionId: string, mayRevive = false) =>
    Effect.sync(() => {
      if (!mayRevive) {
        if (ended.size >= LIMIT) ended.delete(ended.values().next().value!);
        ended.add(sessionId);
      }
      sessions.delete(sessionId);
      for (const [key, entry] of values) if (entry.sessionId === sessionId) values.delete(key);
      for (const [key, entry] of audited) if (entry.sessionId === sessionId) audited.delete(key);
    });
  // Usage activity and lastUsedAt do not change this epoch. The revision port also
  // covers changes whose stream notification has not yet reached this subscriber.
  if (accounts?.changes && accounts.bindingRevision) {
    const readRevision = accounts.bindingRevision;
    let initial = true;
    let revision: number | undefined;
    yield* accounts.changes.pipe(
      Stream.runForEach(() =>
        Effect.gen(function* () {
          const next = yield* readRevision;
          if (!initial && next !== revision) {
            for (const [key, entry] of values) if (entry.revision !== next) values.delete(key);
          }
          initial = false;
          revision = next;
        }),
      ),
      Effect.forkScoped,
    );
  }
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      closed = true;
      values.clear();
      audited.clear();
      sessions.clear();
      ended.clear();
    }),
  );

  const refuse = Effect.fn("PluginKeySessionCache.refuse")(function* (
    input: PluginKeyResolveInput,
  ) {
    if (accounts?.recordBoundDenial && input.expectedRef)
      yield* accounts.recordBoundDenial(input.expectedRef, {
        kind: "plugin-key",
        agent: input.agent ?? "scient",
        pluginId: input.pluginId,
        envName: input.envName,
        ...(input.origin ? { origin: input.origin } : {}),
        ...(input.projectId ? { projectId: input.projectId } : {}),
      });
    return yield* unavailable();
  });
  const resolveForSession = Effect.fn("PluginKeySessionCache.resolve")(function* (
    sessionId: string,
    input: PluginKeyResolveInput,
  ) {
    if (closed) return yield* unavailable();
    if (ended.has(sessionId)) return yield* refuse(input);
    // A compatible service without the synchronous epoch must never serve cached secrets.
    if (!accounts?.bindingRevision) return yield* resolve(input);
    const key = identity([
      sessionId,
      input.agent,
      input.pluginId,
      input.envName,
      input.origin,
      input.projectId,
      input.expectedRef,
    ]);
    const auditKey = identity([sessionId, input.agent, input.pluginId, input.envName]);
    if (!sessions.has(sessionId)) {
      trim(sessions);
      sessions.set(sessionId, Symbol());
    }
    const owner = sessions.get(sessionId);
    return yield* locks.withLock(
      auditKey,
      Effect.gen(function* () {
        if (sessions.get(sessionId) !== owner) return yield* refuse(input);
        const revision = yield* accounts.bindingRevision!;
        const now = yield* Clock.currentTimeMillis;
        const cached = values.get(key);
        if (revision !== undefined && cached?.revision === revision && cached.until > now)
          return cached.value;
        values.delete(key);
        const started = epoch;
        const auditAllowed =
          now - (audited.get(auditKey)?.at ?? Number.NEGATIVE_INFINITY) >= WINDOW;
        const value = yield* resolve({ ...input, auditAllowed });
        // An edit/rebind/session release during an asynchronous source lookup cannot
        // publish its old result, even if its Accounts notification is still queued.
        const current = yield* accounts.bindingRevision!;
        if (started !== epoch || sessions.get(sessionId) !== owner || current !== revision)
          return yield* refuse(input);
        if (auditAllowed) {
          trim(audited);
          audited.set(auditKey, { sessionId, at: now });
        }
        if (revision !== undefined) {
          trim(values);
          values.set(key, { sessionId, revision, until: now + WINDOW, value });
        }
        return value;
      }),
    );
  });
  return { resolveForSession, invalidate, clearSession };
});
