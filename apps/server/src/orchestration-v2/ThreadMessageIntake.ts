import { remapComposerContextAttachments } from "@t3tools/shared/composerContextReferences";
import { appendUserInputAttachmentPaths } from "../provider/userInputAttachments.ts";
import { CommandId, type ChatAttachment, type OrchestrationV2Command } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { resolveAttachmentPath } from "../attachmentStore.ts";
import * as ServerConfig from "../config.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectCloneTracker from "../project/ProjectCloneTracker.ts";

import * as AttachmentClaims from "./AttachmentClaims.ts";
import * as ThreadLaunch from "./ThreadLaunchService.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";
import { reconcileReservationsBestEffort } from "./AttachmentReservationReconciliation.ts";

// These dispatcher failures occur in receipt validation or planning, before
// commitCommand. Generic dispatch errors can follow a commit and remain uncertain.
function dispatchWasNotAccepted(
  error: Orchestrator.OrchestratorV2Error | ThreadManagement.ThreadManagementError,
) {
  switch (error._tag) {
    case "OrchestratorCommandRejectedError":
    case "OrchestratorProjectionError":
    case "OrchestratorProviderAdapterError":
    case "OrchestratorCommandPreviouslyRejectedError":
    case "OrchestratorCommandIdConflictError":
    case "OrchestratorSubagentThreadReadOnlyError":
      return true;
    default:
      return false;
  }
}
const isOrchestratorError = Schema.is(Orchestrator.OrchestratorV2Error);

// SCIENT-FORK:START — the queued/sent admission receipt lives in scient-fork.
export { dispatchCommandReceipt } from "./scient-fork/MessageAdmissionReceipt.ts";
// SCIENT-FORK:END

const releaseUnusedClaims = Effect.fn("ThreadMessageIntake.releaseUnusedClaims")(function* (
  claimedPaths: ReadonlyArray<string>,
  accepted: ReadonlyArray<ChatAttachment>,
) {
  if (claimedPaths.length === 0) return;
  const config = yield* ServerConfig.ServerConfig;
  const retained = new Set(
    accepted.map((attachment) =>
      resolveAttachmentPath({
        attachmentsDir: config.attachmentsDir,
        attachment,
      }),
    ),
  );
  yield* AttachmentClaims.releaseClaimedAttachments(
    claimedPaths.filter((path) => !retained.has(path)),
  );
});

