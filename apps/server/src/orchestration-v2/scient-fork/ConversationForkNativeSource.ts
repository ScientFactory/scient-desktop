import {
  OrchestrationV2ProviderThreadJson,
  OrchestrationV2ProviderTurnJson,
  OrchestrationV2RunJson,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2ProviderTurn,
  type OrchestrationV2ClaudeForkBoundaryEvidence,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2TurnItem,
  type RunId,
  type OrchestrationV2FrozenForkSource,
  type OrchestrationV2ProviderCapabilities,
  type ProviderInstanceId,
  type ProviderDriverKind,
  type ThreadId,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import type { ConversationForkSource } from "./ConversationForkPlan.ts";

export type FrozenConversationForkNativeSource = OrchestrationV2FrozenForkSource;

export type ConversationForkNativeSourceDecision =
  | { readonly strategy: "native_fork"; readonly frozenSource: FrozenConversationForkNativeSource }
  | { readonly strategy: "portable_context"; readonly reason: string };

const runJson = Schema.fromJsonString(OrchestrationV2RunJson);
const threadJson = Schema.fromJsonString(OrchestrationV2ProviderThreadJson);
const turnsJson = Schema.fromJsonString(Schema.Array(OrchestrationV2ProviderTurnJson));

const isUuid = Schema.is(Schema.String.check(Schema.isUUID()));

function exactNativeBoundary(
  turn: OrchestrationV2ProviderTurn,
  driver: ProviderDriverKind,
  sourceThreadId: ThreadId,
  providerThreadId: OrchestrationV2ProviderTurn["providerThreadId"],
  evidence: OrchestrationV2ClaudeForkBoundaryEvidence | undefined,
): boolean {
  const ref = turn.nativeTurnRef;
  if (ref === null || ref.driver !== driver || !ref.nativeId?.trim()) return false;
  if (ref.strength === "strong") return true;
  return (
    driver === "claudeAgent" &&
    ref.strength === "weak" &&
    isUuid(ref.nativeId) &&
    evidence?.kind === "claude_root_assistant_uuid" &&
    evidence.nativeMessageId === ref.nativeId &&
    evidence.sourceThreadId === sourceThreadId &&
    evidence.providerThreadId === providerThreadId &&
    evidence.providerTurnId === turn.id &&
    evidence.rootNodeId === turn.nodeId
  );
}

/** Recheck destination authority at admission and immediately before native cloning. */
export function frozenForkPortableReason(input: {
  readonly frozenSource: FrozenConversationForkNativeSource | undefined;
  readonly sourceThreadId: ThreadId;
  readonly sourceRunId: RunId | undefined;
  readonly targetInstanceId: ProviderInstanceId;
  readonly targetDriver: ProviderDriverKind;
  readonly capabilities: OrchestrationV2ProviderCapabilities;
}): string | undefined {
  const frozen = input.frozenSource;
  if (frozen === undefined) return "The frozen prefix lacks complete native ownership evidence.";
  const run = frozen.sourceRun;
  const thread = frozen.sourceProviderThread;
  const turn = frozen.sourceProviderTurns.find(
    (candidate) => candidate.id === frozen.providerTurnId,
  );
  if (
    frozen.sourceThreadId !== input.sourceThreadId ||
    run.id !== input.sourceRunId ||
    run.threadId !== frozen.sourceThreadId ||
    thread.appThreadId !== frozen.sourceThreadId ||
    thread.ownerNodeId !== null ||
    run.providerThreadId !== thread.id ||
    run.status !== "completed" ||
    run.completedAt === null ||
    run.rootNodeId === null ||
    run.activeAttemptId === null ||
    turn?.providerThreadId !== thread.id ||
    turn.nodeId !== run.rootNodeId ||
    turn.runAttemptId !== run.activeAttemptId ||
    turn.status !== "completed" ||
    turn.completedAt === null ||
    thread.nativeThreadRef?.strength !== "strong" ||
    !thread.nativeThreadRef.nativeId?.trim() ||
    !exactNativeBoundary(
      turn,
      frozen.driver,
      frozen.sourceThreadId,
      thread.id,
      frozen.claudeBoundaryEvidence?.find((proof) => proof.providerTurnId === turn.id),
    ) ||
    frozen.sourceProviderTurns.some(
      (candidate) =>
        candidate.providerThreadId !== thread.id ||
        candidate.status !== "completed" ||
        candidate.completedAt === null ||
        !exactNativeBoundary(
          candidate,
          frozen.driver,
          frozen.sourceThreadId,
          thread.id,
          frozen.claudeBoundaryEvidence?.find((proof) => proof.providerTurnId === candidate.id),
        ),
    ) ||
    (turn.nativeTurnRef?.strength === "weak" &&
      frozen.claudeBoundaryEvidence?.find((proof) => proof.providerTurnId === turn.id)?.runId !==
        run.id)
  ) {
    return "The stored native proof does not identify the exact frozen root boundary.";
  }
  if (
    frozen.driver !== input.targetDriver ||
    thread.driver !== frozen.driver ||
    thread.nativeThreadRef.driver !== frozen.driver ||
    turn.nativeTurnRef?.driver !== frozen.driver ||
    frozen.modelSelection.instanceId !== input.targetInstanceId ||
    run.providerInstanceId !== input.targetInstanceId ||
    run.modelSelection.instanceId !== input.targetInstanceId ||
    thread.providerInstanceId !== input.targetInstanceId
  ) {
    return "The selected provider differs from the frozen source provider scope.";
  }
  if (
    !input.capabilities.threads.canForkThread ||
    !input.capabilities.threads.canForkFromTurn ||
    input.capabilities.identity.nativeThreadIds !== "strong"
  ) {
    return "The selected provider cannot reproduce an exact native turn fork.";
  }
  return undefined;
}

/** Native history is an optimization only when every frozen turn has durable ownership. */
export function freezeConversationForkNativeSource(input: {
  readonly projection: OrchestrationV2ThreadProjection;
  readonly retainedSourceItems: ReadonlyArray<OrchestrationV2TurnItem>;
  readonly boundaryRunId: RunId | null;
  readonly sourceKind: ConversationForkSource["kind"];
}): ConversationForkNativeSourceDecision {
  const portable = (reason: string): ConversationForkNativeSourceDecision => ({
    strategy: "portable_context",
    reason,
  });
  const { projection, retainedSourceItems, boundaryRunId } = input;
  if (input.sourceKind === "running-turn") return portable("The frozen prefix cuts an active run.");
  if (
    projection.thread.historyOrigin !== undefined &&
    projection.thread.historyOrigin !== "native"
  ) {
    return portable("The frozen prefix includes imported or inherited conversation history.");
  }
  if (
    retainedSourceItems.length === 0 ||
    retainedSourceItems.some(
      (item) =>
        item.threadId !== projection.thread.id ||
        item.runId === null ||
        item.inheritedFrom !== undefined,
    )
  )
    return portable("The frozen prefix lacks native ownership for every retained item.");
  const sourceRun = projection.runs.find((run) => run.id === boundaryRunId);
  const sourceProviderThread = projection.providerThreads.find(
    (thread) => thread.id === sourceRun?.providerThreadId,
  );
  if (
    !sourceRun ||
    !sourceProviderThread ||
    sourceProviderThread.ownerNodeId !== null ||
    sourceProviderThread.appThreadId !== projection.thread.id ||
    sourceProviderThread.providerInstanceId !== sourceRun.providerInstanceId ||
    sourceProviderThread.nativeThreadRef?.strength !== "strong" ||
    sourceProviderThread.nativeThreadRef.nativeId === null ||
    sourceProviderThread.nativeThreadRef.nativeId.trim().length === 0 ||
    sourceProviderThread.nativeThreadRef.driver !== sourceProviderThread.driver
  ) {
    return portable("The frozen boundary lacks a strongly identified root provider thread.");
  }
  const retainedRunIds = new Set(retainedSourceItems.map((item) => item.runId));
  const rows = projection.visibleTurnItems.toSorted((a, b) => a.position - b.position);
  const boundaryIndex = rows.findLastIndex(({ item }) => item.runId === sourceRun.id);
  const prefix = rows.slice(0, boundaryIndex + 1);
  if (
    prefix.length !== retainedSourceItems.length ||
    prefix.some(({ item }, index) => item.id !== retainedSourceItems[index]?.id)
  ) {
    return portable("The native proof does not cover the complete frozen visible prefix.");
  }
  const retainedRuns = projection.runs
    .filter((run) => retainedRunIds.has(run.id))
    .toSorted((a, b) => a.ordinal - b.ordinal);
  if (
    retainedRuns.length !== sourceRun.ordinal ||
    !retainedRunIds.has(sourceRun.id) ||
    retainedRuns.some(
      (run, index) =>
        run.ordinal !== index + 1 ||
        run.threadId !== projection.thread.id ||
        run.status !== "completed" ||
        run.completedAt === null ||
        run.providerThreadId !== sourceProviderThread.id ||
        run.providerInstanceId !== sourceRun.providerInstanceId ||
        run.modelSelection.instanceId !== sourceRun.providerInstanceId ||
        run.rootNodeId === null ||
        run.activeAttemptId === null,
    ) ||
    retainedSourceItems.some(
      (item) => item.providerThreadId !== null && item.providerThreadId !== sourceProviderThread.id,
    )
  ) {
    return portable("The frozen prefix cannot be reproduced by one completed native conversation.");
  }
  const ownedTurns: OrchestrationV2ProviderTurn[] = [];
  const claudeBoundaryEvidence: OrchestrationV2ClaudeForkBoundaryEvidence[] = [];
  for (const run of retainedRuns) {
    const attempts = projection.attempts.filter((attempt) => attempt.runId === run.id);
    const attempt = attempts[0];
    // Native ingestion owns the reverse attempt link; the attempt's forward link
    // may stay null after its terminal receipt.
    const turns = projection.providerTurns.filter(
      (candidate) => candidate.runAttemptId === attempt?.id && candidate.nodeId === run.rootNodeId,
    );
    const turn = turns[0];
    let claudeProof: OrchestrationV2ClaudeForkBoundaryEvidence | undefined;
    if (
      sourceProviderThread.driver === "claudeAgent" &&
      turn?.nativeTurnRef?.strength === "weak" &&
      isUuid(turn.nativeTurnRef.nativeId)
    ) {
      const nativeMessageId = turn.nativeTurnRef.nativeId;
      const item = retainedSourceItems.find(
        (candidate) =>
          candidate.type === "assistant_message" &&
          candidate.runId === run.id &&
          candidate.status === "completed" &&
          !candidate.streaming &&
          candidate.parentItemId === null &&
          candidate.completedAt !== null &&
          candidate.threadId === projection.thread.id &&
          candidate.providerThreadId === sourceProviderThread.id &&
          candidate.providerTurnId === turn.id &&
          candidate.nativeItemRef?.strength === "strong" &&
          candidate.nativeItemRef.driver === "claudeAgent" &&
          candidate.nativeItemRef.nativeId === nativeMessageId,
      );
      const node = projection.nodes.find((candidate) => candidate.id === item?.nodeId);
      if (
        item &&
        node?.kind === "assistant_message" &&
        node.status === "completed" &&
        node.completedAt !== null &&
        node.threadId === projection.thread.id &&
        node.runId === run.id &&
        node.rootNodeId === run.rootNodeId &&
        node.parentNodeId === run.rootNodeId &&
        node.providerThreadId === sourceProviderThread.id &&
        node.providerTurnId === turn.id &&
        node.nativeItemRef?.strength === "strong" &&
        node.nativeItemRef.driver === "claudeAgent" &&
        node.nativeItemRef.nativeId === nativeMessageId &&
        run.rootNodeId !== null
      ) {
        claudeProof = {
          kind: "claude_root_assistant_uuid",
          sourceThreadId: projection.thread.id,
          runId: run.id,
          rootNodeId: run.rootNodeId,
          assistantNodeId: node.id,
          assistantItemId: item.id,
          providerThreadId: sourceProviderThread.id,
          providerTurnId: turn.id,
          nativeMessageId,
        };
      }
    }
    if (
      attempts.length !== 1 ||
      !attempt ||
      attempt.id !== run.activeAttemptId ||
      attempt.rootNodeId !== run.rootNodeId ||
      attempt.providerInstanceId !== sourceRun.providerInstanceId ||
      attempt.providerThreadId !== sourceProviderThread.id ||
      attempt.nativeThreadId !== sourceProviderThread.nativeThreadRef.nativeId ||
      attempt.status !== "completed" ||
      turns.length !== 1 ||
      !turn ||
      (attempt.providerTurnId !== null && attempt.providerTurnId !== turn.id) ||
      turn.runAttemptId !== attempt.id ||
      turn.nodeId !== run.rootNodeId ||
      turn.providerThreadId !== sourceProviderThread.id ||
      turn.status !== "completed" ||
      turn.completedAt === null ||
      !exactNativeBoundary(
        turn,
        sourceProviderThread.driver,
        projection.thread.id,
        sourceProviderThread.id,
        claudeProof,
      )
    ) {
      return portable(
        "A retained turn lacks an exact completed native boundary or has multiple attempts.",
      );
    }
    ownedTurns.push(turn);
    if (claudeProof) claudeBoundaryEvidence.push(claudeProof);
  }
  const boundaryTurn = ownedTurns.at(-1)!;
  const frozenRun = Schema.decodeSync(runJson)(Schema.encodeSync(runJson)(sourceRun));
  return {
    strategy: "native_fork",
    frozenSource: {
      sourceThreadId: projection.thread.id,
      driver: sourceProviderThread.driver,
      modelSelection: frozenRun.modelSelection,
      sourceRun: frozenRun,
      sourceProviderThread: Schema.decodeSync(threadJson)(
        Schema.encodeSync(threadJson)(sourceProviderThread),
      ),
      sourceProviderTurns: Schema.decodeSync(turnsJson)(Schema.encodeSync(turnsJson)(ownedTurns)),
      providerTurnId: boundaryTurn.id,
      ...(claudeBoundaryEvidence.length === 0 ? {} : { claudeBoundaryEvidence }),
    },
  };
}

/** A completed clone owns the inherited prefix even if its first local
 * turn failed. Reusing that exact native owner must recover only the
 * rejected local turn, without injecting the cloned source a second time. */
export function inheritedForkPrefixIsNative(input: {
  readonly projection: Pick<
    OrchestrationV2ThreadProjection,
    "thread" | "runs" | "contextTransfers"
  >;
  readonly activeProviderThread: OrchestrationV2ProviderThread | undefined;
  readonly targetInstanceId: ProviderInstanceId;
}): boolean {
  const { projection, activeProviderThread } = input;
  return (
    projection.thread.conversationFork != null &&
    activeProviderThread?.nativeThreadRef?.strength === "strong" &&
    !!activeProviderThread.nativeThreadRef.nativeId?.trim() &&
    activeProviderThread.providerInstanceId === input.targetInstanceId &&
    projection.contextTransfers.some((transfer) => {
      const frozen = transfer.frozenSource;
      const resolution = transfer.resolution;
      const targetRun = projection.runs.find((source) => source.id === transfer.targetRunId);
      return (
        transfer.type === "fork" &&
        transfer.status === "consumed" &&
        transfer.targetThreadId === projection.thread.id &&
        transfer.targetProviderInstanceId === activeProviderThread.providerInstanceId &&
        targetRun?.providerThreadId === activeProviderThread.id &&
        targetRun.providerInstanceId === activeProviderThread.providerInstanceId &&
        resolution?.strategy === "native_fork" &&
        resolution.providerThreadRef.strength === "strong" &&
        resolution.providerThreadRef.driver === activeProviderThread.nativeThreadRef?.driver &&
        resolution.providerThreadRef.nativeId === activeProviderThread.nativeThreadRef?.nativeId &&
        frozen !== undefined &&
        activeProviderThread.forkedFrom?.providerThreadId === frozen.sourceProviderThread.id &&
        activeProviderThread.forkedFrom.providerTurnId === frozen.providerTurnId
      );
    })
  );
}
