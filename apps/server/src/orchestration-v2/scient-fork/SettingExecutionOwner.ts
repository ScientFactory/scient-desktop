/** Thread defaults (model, provider, runtime mode) describe the next user turn. While a
 * provider-initiated generation or a held Droid Steer owns the running work, setting them
 * must not replace or detach that owner. */
import type {
  ModelSelection,
  OrchestrationV2AppThread,
  OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import { modelSelectionsEqual } from "@t3tools/shared/model";

import type { ProviderSwitchPlanV2 } from "../ProviderSwitchService.ts";

/** The owner of the thread's live run, if a provider generation or held Droid input owns it. */
export function settingExecutionOwnerOf(
  projection: Pick<OrchestrationV2ThreadProjection, "runs" | "messages">,
  thread: Pick<OrchestrationV2AppThread, "activeProviderThreadId">,
) {
  const run = projection.runs.find((run) =>
    ["starting", "running", "waiting"].includes(run.status),
  );
  const source = projection.messages.find((message) => message.id === run?.userMessageId)
    ?.notification?.source;
  return {
    native:
      source?.kind === "provider_work" && source.providerThreadId === thread.activeProviderThreadId
        ? source
        : undefined,
    // SCIENT: next-turn defaults cannot detach a source that still owns held Droid input.
    droid: run?.status === "running" ? run.heldDroidSteer : undefined,
    providerThreadId: run?.providerThreadId,
  };
}

/** A switch plan that keeps the current owner, or undefined when the ordinary plan applies. */
export function ownerPreservingSwitchPlan(input: {
  readonly owner: ReturnType<typeof settingExecutionOwnerOf> | undefined;
  readonly thread: Pick<OrchestrationV2AppThread, "providerInstanceId" | "modelSelection">;
  readonly modelSelection: ModelSelection;
}): ProviderSwitchPlanV2 | undefined {
  const { owner, thread, modelSelection } = input;
  // SCIENT: preserve this exact held source; admission still uses its captured target.
  if (owner?.droid !== undefined)
    return {
      instanceChanged: modelSelection.instanceId !== thread.providerInstanceId,
      modelChanged: !modelSelectionsEqual(thread.modelSelection, modelSelection),
      targetProviderThreadId: owner.providerThreadId!,
      releaseProviderSessionIds: [],
      transition: { type: "reuse" as const },
    };
  // Defaults describe the next user turn. Do not replace the owner of
  // a generation already admitted under its captured workspace.
  if (owner?.native !== undefined && modelSelection.instanceId === thread.providerInstanceId)
    return {
      instanceChanged: false,
      modelChanged: !modelSelectionsEqual(thread.modelSelection, modelSelection),
      targetProviderThreadId: owner.native.providerThreadId,
      releaseProviderSessionIds: [],
      transition: { type: "reuse" as const },
    };
  return undefined;
}