export const dispatchCommand = Effect.fn("ThreadMessageIntake.dispatchCommand")(function* (
  command: OrchestrationV2Command,
) {
  const threads = yield* ThreadManagement.ThreadManagementService;
  if (command.type === "thread.create" || command.type === "message.dispatch") {
    const projectId =
      command.type === "thread.create"
        ? command.projectId
        : (yield* threads.getThreadShell(command.threadId))?.projectId;
    if (projectId !== undefined) {
      const tracker = yield* ProjectCloneTracker.ProjectCloneTracker;
      yield* ProjectCloneTracker.rejectCommandsDuringClone(tracker, {
        type: "thread.create",
        projectId,
      }).pipe(
        Effect.mapError(
          (cause) =>
            new Orchestrator.OrchestratorCommandRejectedError({
              commandId: command.commandId,
              commandType: command.type,
              cause,
            }),
        ),
      );
    }
  }
  if (command.type === "runtime-request.respond" && command.attachmentsByQuestionId) {
    const config = yield* ServerConfig.ServerConfig;
    const incomingByQuestionId = command.attachmentsByQuestionId;
    yield* AttachmentClaims.validateAttachmentLimits(Object.values(incomingByQuestionId).flat());
    if (
      Object.values(incomingByQuestionId)
        .flat()
        .some((attachment) => !AttachmentClaims.attachmentIsPendingUpload(attachment))
    ) {
      return yield* new AttachmentClaims.AttachmentClaimError({
        message: "Question attachment must be a pending upload.",
      });
    }
    // Claims accumulate across questions, so all of preparation shares one
    // rollback boundary: any failure before dispatch removes every new copy.
    const claimedPaths: string[] = [];
    const pinReleases: Array<Effect.Effect<void>> = [];
    const claims: AttachmentClaims.ClaimedAttachments[] = [];
    const releasePins = Effect.suspend(() =>
      Effect.forEach(pinReleases, (release) => release, { discard: true }),
    );
    const prepared = yield* Effect.gen(function* () {
      const attachmentsByQuestionId: import("@t3tools/contracts").UserInputAttachments = {};
      for (const [questionId, attachments] of Object.entries(incomingByQuestionId)) {
        const claimed = yield* AttachmentClaims.claimPendingAttachments({
          threadId: command.threadId,
          attachments,
        });
        claimedPaths.push(...claimed.claimedPaths);
        pinReleases.push(claimed.releasePins);
        claims.push(claimed);
        Object.defineProperty(attachmentsByQuestionId, questionId, {
          value: claimed.attachments,
          enumerable: true,
        });
      }
      const answers = yield* appendUserInputAttachmentPaths({
        answers: command.answers ?? {},
        attachmentsByQuestionId,
        attachmentsDir: config.attachmentsDir,
      }).pipe(
        Effect.mapError(
          (cause) => new AttachmentClaims.AttachmentClaimError({ message: cause.issue }),
        ),
      );
      yield* Effect.forEach(
        claims,
        (claim) =>
          claim.bindReceipt({
            kind: "command",
            threadId: command.threadId,
            commandId: command.commandId,
            commandType: command.type,
            target: { type: "question", requestId: command.requestId },
          }),
        { discard: true },
      );
      return { answers, attachmentsByQuestionId };
    }).pipe(
      Effect.onError(() =>
        AttachmentClaims.releaseClaimedAttachments(claimedPaths).pipe(Effect.andThen(releasePins)),
      ),
    );
    return yield* threads
      .dispatch({
        ...command,
        answers: prepared.answers,
        attachmentsByQuestionId: prepared.attachmentsByQuestionId,
      })
      .pipe(
        Effect.onExit(() =>
          reconcileReservationsBestEffort(
            claims.flatMap((claim) => claim.attachments.map((a) => a.id)),
          ),
        ),
        Effect.tap((result) => {
          // A replayed receipt reports the first attempt's answer, so this
          // attempt's copies go unreferenced and are released. The resolved
          // turn item proves the respond was applied; questionAnswer is only
          // recorded when the accepted command carried attachments, so its
          // absence means the accepted answer referenced no copies. With no
          // resolved item at all the outcome is ambiguous and everything stays.
          const answeredItems = result.storedEvents.flatMap(({ event }) =>
            event.type === "turn-item.updated" &&
            event.payload.type === "user_input_request" &&
            event.payload.requestId === command.requestId
              ? [event.payload]
              : [],
          );
          return answeredItems.length > 0
            ? releaseUnusedClaims(
                claimedPaths,
                answeredItems.flatMap((item) =>
                  item.questionAnswer === undefined
                    ? []
                    : Object.values(item.questionAnswer.attachmentsByQuestionId).flat(),
                ),
              ).pipe(Effect.andThen(releasePins))
            : Effect.void;
        }),
        Effect.tapError((error) =>
          dispatchWasNotAccepted(error)
            ? AttachmentClaims.releaseClaimedAttachments(claimedPaths).pipe(
                Effect.andThen(releasePins),
              )
            : Effect.void,
        ),
      );
  }
  if (
    command.type !== "message.dispatch" &&
    (command.type !== "queued-run.edit" || command.attachments === undefined)
  )
    return yield* threads.dispatch(command);
  const claimed = yield* AttachmentClaims.claimPendingAttachments({
    threadId: command.threadId,
    attachments: command.attachments ?? [],
  });
  yield* claimed.bindReceipt({
    kind: "command",
    threadId: command.threadId,
    commandId: command.commandId,
    commandType: command.type,
    target:
      command.type === "message.dispatch"
        ? { type: "message", messageId: command.messageId }
        : { type: "run", runId: command.runId },
  });
  return yield* threads
    .dispatch({
      ...command,
      attachments: claimed.attachments,
      ...(command.context
        ? {
            context: remapComposerContextAttachments(
              command.context,
              command.attachments ?? [],
              claimed.attachments,
            ),
          }
        : {}),
    })
    .pipe(
      Effect.onExit(() => reconcileReservationsBestEffort(claimed.attachments.map((a) => a.id))),
      Effect.tap((result) =>
        releaseUnusedClaims(
          claimed.claimedPaths,
          result.storedEvents.flatMap(({ event }) =>
            event.type === "message.updated" ? event.payload.attachments : [],
          ),
        ).pipe(
          Effect.andThen(
            result.storedEvents.some(({ event }) => event.type === "message.updated")
              ? claimed.releasePins
              : Effect.void,
          ),
        ),
      ),
      Effect.tapError((error) =>
        dispatchWasNotAccepted(error)
          ? AttachmentClaims.releaseClaimedAttachments(claimed.claimedPaths).pipe(
              Effect.andThen(claimed.releasePins),
            )
          : Effect.void,
      ),
    );
});

