import type {
  OrchestrationV2ContextHandoff,
  OrchestrationV2ThreadProjection,
  ProviderInstanceId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { ServerSettingsService } from "../serverSettings.ts";
import {
  DEFAULT_HANDOFF_TOKEN_CAP,
  handoffTokenCapConfig,
  hasScientContextHistory,
  scientHandoffTokenCapOverride,
} from "./ContextHandoffBudget.ts";
import { handoffTokenCap } from "./scient-fork/context/handoffBudget.ts";

/** Explicit replay-fixture override; production chooses policy from canonical provenance. */
export class ContextHandoffPolicyOverride extends Context.Reference<"byte" | undefined>(
  "t3/orchestration-v2/ContextHandoffPolicyOverride",
  { defaultValue: () => undefined },
) {}

export const genericContextHandoffPolicy = handoffTokenCapConfig.pipe(
  Effect.orElseSucceed(() => DEFAULT_HANDOFF_TOKEN_CAP),
  Effect.map((tokenCap) => ({ tokenCap, bytesPerToken: 1, byteCap: 64_000 })),
);

/** Capture required settings once; read the latest Scient preset at final delivery. */
export const makeScientContextHandoffPolicy = Effect.fn("ScientContextHandoffPolicy.make")(
  function* () {
    const settings = yield* ServerSettingsService;
    return Effect.gen(function* () {
      const snapshot = yield* settings.getSettings;
      const override = yield* scientHandoffTokenCapOverride.pipe(
        Effect.orElseSucceed(() => Option.none<number>()),
      );
      return {
        tokenCap: handoffTokenCap(
          snapshot.scientFork.contextHandoffSize,
          Option.getOrUndefined(override),
        ),
        bytesPerToken: 3,
        byteCap: Infinity,
      };
    });
  },
);

/** Scient history, or a handoff carried by a fork or merge-back into this thread and
 * instance, spends the Scient budget unless a replay fixture forces the byte policy. */
export const usesScientHandoffBudget = (input: {
  readonly forceBytePolicy: boolean;
  readonly projection: Pick<OrchestrationV2ThreadProjection, "thread" | "contextTransfers">;
  readonly handoffs: ReadonlyArray<OrchestrationV2ContextHandoff>;
  readonly providerInstanceId: ProviderInstanceId;
}): boolean => {
  const { projection } = input;
  return (
    !input.forceBytePolicy &&
    (hasScientContextHistory(projection) ||
      input.handoffs.some(
        (handoff) =>
          handoff.budgetPolicy === "scient" ||
          projection.contextTransfers.some(
            (transfer) =>
              transfer.id === handoff.transferId &&
              (transfer.type === "fork" || transfer.type === "merge_back") &&
              transfer.targetThreadId === projection.thread.id &&
              transfer.targetProviderInstanceId === input.providerInstanceId,
          ),
      ))
  );
};

/** Fork workspace and import provenance the handoff delivery tells the provider. */
export const scientHandoffDeliveryProvenance = (
  thread: OrchestrationV2ThreadProjection["thread"],
) => ({
  sharedForkWorkspace: thread.conversationFork?.workspaceMode === "local",
  sourceOmissions: (thread.conversationImport ?? thread.forkLineage?.sourceImport)?.omissions ?? [],
  ...((thread.conversationImport ?? thread.forkLineage?.sourceImport) == null
    ? {}
    : {
        importedMaterial:
          (thread.conversationImport ?? thread.forkLineage?.sourceImport)?.sourceFormat ===
          "scient-markdown-document"
            ? ("document" as const)
            : ("conversation" as const),
      }),
});
