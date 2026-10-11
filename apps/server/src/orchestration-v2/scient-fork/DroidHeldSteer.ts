/** A Steer sent while Droid is busy is held on its run until Droid reaches a safe
 * boundary. The orchestrator binds these handlers once; each runs under its thread lock. */
import {
  CommandId,
  MessageId,
  type ChatAttachment,
  type ModelSelection,
  type OrchestrationV2AppThread,
  type OrchestrationV2Command,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ExecutionNode,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2ProviderTurn,
  type OrchestrationV2Run,
  type OrchestrationV2ServerCommand,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2TurnItem,
  type ProviderInstanceId,
  type ProviderSessionId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";

import type {
  OrchestrationEffectRequestV2,
  PendingOrchestrationEffectV2,
} from "../EffectOutbox.ts";
import type * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import type {
  OrchestratorDispatchError,
  OrchestratorProjectionError,
  OrchestratorV2Error,
  OrchestratorV2Shape,
} from "../Orchestrator.ts";
import type {
  ProjectionRecordField,
  ProjectionRecords,
  ProjectionStoreV2Shape,
} from "../ProjectionStore.ts";
import type { ProviderAdapterV2SessionRuntime } from "@t3tools/provider-core/server/ProviderAdapter";
import type { ProviderSessionManagerV2Shape } from "../ProviderSessionManager.ts";
import type { RuntimePolicyV2Shape } from "../RuntimePolicy.ts";

type HeldDroidSteer = NonNullable<OrchestrationV2Run["heldDroidSteer"]>;

type EmitEvent = <Event extends OrchestrationV2DomainEvent>(
  event: Omit<Event, "id">,
) => Effect.Effect<Event, OrchestratorDispatchError>;

type SteerProjectionField =
  | "runs"
  | "messages"
  | "providerSessions"
  | "providerThreads"
  | "providerTurns"
  | "subagents"
  | "attempts"
  | "nodes"
  | "turnItems";

/** The admitted held input, replayed through the orchestrator's ordinary steer path. */
interface AdmittedSteerInput {
  readonly command: Extract<OrchestrationV2Command, { readonly type: "message.dispatch" }>;
  readonly events: Ref.Ref<Array<OrchestrationV2DomainEvent>>;
  readonly effects: Ref.Ref<Array<PendingOrchestrationEffectV2>>;
  readonly projection: ProjectionRecords<SteerProjectionField>;
  readonly modelSelection: ModelSelection;
  readonly targetRunId: OrchestrationV2Run["id"];
  readonly messageId: OrchestrationV2ConversationMessage["id"];
  readonly text: string;
  readonly attachments: ReadonlyArray<ChatAttachment>;
  readonly context: OrchestrationV2ConversationMessage["context"];
  readonly selectedScientSkillNames: OrchestrationV2ConversationMessage["selectedScientSkillNames"];
  readonly createdBy: OrchestrationV2ConversationMessage["createdBy"];
  readonly creationSource: OrchestrationV2ConversationMessage["creationSource"];
  readonly scheduledTaskId: OrchestrationV2ConversationMessage["scheduledTaskId"];
  readonly senderThreadId: OrchestrationV2ConversationMessage["senderThreadId"];
  readonly forceRestart: boolean;
  readonly runtimeMode: OrchestrationV2Run["runtimeMode"];
  readonly interactionMode: OrchestrationV2Run["interactionMode"];
  readonly admittedDroidSteer: HeldDroidSteer;
}

/** Stop cancels the restart that would have admitted the held input. */
export const heldSteerStopCancellation = {
  effectTypes: ["provider-turn.restart"] as ReadonlyArray<OrchestrationEffectRequestV2["type"]>,
  reason: "Stop invalidated the held Droid admission.",
};

/** SCIENT: held user rows are accepted intents, not previously delivered native history.
 * Keep the source's actual input, but do not replay older or current held intents. */
export const isReplayableBesideAdmittedSteer = (
  item: OrchestrationV2TurnItem,
  admittedDroidSteer: HeldDroidSteer | undefined,
  targetRun: OrchestrationV2Run,
  rootNodeId: OrchestrationV2ExecutionNode["id"],
): boolean =>
  admittedDroidSteer === undefined ||
  item.type !== "user_message" ||
  item.runId !== targetRun.id ||
  item.nodeId !== rootNodeId ||
  (item.inputIntent !== "steer" && item.inputIntent !== "promoted_queued_to_steer") ||
  item.messageId === targetRun.userMessageId;

export const makeDroidHeldSteer = ({
  DispatchError,
  idAllocator,
  projectionStore,
  providerSessions,
  runtimePolicy,
  emit,
  mapDispatchError,
  nextTurnItemOrdinal,
  loadProjectionForCommand,
  dispatchSteerIntoRun,
  dispatchWithReceipt,
}: {
  readonly DispatchError: typeof OrchestratorDispatchError;
  readonly idAllocator: Pick<IdAllocator.IdAllocatorV2["Service"], "derive">;
  readonly projectionStore: Pick<ProjectionStoreV2Shape, "getThreadRecords">;
  readonly providerSessions: Pick<ProviderSessionManagerV2Shape, "get">;
  readonly runtimePolicy: Pick<RuntimePolicyV2Shape, "resolve">;
  readonly emit: (
    events: Ref.Ref<Array<OrchestrationV2DomainEvent>>,
    command: OrchestrationV2ServerCommand,
  ) => EmitEvent;
  readonly mapDispatchError: (
    command: OrchestrationV2ServerCommand,
  ) => <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, OrchestratorDispatchError, R>;
  readonly nextTurnItemOrdinal: (
    projection: Pick<OrchestrationV2ThreadProjection, "thread"> &
      Partial<Pick<OrchestrationV2ThreadProjection, "turnItems">>,
  ) => Effect.Effect<number, OrchestratorProjectionError>;
  readonly loadProjectionForCommand: <K extends ProjectionRecordField>(
    command: OrchestrationV2ServerCommand,
    fields: ReadonlyArray<K>,
  ) => Effect.Effect<ProjectionRecords<K>, OrchestratorProjectionError>;
  readonly dispatchSteerIntoRun: (
    input: AdmittedSteerInput,
  ) => Effect.Effect<void, OrchestratorV2Error>;
  readonly dispatchWithReceipt: OrchestratorV2Shape["dispatch"];
}) => {
  // SCIENT-FORK:START — terminal drop is visible without fabricating a provider failure or ACK.
  const emitDroidSteerDropped = (
    command: OrchestrationV2ServerCommand,
    events: Ref.Ref<Array<OrchestrationV2DomainEvent>>,
    run: OrchestrationV2Run,
    held: NonNullable<OrchestrationV2Run["heldDroidSteer"]>,
    projection: Pick<OrchestrationV2ThreadProjection, "thread" | "turnItems">,
  ) =>
    Effect.gen(function* () {
      const now = yield* DateTime.now;
      yield* emit(
        events,
        command,
      )({
        type: "turn-item.updated",
        threadId: run.threadId,
        runId: run.id,
        nodeId: held.sourceRootNodeId,
        providerInstanceId: run.providerInstanceId,
        occurredAt: now,
        payload: {
          id: idAllocator.derive.userTurnItem({
            messageId: MessageId.make(`droid-not-delivered:${held.revision}`),
          }),
          threadId: run.threadId,
          runId: run.id,
          nodeId: held.sourceRootNodeId,
          providerThreadId: run.providerThreadId,
          providerTurnId: held.sourceProviderTurnId,
          nativeItemRef: null,
          parentItemId: null,
          ordinal: yield* nextTurnItemOrdinal(projection),
          status: "completed",
          title: null,
          startedAt: now,
          completedAt: now,
          updatedAt: now,
          type: "system_notice",
          message: "Your waiting message was not delivered. Send it again to continue.",
          createdBy: "system",
          creationSource: "server",
        },
      });
    });
  // SCIENT-FORK:END

  // SCIENT-FORK:START — thread lock + canonical revision precede all external interruption.
  const dispatchDroidSteerAdmission = (
    command: Extract<OrchestrationV2ServerCommand, { readonly type: "droid-steer.admission" }>,
    events: Ref.Ref<Array<OrchestrationV2DomainEvent>>,
    effects: Ref.Ref<Array<PendingOrchestrationEffectV2>>,
  ) =>
    Effect.gen(function* () {
      const projection = yield* loadProjectionForCommand(command, [
        "runs",
        "messages",
        "providerSessions",
        "providerThreads",
        "providerTurns",
        "subagents",
        "attempts",
        "nodes",
        "turnItems",
      ]);
      const run = projection.runs.find((run) => run.id === command.runId);
      const held = run?.heldDroidSteer;
      if (
        run === undefined ||
        held?.revision !== command.revision ||
        run.activeAttemptId !== held.sourceAttemptId ||
        run.rootNodeId !== held.sourceRootNodeId ||
        run.status !== "running"
      )
        return;
      const sessionOption = yield* providerSessions
        .get(held.sourceProviderSessionId)
        .pipe(mapDispatchError(command));
      const session = Option.getOrUndefined(sessionOption);
      if (command.operation === "complete") {
        if (
          held.phase !== "pre_admission" ||
          command.lease === undefined ||
          held.admissionLease !== command.lease ||
          session?.droidSteerConsumed?.(command.lease) !== true
        )
          return yield* new DispatchError({
            commandId: command.commandId,
            commandType: command.type,
            cause: "Droid completion has no consumed live reservation.",
          });
        const message = projection.messages.find((message) => message.id === held.messageId);
        if (message === undefined)
          return yield* new DispatchError({
            commandId: command.commandId,
            commandType: command.type,
            cause: "Held Droid input is missing.",
          });
        yield* dispatchSteerIntoRun({
          command: {
            type: "message.dispatch",
            commandId: command.commandId,
            threadId: command.threadId,
            messageId: message.id,
            text: message.text,
            attachments: message.attachments,
            dispatchMode: { type: "steer_active", targetRunId: run.id },
            modelSelection: held.modelSelection,
            runtimeMode: held.runtimePolicy.runtimeMode,
            interactionMode: held.runtimePolicy.interactionMode,
            createdBy: message.createdBy,
            creationSource: message.creationSource,
          },
          events,
          effects,
          projection,
          modelSelection: held.modelSelection,
          targetRunId: run.id,
          messageId: message.id,
          text: message.text,
          attachments: message.attachments,
          context: message.context,
          selectedScientSkillNames: message.selectedScientSkillNames,
          createdBy: message.createdBy,
          creationSource: message.creationSource,
          scheduledTaskId: message.scheduledTaskId,
          senderThreadId: message.senderThreadId,
          forceRestart: true,
          runtimeMode: held.runtimePolicy.runtimeMode,
          interactionMode: held.runtimePolicy.interactionMode,
          admittedDroidSteer: held,
        });
        return;
      }
      if (
        command.operation === "claim" &&
        (held.phase !== "held" ||
          command.lease === undefined ||
          session?.validateDroidSteer?.(command.lease) !== true)
      )
        return yield* new DispatchError({
          commandId: command.commandId,
          commandType: command.type,
          cause: "Droid admission lost its live reservation.",
        });
      if (command.operation === "drop") {
        session?.invalidateDroidSteer?.();
        yield* emitDroidSteerDropped(command, events, run, held, projection);
      }
      const now = yield* DateTime.now;
      yield* emit(
        events,
        command,
      )({
        type: "run.updated",
        threadId: command.threadId,
        runId: run.id,
        nodeId: run.rootNodeId,
        providerInstanceId: run.providerInstanceId,
        occurredAt: now,
        payload: {
          ...run,
          heldDroidSteer:
            command.operation === "drop"
              ? undefined
              : {
                  ...held,
                  phase: command.operation === "claim" ? "pre_admission" : "held",
                  admissionLease: command.operation === "claim" ? command.lease : undefined,
                },
        },
      });
    });
  // SCIENT-FORK:END

  // SCIENT-FORK:START — accepted intent does not supersede a busy native owner.
  /** Hold a Steer for a busy Droid turn: record the intent on the run, show the waiting
   * notice once, append the steering message, and ask Droid to restart at a safe boundary. */
  const holdDroidSteer = (
    input: {
      readonly command: Extract<
        OrchestrationV2Command,
        { readonly type: "message.dispatch" | "queued-message.promote-to-steer" }
      >;
      readonly effects: Ref.Ref<Array<PendingOrchestrationEffectV2>>;
      readonly projection: Pick<OrchestrationV2ThreadProjection, "thread" | "turnItems">;
      readonly modelSelection: ModelSelection;
      readonly messageId: OrchestrationV2ConversationMessage["id"];
    },
    steer: {
      readonly targetRun: OrchestrationV2Run;
      readonly rootNodeId: OrchestrationV2ExecutionNode["id"];
      readonly providerThread: OrchestrationV2ProviderThread;
      readonly providerSessionId: ProviderSessionId;
      readonly providerTurn: OrchestrationV2ProviderTurn;
      readonly session: ProviderAdapterV2SessionRuntime;
      readonly executionThread: OrchestrationV2AppThread;
      readonly now: DateTime.Utc;
      readonly emitEvent: EmitEvent;
      readonly appendSteeringMessage: (messageInput: {
        readonly runId: OrchestrationV2Run["id"];
        readonly nodeId: OrchestrationV2ExecutionNode["id"];
        readonly providerTurnId: OrchestrationV2ProviderTurn["id"] | null;
        readonly providerThreadId: OrchestrationV2ProviderThread["id"];
        readonly providerInstanceId: ProviderInstanceId;
      }) => Effect.Effect<void, OrchestratorDispatchError | OrchestratorProjectionError>;
    },
  ) =>
    Effect.gen(function* () {
      const {
        targetRun,
        rootNodeId,
        providerThread,
        providerSessionId,
        providerTurn,
        session,
        executionThread,
        now,
        emitEvent,
        appendSteeringMessage,
      } = steer;
      if (targetRun.activeAttemptId === null || session.reserveDroidSteer === undefined)
        return yield* new DispatchError({
          commandId: input.command.commandId,
          commandType: input.command.type,
          cause: "Droid has no live held-Steer owner.",
        });
      if (session.droidSteerConsumed?.() === true)
        return yield* new DispatchError({
          commandId: input.command.commandId,
          commandType: input.command.type,
          cause: "The prior Droid Steer has already entered native admission.",
        });
      session.invalidateDroidSteer?.();
      const policy = yield* runtimePolicy
        .resolve({ thread: executionThread, modelSelection: input.modelSelection })
        .pipe(mapDispatchError(input.command));
      const held: NonNullable<OrchestrationV2Run["heldDroidSteer"]> = {
        revision: input.command.commandId,
        messageId: input.messageId,
        sourceAttemptId: targetRun.activeAttemptId,
        sourceRootNodeId: rootNodeId,
        sourceProviderTurnId: providerTurn.id,
        sourceProviderSessionId: providerSessionId,
        modelSelection: input.modelSelection,
        runtimePolicy: {
          ...policy,
          cwd: policy.cwd ?? executionThread.worktreePath ?? session.providerSession.cwd,
        },
        phase: "held",
      };
      const readHeld = projectionStore.getThreadRecords(input.command.threadId, ["runs"]).pipe(
        Effect.map(
          (p) =>
            p.runs.find(
              (run) => run.id === targetRun.id && run.activeAttemptId === held.sourceAttemptId,
            )?.heldDroidSteer,
        ),
        Effect.orDie,
      );
      yield* (
        session.configureDroidSteerOwner?.({
          attemptId: held.sourceAttemptId,
          held: readHeld.pipe(Effect.map((intent) => intent !== undefined)),
          drop: readHeld.pipe(
            Effect.flatMap((intent) =>
              intent === undefined
                ? Effect.void
                : dispatchWithReceipt({
                    type: "droid-steer.admission",
                    commandId: CommandId.make(`droid-drop:${intent.revision}`),
                    threadId: input.command.threadId,
                    runId: targetRun.id,
                    revision: intent.revision,
                    operation: "drop",
                  }).pipe(Effect.asVoid, Effect.orDie),
            ),
          ),
        }) ?? Effect.void
      );
      if (
        !input.projection.turnItems.some(
          (item) =>
            item.runId === targetRun.id &&
            item.type === "system_notice" &&
            item.message === "Follow-up held until Droid reaches a safe boundary.",
        )
      ) {
        yield* emitEvent({
          type: "turn-item.updated",
          threadId: input.command.threadId,
          runId: targetRun.id,
          nodeId: rootNodeId,
          providerInstanceId: targetRun.providerInstanceId,
          occurredAt: now,
          payload: {
            id: idAllocator.derive.turnItemFromProviderItem({
              driver: session.driver,
              nativeItemId: `held-steer:${targetRun.id}`,
            }),
            threadId: input.command.threadId,
            runId: targetRun.id,
            nodeId: rootNodeId,
            providerThreadId: providerThread.id,
            providerTurnId: providerTurn.id,
            nativeItemRef: null,
            parentItemId: null,
            ordinal: (yield* nextTurnItemOrdinal(input.projection)) + 1,
            status: "completed",
            title: null,
            startedAt: now,
            completedAt: now,
            updatedAt: now,
            type: "system_notice",
            message: "Follow-up held until Droid reaches a safe boundary.",
            createdBy: "system",
            creationSource: "server",
          },
        });
      }
      yield* appendSteeringMessage({
        runId: targetRun.id,
        nodeId: rootNodeId,
        providerTurnId: providerTurn.id,
        providerThreadId: providerThread.id,
        providerInstanceId: targetRun.providerInstanceId,
      });
      yield* emitEvent({
        type: "run.updated",
        threadId: input.command.threadId,
        runId: targetRun.id,
        nodeId: rootNodeId,
        providerInstanceId: targetRun.providerInstanceId,
        occurredAt: now,
        payload: { ...targetRun, heldDroidSteer: held },
      });
      yield* Ref.update(input.effects, (existing) => [
        ...existing,
        {
          id: `effect:${input.command.commandId}:droid-held-steer:${providerTurn.id}`,
          commandId: input.command.commandId,
          threadId: input.command.threadId,
          request: {
            type: "provider-turn.restart",
            providerSessionId,
            providerThreadId: providerThread.id,
            providerTurnId: providerTurn.id,
            interruptedAttemptId: held.sourceAttemptId,
            runId: targetRun.id,
          },
        } satisfies PendingOrchestrationEffectV2,
      ]);
    });
  // SCIENT-FORK:END

  // SCIENT: Stop invalidates the private lease before canonical cancellation can race native consumption.
  /** Returns the run without its held intent, after recording the drop. */
  const dropHeldSteerOnStop = (
    command: Extract<OrchestrationV2Command, { readonly type: "run.interrupt" }>,
    events: Ref.Ref<Array<OrchestrationV2DomainEvent>>,
    run: OrchestrationV2Run,
    held: HeldDroidSteer,
    rootNodeId: OrchestrationV2ExecutionNode["id"],
    projection: Pick<OrchestrationV2ThreadProjection, "thread" | "turnItems">,
    now: DateTime.Utc,
  ) =>
    Effect.gen(function* () {
      const owner = yield* providerSessions
        .get(held.sourceProviderSessionId)
        .pipe(mapDispatchError(command));
      if (Option.isSome(owner)) owner.value.invalidateDroidSteer?.();
      yield* emitDroidSteerDropped(command, events, run, held, projection);
      const released: OrchestrationV2Run = { ...run, heldDroidSteer: undefined };
      yield* emit(
        events,
        command,
      )({
        type: "run.updated",
        threadId: command.threadId,
        runId: released.id,
        nodeId: rootNodeId,
        providerInstanceId: released.providerInstanceId,
        occurredAt: now,
        payload: released,
      });
      return released;
    });

  return {
    emitDroidSteerDropped,
    dispatchDroidSteerAdmission,
    holdDroidSteer,
    dropHeldSteerOnStop,
  };
};
