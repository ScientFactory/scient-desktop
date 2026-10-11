/** Provider-initiated work: a native generation the provider started on its own becomes a
 * run only while it still owns the thread's idle native thread, under the thread lock. */
import {
  CommandId,
  ThreadId,
  type OrchestrationV2Command,
  type OrchestrationV2ServerCommand,
  type OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import type { OrchestratorDispatchError } from "../Orchestrator.ts";
import type { ProviderAdapterV2SessionRuntime } from "@t3tools/provider-core/server/ProviderAdapter";
import type { ProviderSessionManagerV2Shape } from "../ProviderSessionManager.ts";

type ProviderWorkAdmitCommand = Extract<
  OrchestrationV2ServerCommand,
  { readonly type: "provider-work.admit" }
>;

/** A still-owned native generation can retry once its predecessor has settled. */
export class OrchestratorProviderWorkDeferredError extends Schema.TaggedError<OrchestratorProviderWorkDeferredError>()(
  "OrchestratorProviderWorkDeferredError",
  { commandId: CommandId, threadId: ThreadId, workId: Schema.String },
) {
  override get message(): string {
    return "Provider-initiated work is waiting for its predecessor to complete.";
  }
}

/** Refused work fails its command; deferred work stays retryable; admitted work runs. */
export const classifyProviderWorkAdmission = ({
  command,
  projection,
  session,
  path,
}: {
  readonly command: ProviderWorkAdmitCommand;
  readonly projection: Pick<
    OrchestrationV2ThreadProjection,
    "thread" | "providerThreads" | "providerSessions" | "runs"
  >;
  readonly session: Option.Option<ProviderAdapterV2SessionRuntime>;
  readonly path: Pick<Path.Path, "isAbsolute">;
}):
  | { readonly type: "refused"; readonly cause: string }
  | { readonly type: "deferred" }
  | { readonly type: "admitted"; readonly owner: ProviderAdapterV2SessionRuntime } => {
  const nativeThread = projection.providerThreads.find(
    (row) => row.id === command.providerThreadId,
  );
  // A checkpoint needs the generation's actual directory, never a newer
  // project default substituted for unknown native workspace ownership.
  if (command.runtimePolicy.cwd === null || !path.isAbsolute(command.runtimePolicy.cwd))
    return {
      type: "refused",
      cause: "Provider-initiated work requires a known absolute execution directory.",
    };
  if (
    projection.thread.archivedAt !== null ||
    projection.thread.deletedAt !== null ||
    projection.thread.activeProviderThreadId !== command.providerThreadId ||
    projection.thread.providerInstanceId !== command.providerInstanceId ||
    nativeThread?.appThreadId !== command.threadId ||
    nativeThread.providerSessionId !== command.providerSessionId ||
    nativeThread.providerInstanceId !== command.providerInstanceId ||
    nativeThread.driver !== command.driver ||
    Option.isNone(session) ||
    session.value.driver !== command.driver ||
    session.value.instanceId !== command.providerInstanceId ||
    command.modelSelection.instanceId !== command.providerInstanceId ||
    session.value.providerSession.cwd !== command.runtimePolicy.cwd ||
    !projection.providerSessions.some(
      (row) =>
        row.id === command.providerSessionId &&
        ["ready", "running", "waiting"].includes(row.status),
    )
  )
    return {
      type: "refused",
      cause: "Provider-initiated work no longer owns an idle native thread.",
    };
  if (
    projection.runs.some((run) => ["queued", "starting", "running", "waiting"].includes(run.status))
  )
    return { type: "deferred" };
  return { type: "admitted", owner: session.value };
};

/** The admitted work starts as an agent-created message carrying its native owner. */
export const providerWorkMessageCommand = (
  command: ProviderWorkAdmitCommand,
): Extract<OrchestrationV2Command, { readonly type: "message.dispatch" }> => ({
  type: "message.dispatch",
  commandId: command.commandId,
  threadId: command.threadId,
  messageId: command.messageId,
  text: command.detail,
  modelSelection: command.modelSelection,
  runtimeMode: command.runtimePolicy.runtimeMode,
  interactionMode: command.runtimePolicy.interactionMode,
  attachments: [],
  createdBy: "agent",
  creationSource: "provider",
  dispatchMode: { type: "start_immediately" },
  notification: {
    source: {
      kind: "provider_work",
      workId: command.workId,
      providerThreadId: command.providerThreadId,
      providerSessionId: command.providerSessionId,
      modelSelection: command.modelSelection,
      runtimePolicy: command.runtimePolicy,
    },
    outcome: "updated",
    summary: "Provider started work",
  },
});

/** Thread → native generation → SQL. The cached planning owner is rechecked
 * inside the fence; physical shutdown never runs while that fence is held. */
export const commitProviderWorkAdmission = <A, E, R>({
  DispatchError,
  providerSessions,
  command,
  owner,
  commit,
}: {
  readonly DispatchError: typeof OrchestratorDispatchError;
  readonly providerSessions: Pick<ProviderSessionManagerV2Shape, "withProviderWorkAdmission">;
  readonly command: ProviderWorkAdmitCommand;
  readonly owner: ProviderAdapterV2SessionRuntime | undefined;
  readonly commit: Effect.Effect<A, E, R>;
}) =>
  Effect.gen(function* () {
    if (owner === undefined)
      return yield* new DispatchError({
        commandId: command.commandId,
        commandType: command.type,
        cause: "Provider-initiated work has no native admission owner.",
      });
    const result = yield* providerSessions.withProviderWorkAdmission(command, owner, commit);
    if (Option.isNone(result))
      return yield* new DispatchError({
        commandId: command.commandId,
        commandType: command.type,
        cause: "Provider-initiated work lost its native generation before admission.",
      });
    return result.value;
  });
