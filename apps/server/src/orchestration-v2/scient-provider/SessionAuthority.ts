import type { ProviderSessionId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import type * as Scope from "effect/Scope";

import type {
  ProviderAdapterV2InitiatedWorkIdentity,
  ProviderAdapterV2SessionRuntime,
} from "../ProviderAdapter.ts";
import type { ProjectionRecords } from "../ProjectionStore.ts";
import type { McpThreadCaller } from "../../mcp/McpInvocationContext.ts";

type AuthoritySessionEntry = {
  readonly runtime: ProviderAdapterV2SessionRuntime;
  readonly exposedRuntime: ProviderAdapterV2SessionRuntime;
  readonly scope: Scope.Closeable;
  readonly attachedThreadIds: ReadonlySet<ThreadId>;
  readonly mcpCredentialIdByThread: ReadonlyMap<ThreadId, string>;
};

/** Execution authority bound only to the exact live native owner. */
export const makeSessionAuthority = <Entry extends AuthoritySessionEntry, E>(input: {
  readonly sessions: Ref.Ref<Map<string, Entry>>;
  readonly sessionKey: (providerSessionId: ProviderSessionId) => string;
  readonly releasingRuntimes: WeakSet<ProviderAdapterV2SessionRuntime>;
  readonly readThreadRecords: (
    invocation: Pick<McpThreadCaller, "threadId" | "providerSessionId">,
  ) => Effect.Effect<ProjectionRecords<"runs" | "attempts" | "providerThreads">, E>;
}) => {
  const { sessions, sessionKey, releasingRuntimes } = input;
  return {
    withProviderWorkAdmission: <A, E2, R>(
      identity: ProviderAdapterV2InitiatedWorkIdentity,
      expectedRuntime: ProviderAdapterV2SessionRuntime,
      commit: Effect.Effect<A, E2, R>,
    ) =>
      Effect.gen(function* () {
        const key = sessionKey(identity.providerSessionId);
        const entry = (yield* Ref.get(sessions)).get(key);
        if (
          entry === undefined ||
          entry.exposedRuntime !== expectedRuntime ||
          !entry.attachedThreadIds.has(identity.threadId) ||
          entry.runtime.driver !== identity.driver ||
          entry.runtime.instanceId !== identity.providerInstanceId ||
          entry.runtime.withInitiatedWorkAdmission === undefined
        )
          return Option.none<A>();
        return yield* entry.runtime
          .withInitiatedWorkAdmission(
            identity,
            Effect.gen(function* () {
              const current = (yield* Ref.get(sessions)).get(key);
              if (
                current?.runtime !== entry.runtime ||
                current.scope !== entry.scope ||
                current.exposedRuntime !== expectedRuntime ||
                !current.attachedThreadIds.has(identity.threadId) ||
                releasingRuntimes.has(current.runtime)
              )
                return Option.none<A>();
              return Option.some(yield* commit);
            }),
          )
          .pipe(Effect.map(Option.flatten));
      }),
    resolveMcpInvocationPolicy: Effect.fn("ProviderSessionManagerV2.resolveMcpInvocationPolicy")(
      function* (
        invocation: Pick<McpThreadCaller, "threadId" | "providerInstanceId" | "providerSessionId">,
      ) {
        const entries = [...(yield* Ref.get(sessions)).values()].filter(
          (entry) =>
            !releasingRuntimes.has(entry.runtime) &&
            entry.runtime.instanceId === invocation.providerInstanceId &&
            entry.attachedThreadIds.has(invocation.threadId) &&
            entry.mcpCredentialIdByThread.get(invocation.threadId) === invocation.providerSessionId,
        );
        if (entries.length === 0) return Option.none();
        const projection = yield* input.readThreadRecords(invocation);
        if (projection.thread.deletedAt !== null || projection.thread.archivedAt !== null)
          return Option.none();
        const run = projection.runs
          .filter((candidate) => ["starting", "running", "waiting"].includes(candidate.status))
          .toSorted((left, right) => right.ordinal - left.ordinal)[0];
        if (
          run === undefined ||
          !["starting", "running", "waiting"].includes(run.status) ||
          run.providerInstanceId !== invocation.providerInstanceId ||
          run.runtimeMode === undefined ||
          run.interactionMode === undefined
        )
          return Option.none();
        const attempt = projection.attempts.find(
          (candidate) => candidate.id === run.activeAttemptId,
        );
        const nativeThread = projection.providerThreads.find(
          (candidate) => candidate.id === run.providerThreadId,
        );
        if (
          attempt === undefined ||
          nativeThread === undefined ||
          !["pending", "running"].includes(attempt.status) ||
          attempt.runId !== run.id ||
          attempt.rootNodeId !== run.rootNodeId ||
          attempt.providerInstanceId !== invocation.providerInstanceId ||
          attempt.providerThreadId !== nativeThread?.id ||
          nativeThread.appThreadId !== invocation.threadId ||
          nativeThread.providerInstanceId !== invocation.providerInstanceId
        )
          return Option.none();
        const current = yield* Ref.get(sessions);
        const owner = entries.find(
          (entry) =>
            !releasingRuntimes.has(entry.runtime) &&
            entry.runtime.providerSessionId === nativeThread.providerSessionId &&
            current.get(sessionKey(entry.runtime.providerSessionId))?.runtime === entry.runtime &&
            current
              .get(sessionKey(entry.runtime.providerSessionId))
              ?.attachedThreadIds.has(invocation.threadId) === true &&
            current
              .get(sessionKey(entry.runtime.providerSessionId))
              ?.mcpCredentialIdByThread.get(invocation.threadId) === invocation.providerSessionId,
        );
        return owner === undefined
          ? Option.none()
          : Option.some({ runtimeMode: run.runtimeMode, interactionMode: run.interactionMode });
      },
    ),
  };
};