export const sendToThread = Effect.fn("ThreadMessageIntake.sendToThread")(function* (
  input: ThreadManagement.ThreadManagementSendInput,
) {
  const threads = yield* ThreadManagement.ThreadManagementService;
  const claimed = yield* AttachmentClaims.claimPendingAttachments(input);
  yield* claimed.bindReceipt({
    kind: "command",
    threadId: input.threadId,
    commandId: input.commandId,
    commandType: "message.dispatch",
    target: { type: "message", messageId: input.messageId },
  });
  return yield* threads.sendToThread({ ...input, attachments: claimed.attachments }).pipe(
    Effect.onExit(() => reconcileReservationsBestEffort(claimed.attachments.map((a) => a.id))),
    Effect.tap((result) =>
      releaseUnusedClaims(claimed.claimedPaths, result.message.attachments).pipe(
        Effect.andThen(claimed.releasePins),
      ),
    ),
    Effect.tapError((error) =>
      dispatchWasNotAccepted(error)
        ? AttachmentClaims.releaseClaimedAttachments(claimed.claimedPaths).pipe(
            Effect.andThen(claimed.releasePins),
          )
        : Effect.void,
    ),
  );
});

export const launchThread = Effect.fn("ThreadMessageIntake.launchThread")(function* (
  input: ThreadLaunch.ThreadLaunchInput,
) {
  const launches = yield* ThreadLaunch.ThreadLaunchService;
  const tracker = yield* ProjectCloneTracker.ProjectCloneTracker;
  yield* ProjectCloneTracker.rejectCommandsDuringClone(tracker, {
    type: "thread.create",
    projectId: input.projectId,
  }).pipe(
    Effect.mapError(
      (cause) =>
        new ThreadLaunch.ThreadLaunchError({
          operation: "resolve-project",
          commandId: input.commandId,
          projectId: input.projectId,
          cause,
        }),
    ),
  );
  yield* AttachmentClaims.validateAttachmentLimits(input.initialMessage?.attachments ?? []);
  if (!input.initialMessage?.attachments.length) {
    return yield* launches.launch(input);
  }
  if (input.threadId === undefined) {
    return yield* new AttachmentClaims.AttachmentClaimError({
      message: "Uploaded attachments need a thread id at launch.",
    });
  }
  const claimed = yield* AttachmentClaims.claimPendingAttachments({
    threadId: input.threadId,
    attachments: input.initialMessage.attachments,
  });
  yield* claimed.bindReceipt({
    kind: "command",
    threadId: input.threadId,
    commandId: CommandId.make(`${input.commandId}:initial-message`),
    commandType: "message.dispatch",
    target:
      input.initialMessage.messageId === undefined
        ? { type: "initial-message" }
        : { type: "message", messageId: input.initialMessage.messageId },
  });
  return yield* launches
    .launch({
      ...input,
      initialMessage: {
        ...input.initialMessage,
        attachments: claimed.attachments,
        ...(input.initialMessage.context
          ? {
              context: remapComposerContextAttachments(
                input.initialMessage.context,
                input.initialMessage.attachments,
                claimed.attachments,
              ),
            }
          : {}),
      },
    })
    .pipe(
      Effect.onExit(() => reconcileReservationsBestEffort(claimed.attachments.map((a) => a.id))),
      Effect.tap((result) =>
        releaseUnusedClaims(
          claimed.claimedPaths,
          result.projection.messages.flatMap((message) => message.attachments),
        ).pipe(Effect.andThen(claimed.releasePins)),
      ),
      Effect.tapError((error) => {
        // Project/receipt reads precede message dispatch. The create-thread error
        // also wraps post-message projection reads, so its tag alone is not proof.
        const notAccepted =
          error.operation === "resolve-project" ||
          error.operation === "read-receipt" ||
          ((error.operation === "create-thread" || error.operation === "dispatch-message") &&
            isOrchestratorError(error.cause) &&
            // Projection errors under create-thread can occur after the message commit.
            (error.operation !== "create-thread" ||
              error.cause._tag !== "OrchestratorProjectionError") &&
            dispatchWasNotAccepted(error.cause));
        return notAccepted
          ? AttachmentClaims.releaseClaimedAttachments(claimed.claimedPaths).pipe(
              Effect.andThen(claimed.releasePins),
            )
          : Effect.void;
      }),
    );
});
