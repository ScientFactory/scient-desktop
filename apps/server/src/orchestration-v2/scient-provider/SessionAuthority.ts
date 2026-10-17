import type {
  OrchestrationV2Run,
  ProviderInteractionMode,
  ProviderSessionId,
  RuntimeMode,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import type * as Scope from "effect/Scope";

import type {
  ProviderAdapterV2InitiatedWorkIdentity,
  ProviderAdapterV2SessionRuntime,
} from "@t3tools/provider-core/server/ProviderAdapter";
import type { ProjectionRecords } from "../ProjectionStore.ts";
import type { McpThreadCaller } from "../../mcp/McpInvocationContext.ts";

type AuthoritySessionEntry = {
  readonly runtime: ProviderAdapterV2SessionRuntime;
  readonly exposedRuntime: ProviderAdapterV2SessionRuntime;
  readonly scope: Scope.Closeable;
  readonly attachedThreadIds: ReadonlySet<ThreadId>;
  readonly mcpCredentialIdByThread: ReadonlyMap<ThreadId, string>;
};

type PolicyRecords = ProjectionRecords<"runs" | "attempts" | "providerThreads">;
type PolicyInvocation = Pick<McpThreadCaller, "threadId" | "providerInstanceId">;
type PolicyRun = PolicyRecords["runs"][number] & {
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: ProviderInteractionMode;
};
type PolicySource = {
  readonly run: PolicyRun;
  readonly nativeThread: PolicyRecords["providerThreads"][number];
};

const ACTIVE_RUN_STATUSES: ReadonlySet<OrchestrationV2Run["status"]> = new Set([
  "starting",
  "running",
  "waiting",
]);
const OPEN_RUN_STATUSES: ReadonlySet<OrchestrationV2Run["status"]> = new Set([
  "preparing",
  ...ACTIVE_RUN_STATUSES,
]);

const hasCapturedModes = (run: PolicyRecords["runs"][number]): run is PolicyRun =>
  run.runtimeMode !== undefined && run.interactionMode !== undefined;

/** The native owner's active run and its attempt carry the captured policy. */
function activeRunPolicy(
  projection: PolicyRecords,
  invocation: PolicyInvocation,
): PolicySource | undefined {
  const run = projection.runs
    .filter((candidate) => ACTIVE_RUN_STATUSES.has(candidate.status))
    .toSorted((left, right) => right.ordinal - left.ordinal)[0];
  if (
    run === undefined ||
    run.providerInstanceId !== invocation.providerInstanceId ||
    !hasCapturedModes(run)
  )
    return undefined;
  const attempt = projection.attempts.find((candidate) => candidate.id === run.activeAttemptId);
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
    attempt.providerThreadId !== nativeThread.id ||
    nativeThread.appThreadId !== invocation.threadId ||
    nativeThread.providerInstanceId !== invocation.providerInstanceId
  )
    return undefined;
  return { run, nativeThread };
}

/**
 * A background subagent outlives the run that started it and calls tools with
 * its thread's credential. With no open run, the credential's own provider
 * thread must still report a subagent on the caller's instance; writes stay
 * within the modes of the settled run that started it.
 */
function backgroundSubagentPolicy(
  projection: PolicyRecords,
  invocation: PolicyInvocation,
  ownedSessionIds: ReadonlySet<ProviderSessionId>,
): PolicySource | undefined {
  if (
    projection.thread.providerInstanceId !== invocation.providerInstanceId ||
    projection.runs.some((candidate) => OPEN_RUN_STATUSES.has(candidate.status))
  )
    return undefined;
  // Queued follow-ups wait behind the background work; they never ran.
  const run = projection.runs
    .filter((candidate) => candidate.status !== "queued")
    .toSorted((left, right) => right.ordinal - left.ordinal)[0];
  if (
    run === undefined ||
    run.status === "rolled_back" ||
    run.providerInstanceId !== invocation.providerInstanceId ||
    !hasCapturedModes(run)
  )
    return undefined;
  const nativeThread = projection.providerThreads.find(
    (candidate) =>
      candidate.id === run.providerThreadId &&
      candidate.providerSessionId !== null &&
      ownedSessionIds.has(candidate.providerSessionId) &&
      candidate.appThreadId === invocation.threadId &&
      candidate.providerInstanceId === invocation.providerInstanceId,
  );
  const subagentLive = nativeThread?.pendingBackgroundTasks?.some(
    (task) =>
      task.kind === "subagent" &&
      (task.providerInstanceId ?? nativeThread.providerInstanceId) ===
        invocation.providerInstanceId,
  );
  return nativeThread === undefined || subagentLive !== true ? undefined : { run, nativeThread };
}

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
        const policy =
          activeRunPolicy(projection, invocation) ??
          backgroundSubagentPolicy(
            projection,
            invocation,
            new Set(entries.map((entry) => entry.runtime.providerSessionId)),
          );
        if (policy === undefined) return Option.none();
        const { run, nativeThread } = policy;
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
