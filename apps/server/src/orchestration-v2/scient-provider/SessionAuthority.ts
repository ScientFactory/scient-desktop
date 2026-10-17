import type {
  OrchestrationV2Run,
  OrchestrationV2ThreadShell,
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
import { isLiveCallerShell } from "../../mcp/liveCallerShell.ts";
import { exceededDispatchModeLimit, type DispatchModes } from "../DispatchModeLimit.ts";

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
  readonly modes: DispatchModes;
  readonly nativeThread: PolicyRecords["providerThreads"][number];
};

const ACTIVE_RUN_STATUSES: ReadonlySet<OrchestrationV2Run["status"]> = new Set([
  "starting",
  "running",
  "waiting",
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
  return {
    modes: { runtimeMode: run.runtimeMode, interactionMode: run.interactionMode },
    nativeThread,
  };
}

/** Each mode at the lower of the two ranks. */
const narrowerModes = (left: DispatchModes, right: DispatchModes): DispatchModes => ({
  runtimeMode:
    exceededDispatchModeLimit(
      { runtimeMode: right.runtimeMode, interactionMode: "plan" },
      { runtimeMode: left.runtimeMode, interactionMode: "plan" },
    ) === "runtime"
      ? right.runtimeMode
      : left.runtimeMode,
  interactionMode:
    exceededDispatchModeLimit(
      { runtimeMode: "approval-required", interactionMode: right.interactionMode },
      { runtimeMode: "approval-required", interactionMode: left.interactionMode },
    ) === "interaction"
      ? right.interactionMode
      : left.interactionMode,
});

/** Execution authority bound only to the exact live native owner. */
export const makeSessionAuthority = <Entry extends AuthoritySessionEntry, E>(input: {
  readonly sessions: Ref.Ref<Map<string, Entry>>;
  readonly sessionKey: (providerSessionId: ProviderSessionId) => string;
  readonly releasingRuntimes: WeakSet<ProviderAdapterV2SessionRuntime>;
  readonly readThreadRecords: (
    invocation: Pick<McpThreadCaller, "threadId" | "providerSessionId">,
  ) => Effect.Effect<PolicyRecords, E>;
  readonly readThreadShell: (
    invocation: Pick<McpThreadCaller, "threadId" | "providerSessionId">,
  ) => Effect.Effect<OrchestrationV2ThreadShell | null, E>;
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
        const shell = yield* input.readThreadShell(invocation);
        if (shell === null) return Option.none();
        // Upstream caps a thread caller at the thread's current modes. During
        // an active run Scient also caps it at the modes that run captured.
        const threadModes = {
          runtimeMode: shell.runtimeMode,
          interactionMode: shell.interactionMode,
        };
        const active = activeRunPolicy(projection, invocation);
        const policy =
          active !== undefined
            ? {
                modes: narrowerModes(active.modes, threadModes),
                providerSessionId: active.nativeThread.providerSessionId,
              }
            : isLiveCallerShell(shell, invocation.providerInstanceId)
              ? { modes: threadModes, providerSessionId: undefined }
              : undefined;
        if (policy === undefined) return Option.none();
        const current = yield* Ref.get(sessions);
        const owner = entries.find(
          (entry) =>
            !releasingRuntimes.has(entry.runtime) &&
            (policy.providerSessionId === undefined ||
              entry.runtime.providerSessionId === policy.providerSessionId) &&
            current.get(sessionKey(entry.runtime.providerSessionId))?.runtime === entry.runtime &&
            current
              .get(sessionKey(entry.runtime.providerSessionId))
              ?.attachedThreadIds.has(invocation.threadId) === true &&
            current
              .get(sessionKey(entry.runtime.providerSessionId))
              ?.mcpCredentialIdByThread.get(invocation.threadId) === invocation.providerSessionId,
        );
        return owner === undefined ? Option.none() : Option.some(policy.modes);
      },
    ),
  };
};
