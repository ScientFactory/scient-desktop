import {
  FORK_CHECKPOINT_OWNERSHIP_OPERATION,
  makeForkCheckpointOwnership,
} from "./ForkCheckpointOwnership.ts";
import { CheckpointPublicationWitness } from "../../vcs/ScientCheckpointCapture.ts";
import { AttachmentFileArbitration } from "../AttachmentFileUse.ts";
import { ProviderSessionManagerV2 } from "../ProviderSessionManager.ts";
import {
  ProviderTextSnapshotError,
  type CapturedProviderText,
} from "@t3tools/provider-core/server/ProviderAdapter";
import {
  type CheckpointRef,
  type CommandId,
  EventId,
  OrchestrationDispatchCommandError,
  type ForkOptions,
  type ForkReadiness,
  type GetForkOptionsInput,
  type OrchestrationV2AppThread,
  type OrchestrationV2Command,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ThreadProjection,
  type RunId,
  type ScientConversationFork,
  type ScientThreadForkBoundary,
  ThreadId,
  VcsCheckpointUnavailableError,
  VcsError,
  VcsProcessTimeoutError,
} from "@t3tools/contracts";
import { deriveForkTitle } from "@t3tools/shared/scientForkTitle";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";
import { writeConversationFork } from "./ConversationForkRecords.ts";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import { GitWorkflowService } from "../../git/GitWorkflowService.ts";
import { CommandReceiptStoreV2 } from "../CommandReceiptStore.ts";
import { EventSinkV2 } from "../EventSink.ts";
import * as KeyedLock from "@t3tools/shared/KeyedLock";
import { ProjectionStoreV2 } from "../ProjectionStore.ts";
import { ProjectStoreV2 } from "../ProjectStore.ts";
import { ThreadCommandExecutor } from "../ThreadCommandExecutor.ts";
import { randomUuidV4 } from "@t3tools/provider-core/server/randomUuid";
import { LegacyV1ThreadImporter } from "../legacy/LegacyV1ThreadImporter.ts";
import {
  checkpointRefForThreadTurn,
  ScientForkCheckpointBaseline,
} from "./ForkCheckpointBaseline.ts";
import {
  planConversationFork,
  ConversationForkPlanError,
  type ConversationForkSource,
} from "./ConversationForkPlan.ts";
import { makeRunningTurnFork } from "./RunningTurnFork.ts";
import {
  freezeConversationForkNativeSource,
  type ConversationForkNativeSourceDecision,
} from "./ConversationForkNativeSource.ts";

export type ThreadForkV2Command = Extract<OrchestrationV2Command, { readonly type: "thread.fork" }>;

/** Where a fork stops: Scient's boundary, or the settled run T3's source point names. */
export type ConversationForkBoundary =
  | ScientThreadForkBoundary
  | { readonly kind: "settled-run"; readonly runId: RunId };

/** What a fork freezes before T3's builder makes its thread: the plan, workspace and proof. */
export interface ConversationForkAdmission {
  readonly projection: OrchestrationV2ThreadProjection;
  readonly source: ConversationForkSource;
  readonly plan: Effect.Success<ReturnType<typeof planConversationFork>>;
  readonly markerSource:
    | { readonly type: "run"; readonly threadId: ThreadId; readonly runId: RunId }
    | {
        readonly type: "message";
        readonly threadId: ThreadId;
        readonly messageId: Extract<ConversationForkSource, { kind: "user-message" }>["messageId"];
        readonly position: "before" | "after";
      };
  readonly workspaceMode: "local" | "new-worktree";
  readonly cwd: string;
  readonly inProjectFolder: boolean;
  readonly projectRoot: string;
  /** False when a mobile or MCP fork works in T3's folder without a project folder. */
  readonly workspaceVerified: boolean;
  readonly checkpointRef: CheckpointRef | null;
  readonly checkpointOid: string | null;
  readonly nativeSource: ConversationForkNativeSourceDecision;
}

/** The final events a fork commits, with the live capture its commit must recheck. */
export interface ConversationForkCommitInput {
  readonly events: ReadonlyArray<OrchestrationV2DomainEvent>;
  readonly conversationFork: ScientConversationFork;
  readonly runningForkSource?: {
    readonly owner: CapturedProviderText["owner"];
    readonly capture: CapturedProviderText;
  };
}

export class ConversationForkService extends Context.Service<
  ConversationForkService,
  {
    /** Freezes a fork's prefix and workspace under the source and destination locks. */
    readonly admit: (input: {
      readonly command: ThreadForkV2Command;
      readonly boundary: ConversationForkBoundary;
      readonly sourceProjection: OrchestrationV2ThreadProjection;
      readonly fallbackCwd?: string;
    }) => Effect.Effect<ConversationForkAdmission, OrchestrationDispatchCommandError, Scope.Scope>;
    /** Commits a fork under its title allocation, its folder check and any live capture. */
    readonly commit: <A, E, R>(input: {
      readonly command: ThreadForkV2Command;
      readonly admission: ConversationForkAdmission;
      readonly capture: CapturedProviderText | null;
      readonly events: ReadonlyArray<OrchestrationV2DomainEvent>;
      readonly conversationFork: ScientConversationFork;
      readonly commit: (input: ConversationForkCommitInput) => Effect.Effect<A, E, R>;
    }) => Effect.Effect<A, E | OrchestrationDispatchCommandError | ProviderTextSnapshotError, R>;
    /** Runs a fork with the running turn's unsaved text, or with saved history when it cannot. */
    readonly withRunningCapture: <A, E, R>(
      command: ThreadForkV2Command,
      attempt: (capture: CapturedProviderText | null) => Effect.Effect<A, E, R>,
    ) => Effect.Effect<A, E, R>;
    /** A repeated fork command schedules a failed worktree setup again. */
    readonly retryFailedSetup: (
      threadId: ThreadId,
      commandId: CommandId,
    ) => Effect.Effect<void, OrchestrationDispatchCommandError>;
    readonly awaitReady: (
      threadId: ThreadId,
    ) => Effect.Effect<ForkReadiness, OrchestrationDispatchCommandError>;
    readonly getOptions: (
      input: GetForkOptionsInput,
    ) => Effect.Effect<ForkOptions, OrchestrationDispatchCommandError>;
    readonly provision: (
      threadId: ThreadId,
      willRetry: boolean,
    ) => Effect.Effect<void, OrchestrationDispatchCommandError>;
  }
>()("t3/orchestration-v2/scient-fork/ConversationForkService") {}

const isCheckpointUnavailable = Schema.is(VcsCheckpointUnavailableError);
const isSnapshotTimeout = Schema.is(VcsProcessTimeoutError);
const isVcsError = Schema.is(VcsError);
const snapshotFailure = (cause: unknown) => {
  let message = "Unable to freeze this workspace checkpoint. Retry the fork.";
  // Ownership-journal failures are not about the user's files.
  if (isCheckpointUnavailable(cause) && cause.operation !== FORK_CHECKPOINT_OWNERSHIP_OPERATION) {
    if (cause.reason === "size-limit" || cause.reason === "path-limit")
      message =
        "This workspace exceeds the snapshot limits. Fork without a new worktree, or reduce the files included.";
    else if (cause.reason === "unsupported-file")
      message =
        "A special file prevents this workspace snapshot. Fork without a new worktree, or remove it from the snapshot.";
    else message = "A workspace file could not be read. Retry the fork when files are available.";
  } else if (isSnapshotTimeout(cause))
    message =
      "The workspace snapshot timed out. Fork without a new worktree, or reduce the files included.";
  return new OrchestrationDispatchCommandError({ message, forkDisposition: "rejected" });
};

const isDispatchError = Schema.is(OrchestrationDispatchCommandError);
const isPlanError = Schema.is(ConversationForkPlanError);
const isAbandonedFailure = (cause: unknown) =>
  isDispatchError(cause) && cause.forkDisposition === "abandoned";

const failure = (
  message: string,
  forkDisposition: "rejected" | "failed" | "abandoned" = "rejected",
) => new OrchestrationDispatchCommandError({ message, forkDisposition });

// VCS errors carry workspace paths and Git output; those stay in server logs.
const withoutVcsDiagnostics = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.tapError((cause) =>
      isVcsError(cause) ? Effect.logWarning("Fork Git operation failed", { cause }) : Effect.void,
    ),
    Effect.mapError((cause) =>
      isVcsError(cause)
        ? failure("Unable to read this workspace's Git history. Retry the fork.")
        : cause,
    ),
  );

const make = Effect.gen(function* () {
  const snapshots = yield* Effect.serviceOption(ProviderSessionManagerV2);
  const attachmentArbitration = yield* AttachmentFileArbitration;
  const projections = yield* ProjectionStoreV2;
  const projects = yield* ProjectStoreV2;
  const receipts = yield* CommandReceiptStoreV2;
  const sink = yield* EventSinkV2;
  const executor = yield* ThreadCommandExecutor;
  const titles = yield* KeyedLock.make<string>();
  const baseline = yield* ScientForkCheckpointBaseline;
  const git = yield* GitWorkflowService;
  const legacyImporter = yield* LegacyV1ThreadImporter;
  const checkpointOwnership = yield* makeForkCheckpointOwnership;
  const sql = yield* SqlClient.SqlClient;
  /** Records a fork's new setup state in the same transaction as its event. */
  const withForkRecord = (threadId: ThreadId, fork: ScientConversationFork) => ({
    transactionHooks: {
      prepare: Effect.void,
      finalize: writeConversationFork(sql, threadId, fork),
    },
  });
  // Attempts own unique refs and recovery skips active ones, so it can run
  // beside new forks instead of delaying server startup.
  yield* checkpointOwnership.recover().pipe(Effect.forkScoped);

  const resolveSource = Effect.fn("ConversationForkService.resolveSource")(function* (
    projection: Pick<
      OrchestrationV2ThreadProjection,
      "providerTurns" | "attempts" | "runs" | "visibleTurnItems"
    >,
    input: GetForkOptionsInput,
  ) {
    const selected = [
      input.sourceAssistantMessageId,
      input.sourceUserMessageId,
      input.sourceRunningRunId,
      input.sourceRunningTurnId,
    ].filter((value) => value !== undefined);
    if (selected.length > 1) return yield* failure("Choose exactly one conversation boundary.");
    if (input.sourceRunningRunId !== undefined)
      return {
        kind: "running-turn",
        runId: input.sourceRunningRunId,
      } satisfies ConversationForkSource;
    if (input.sourceRunningTurnId !== undefined) {
      // Older clients name a provider turn. Resolve its durable owning run;
      // a provider identity is never cast into an application run identity.
      const turn = projection.providerTurns.find(
        (turn) => turn.nativeTurnRef?.nativeId === input.sourceRunningTurnId,
      );
      const attempt = projection.attempts.find((attempt) => attempt.id === turn?.runAttemptId);
      const run = projection.runs.find(
        (run) => String(run.id) === input.sourceRunningTurnId || run.id === attempt?.runId,
      );
      if (run === undefined) return yield* failure("The selected running turn is unavailable.");
      return { kind: "running-turn", runId: run.id } satisfies ConversationForkSource;
    }
    if (input.sourceUserMessageId !== undefined)
      return {
        kind: "user-message",
        messageId: input.sourceUserMessageId,
      } satisfies ConversationForkSource;
    const messageId =
      input.sourceAssistantMessageId ??
      projection.visibleTurnItems.findLast(
        ({ item }) =>
          item.type === "assistant_message" && !item.streaming && item.status === "completed",
      )?.item;
    if (typeof messageId === "string")
      return { kind: "assistant-response", messageId } satisfies ConversationForkSource;
    if (messageId?.type === "assistant_message")
      return {
        kind: "assistant-response",
        messageId: messageId.messageId,
      } satisfies ConversationForkSource;
    return yield* failure("There is no completed response to fork yet.");
  });

  const inspect = Effect.fn("ConversationFork.inspect")(function* (
    projection: OrchestrationV2ThreadProjection,
    source: ConversationForkSource,
    targetThreadId: ThreadId,
    materialize = true,
    /** T3's own fork folder: a mobile or MCP fork never refused for a missing workspace. */
    fallbackCwd?: string,
  ) {
    const plan = yield* planConversationFork({ projection, targetThreadId, source, materialize });
    const unverified = (cwd: string) => ({
      plan,
      cwd,
      fromCheckpointRef: null,
      checkpointAvailable: false,
      inProjectFolder: false,
      projectRoot: cwd,
      workspaceVerified: false,
    });
    const project = yield* projects.get(projection.thread.projectId);
    if (Option.isNone(project))
      return fallbackCwd === undefined
        ? yield* failure("The conversation's project is unavailable.")
        : unverified(fallbackCwd);
    const originCwd = projection.thread.worktreePath ?? project.value.workspaceRoot;
    const originAvailable = yield* baseline.workspaceExists(originCwd);
    const sourceRun = projection.runs.find((run) => run.id === plan.boundaryRunId);
    let fromCheckpointRef =
      projection.checkpoints.find(
        (checkpoint) => checkpoint.id === sourceRun?.checkpointId && checkpoint.status === "ready",
      )?.ref ?? null;
    // A frozen fork's own baseline covers all inherited rows, never an earlier
    // boundary inside that baseline. Do not substitute the current checkout.
    const sourceFork =
      fromCheckpointRef === null && plan.boundaryRunId === null
        ? yield* projections.getConversationFork(projection.thread.id)
        : null;
    if (sourceFork?.checkpointRef != null) {
      const retainedIds = new Set(plan.retained.map((item) => item.id));
      if (
        projection.visibleTurnItems
          .filter(({ item }) => item.inheritedFrom !== undefined)
          .every(({ item }) => retainedIds.has(item.id))
      )
        fromCheckpointRef = sourceFork.checkpointRef;
    }
    // A removed worktree forks into the project folder rather than refusing.
    const cwd = originAvailable ? originCwd : project.value.workspaceRoot;
    if (!originAvailable && !(yield* baseline.workspaceExists(cwd)))
      return fallbackCwd === undefined
        ? yield* failure("The project folder is unavailable.")
        : unverified(fallbackCwd);
    // A Git lookup that fails only costs the restore point: a local fork goes on.
    const unlessGitFails = (lookup: Effect.Effect<boolean, VcsError>) =>
      lookup.pipe(
        Effect.catch((cause) =>
          Effect.logWarning("Fork checkpoint lookup failed", { cause }).pipe(Effect.as(false)),
        ),
      );
    const gitRepository = yield* unlessGitFails(baseline.isGitRepository(cwd));
    // A running fork snapshots the files it shows, so it needs the original folder.
    const checkpointAvailable =
      gitRepository &&
      (source.kind === "running-turn"
        ? originAvailable
        : fromCheckpointRef !== null &&
          (yield* unlessGitFails(baseline.hasCheckpoint(cwd, fromCheckpointRef))));
    return {
      plan,
      cwd,
      fromCheckpointRef,
      checkpointAvailable,
      inProjectFolder: !originAvailable,
      projectRoot: project.value.workspaceRoot,
      workspaceVerified: true,
    };
  });

  const metadataEvent = Effect.fnUntraced(function* (
    thread: OrchestrationV2AppThread,
    now: DateTime.Utc,
  ) {
    return {
      id: EventId.make(`scient-fork:${thread.id}:${yield* randomUuidV4}`),
      type: "thread.metadata-updated" as const,
      threadId: thread.id,
      occurredAt: now,
      payload: { ...thread, updatedAt: now },
    } satisfies OrchestrationV2DomainEvent;
  });

  const awaitReady = Effect.fn("ConversationForkService.awaitReady")(function* (
    threadId: ThreadId,
  ) {
    const cursor = yield* sink.latestSequence({ threadId });
    const initial = yield* projections.getConversationFork(threadId);
    if (initial === null) return yield* failure("This conversation is not a fork.", "rejected");
    const settled = (
      thread: { readonly deletedAt: unknown },
      fork: ScientConversationFork | null,
    ) => thread.deletedAt !== null || fork?.status !== "pending";
    // Setup changes are written with a thread event, so each event of the fork is a wakeup.
    const final =
      initial.status === "pending" && (yield* projections.getThread(threadId)).deletedAt === null
        ? yield* sink.stream({ threadId, afterSequence: cursor }).pipe(
            Stream.filter(
              ({ event }) =>
                event.type === "thread.metadata-updated" || event.type === "thread.deleted",
            ),
            Stream.mapEffect(() =>
              Effect.all({
                thread: projections.getThread(threadId),
                fork: projections.getConversationFork(threadId),
              }),
            ),
            Stream.filter(({ thread, fork }) => settled(thread, fork)),
            Stream.take(1),
            Stream.runCollect,
            Effect.map((settledForks) => settledForks[0]!),
          )
        : { thread: yield* projections.getThread(threadId), fork: initial };
    const fork = final.fork;
    if (final.thread.deletedAt !== null || fork?.status === "abandoned")
      return yield* failure(fork?.error ?? "The fork was abandoned.", "abandoned");
    if (fork?.status !== "ready")
      return yield* failure(fork?.error ?? "Fork setup failed. Retry the same fork.", "failed");
    return {
      forkAttachmentIdMap: Object.fromEntries(
        fork.attachmentCopies.map(({ source, target }) => [source.id, target.id]),
      ),
    } satisfies ForkReadiness;
  });

  const retryFailedSetup = Effect.fn("ConversationForkService.retryFailedSetup")(function* (
    threadId: ThreadId,
    commandId: CommandId,
  ) {
    const target = yield* projections.getThread(threadId);
    const fork = yield* projections.getConversationFork(threadId);
    if (fork?.status !== "failed" || fork.commandId !== commandId || target.deletedAt !== null)
      return;
    const now = yield* DateTime.now;
    const sequence = yield* sink.latestSequence({ threadId });
    yield* sink.writeWithEffects({
      ...withForkRecord(threadId, { ...fork, status: "pending", error: null }),
      events: [yield* metadataEvent(target, now)],
      effects: [
        {
          id: `scient-fork:${commandId}:retry:${sequence}`,
          commandId,
          threadId,
          request: { type: "scient-fork.provision" },
        },
      ],
    });
  });

  const runningTurn = makeRunningTurnFork({
    snapshots,
    readRecords: Effect.fnUntraced(function* (fork) {
      if (Option.isSome(yield* receipts.getByCommandId(fork.commandId))) return null;
      yield* legacyImporter.ensureTranscript(fork.sourceThreadId);
      // Control records only: the capture reads the source's history once, at its frame.
      return yield* projections.getThreadRecords(fork.sourceThreadId, [
        "runs",
        "attempts",
        "providerThreads",
        "providerTurns",
      ]);
    }),
    withAttachmentPermit: attachmentArbitration.withPermit,
    workspaceExists: baseline.workspaceExists,
    unavailable: (message) => failure(message),
  });

  // Reserves and publishes the fork's own checkpoint ref, copied from the boundary
  // or, for a running fork, captured from the current files.
  const freezeCheckpoint = Effect.fnUntraced(function* (input: {
    readonly command: ThreadForkV2Command;
    readonly workspaceMode: "local" | "new-worktree";
    readonly cwd: string;
    readonly source: ConversationForkSource;
    readonly fromCheckpointRef: CheckpointRef | null;
    readonly requestedCheckpointRef: CheckpointRef | null;
  }) {
    const { command, cwd, source, fromCheckpointRef, requestedCheckpointRef } = input;
    const owned =
      requestedCheckpointRef === null
        ? null
        : yield* checkpointOwnership
            .reserve({
              cwd,
              commandId: command.commandId,
              targetThreadId: command.targetThreadId,
              checkpointRef: requestedCheckpointRef,
            })
            .pipe(
              Effect.tapError((cause) =>
                Effect.logWarning("Fork snapshot ownership could not be recorded", { cause }),
              ),
              Effect.mapError(snapshotFailure),
            );
    const checkpointRef = owned?.ref ?? null;
    if (checkpointRef !== null) {
      if (source.kind === "running-turn")
        yield* baseline.capture({ cwd, toCheckpointRef: checkpointRef }).pipe(
          Effect.provideService(CheckpointPublicationWitness, owned!.beforePublish),
          Effect.tapError((cause) =>
            Effect.logWarning("Fork workspace snapshot capture failed", { cause }),
          ),
          Effect.mapError(snapshotFailure),
        );
      else {
        const unavailable = failure(
          input.workspaceMode === "new-worktree"
            ? "The saved workspace checkpoint is unavailable. Fork without a new worktree instead."
            : "The saved workspace checkpoint is unavailable. Retry the fork.",
        );
        const copied =
          fromCheckpointRef !== null &&
          (yield* baseline.copy({ cwd, fromCheckpointRef, toCheckpointRef: checkpointRef }).pipe(
            Effect.provideService(CheckpointPublicationWitness, owned!.beforePublish),
            Effect.tapError((cause) =>
              Effect.logWarning("Fork workspace checkpoint copy failed", { cause }),
            ),
            Effect.mapError(() => unavailable),
          ));
        if (!copied) return yield* unavailable;
      }
    }
    const checkpointOid =
      checkpointRef === null ? null : yield* baseline.resolveCheckpoint(cwd, checkpointRef);
    if (checkpointRef !== null && checkpointOid === null)
      return yield* failure("The frozen workspace checkpoint is unavailable. Retry the fork.");
    return { checkpointRef, checkpointOid };
  });

  const admit = Effect.fn("ConversationFork.admit")(function* (input: {
    readonly command: ThreadForkV2Command;
    readonly boundary: ConversationForkBoundary;
    readonly sourceProjection: OrchestrationV2ThreadProjection;
    readonly fallbackCwd?: string;
  }) {
    const { command, boundary } = input;
    // Forks a migrated V1 thread's saved transcript, not the empty shell it starts as.
    const hydrated = yield* legacyImporter.ensureTranscript(command.sourceThreadId);
    const projection =
      hydrated.importedMessageCount > 0 || hydrated.importedThreadCount > 0
        ? yield* projections.getThreadProjection(command.sourceThreadId)
        : input.sourceProjection;
    const source: ConversationForkSource = boundary;
    const workspaceMode = command.scient?.workspaceMode ?? "local";
    const inspected = yield* inspect(
      projection,
      source,
      command.targetThreadId,
      true,
      input.fallbackCwd,
    );
    const { plan, cwd, fromCheckpointRef, checkpointAvailable } = inspected;
    const markerSource =
      source.kind === "user-message"
        ? {
            type: "message" as const,
            threadId: projection.thread.id,
            messageId: source.messageId,
            position: "before" as const,
          }
        : plan.boundaryRunId !== null && !(source.kind === "assistant-response" && plan.cutsOpenRun)
          ? { type: "run" as const, threadId: projection.thread.id, runId: plan.boundaryRunId }
          : source.kind === "assistant-response"
            ? {
                type: "message" as const,
                threadId: projection.thread.id,
                messageId: source.messageId,
                position: "after" as const,
              }
            : yield* failure("The fork's durable conversation boundary is unavailable.");
    if (workspaceMode === "new-worktree" && !checkpointAvailable)
      return yield* failure(
        "This boundary has no saved workspace checkpoint. Fork locally instead.",
      );
    const requestedCheckpointRef =
      checkpointAvailable && (source.kind !== "running-turn" || workspaceMode === "new-worktree")
        ? checkpointRefForThreadTurn(command.targetThreadId, 0)
        : null;
    // A new worktree is built from the checkpoint. A local fork only loses its
    // restore point, so it continues without one rather than refusing.
    const frozen = freezeCheckpoint({
      command,
      workspaceMode,
      cwd,
      source,
      fromCheckpointRef,
      requestedCheckpointRef,
    });
    const { checkpointRef, checkpointOid } = yield* workspaceMode === "new-worktree"
      ? frozen
      : frozen.pipe(
          Effect.catch((cause) =>
            Effect.logWarning("Local fork continues without a restore point", { cause }).pipe(
              Effect.as({ checkpointRef: null, checkpointOid: null }),
            ),
          ),
        );
    return {
      projection,
      source,
      plan,
      markerSource,
      workspaceMode,
      cwd,
      inProjectFolder: inspected.inProjectFolder,
      projectRoot: inspected.projectRoot,
      workspaceVerified: inspected.workspaceVerified,
      checkpointRef,
      checkpointOid,
      nativeSource: freezeConversationForkNativeSource({
        projection,
        retainedSourceItems: plan.retained,
        boundaryRunId: plan.boundaryRunId,
        sourceKind: source.kind,
      }),
    } satisfies ConversationForkAdmission;
  });

  const commit = <A, E, R>(input: {
    readonly command: ThreadForkV2Command;
    readonly admission: ConversationForkAdmission;
    readonly capture: CapturedProviderText | null;
    readonly events: ReadonlyArray<OrchestrationV2DomainEvent>;
    readonly conversationFork: ScientConversationFork;
    readonly commit: (input: ConversationForkCommitInput) => Effect.Effect<A, E, R>;
  }) => {
    const { command, admission, capture } = input;
    const { projection } = admission;
    // Source/destination locks are already held. Global title allocation only
    // serializes sibling reads and admission, never workspace capture.
    return titles.withLock(
      "conversation-fork-titles",
      Effect.gen(function* () {
        // Checked after every wait, just before the fork is committed: a local fork whose
        // folder disappeared works in the project folder instead, never in the missing folder.
        const folderGone =
          admission.workspaceVerified &&
          admission.workspaceMode === "local" &&
          !(yield* baseline.workspaceExists(admission.cwd));
        const movedToProjectFolder = folderGone && admission.cwd !== admission.projectRoot;
        if (
          folderGone &&
          (!movedToProjectFolder || !(yield* baseline.workspaceExists(admission.projectRoot)))
        )
          return yield* failure("The project folder is unavailable.");
        const title =
          command.title ??
          deriveForkTitle({
            origin: projection.thread,
            originHasForkLineage: projection.thread.forkLineage != null,
            projectThreads: yield* projections
              .getProjectThreadTitles(projection.thread.id)
              .pipe(
                Effect.mapError(() =>
                  failure("Unable to read this project's conversations. Retry the fork."),
                ),
              ),
          });
        const events = input.events.map((event): OrchestrationV2DomainEvent =>
          event.type !== "thread.created" || event.threadId !== command.targetThreadId
            ? event
            : {
                ...event,
                payload: {
                  ...event.payload,
                  title,
                  ...(movedToProjectFolder ? { worktreePath: null, branch: null } : {}),
                },
              },
        );
        const committed = input.commit({
          events,
          conversationFork: movedToProjectFolder
            ? { ...input.conversationFork, cwd: admission.projectRoot }
            : input.conversationFork,
          ...(capture === null ? {} : { runningForkSource: { owner: capture.owner, capture } }),
        });
        return yield* capture === null
          ? committed
          : runningTurn.fence(capture, admission.cwd, committed);
      }),
    );
  };

  const provision = Effect.fn("ConversationFork.provision")(function* (
    threadId: ThreadId,
    willRetry: boolean,
  ) {
    const program = executor
      .withLock(
        threadId,
        Effect.gen(function* () {
          const thread = yield* projections.getThread(threadId);
          const fork = yield* projections.getConversationFork(threadId);
          if (fork == null || fork.status === "ready" || thread.deletedAt !== null) return;
          let worktreePath = thread.worktreePath;
          let branch = thread.branch;
          if (fork.workspaceMode === "new-worktree") {
            if (
              fork.checkpointRef === null ||
              fork.checkpointOid === null ||
              (yield* baseline.resolveCheckpoint(fork.cwd, fork.checkpointRef)) !==
                fork.checkpointOid
            )
              return yield* failure("The frozen fork checkpoint is unavailable.", "abandoned");
            branch = `scient/fork/${threadId.toLowerCase().replace(/[^a-z0-9._-]+/g, "-")}`;
            const listed = yield* git.listRefs({
              cwd: fork.cwd,
              query: branch,
              refKind: "local",
              includeMatchingRemoteRefs: false,
              refresh: true,
              limit: 100,
            });
            const existing = listed.refs.find((ref) => !ref.isRemote && ref.name === branch);
            const created = existing?.worktreePath == null;
            worktreePath =
              existing?.worktreePath ??
              (yield* git.createWorktree(
                existing
                  ? { cwd: fork.cwd, refName: branch, path: null }
                  : { cwd: fork.cwd, refName: fork.checkpointRef, newRefName: branch, path: null },
              )).worktree.path;
            if (
              !(yield* baseline.verifyWorktree({
                cwd: fork.cwd,
                path: worktreePath,
                branch,
                checkpointRef: fork.checkpointRef,
                requireClean: !created,
              }))
            )
              return yield* failure(
                "The fork worktree changed or did not finish checkout. Its files were left in place; create a fresh fork.",
                "abandoned",
              );
          }
          const now = yield* DateTime.now;
          yield* sink.write({
            ...withForkRecord(threadId, { ...fork, status: "ready", error: null }),
            events: [yield* metadataEvent({ ...thread, worktreePath, branch }, now)],
          });
        }),
      )
      .pipe(Effect.scoped);
    // The fork records and returns its setup error. Git and storage errors name
    // workspace paths and carry Git output: those stay in the server log.
    yield* program.pipe(
      Effect.tapError((cause) =>
        isDispatchError(cause)
          ? Effect.void
          : Effect.logWarning("Fork workspace setup failed", { cause }),
      ),
      Effect.mapError((cause) =>
        isDispatchError(cause)
          ? cause
          : failure("Unable to set up this fork's worktree. Retry the fork.", "failed"),
      ),
      Effect.tapError((cause) =>
        willRetry && !isAbandonedFailure(cause)
          ? Effect.void
          : executor.withLock(
              threadId,
              Effect.gen(function* () {
                const thread = yield* projections.getThread(threadId);
                const fork = yield* projections.getConversationFork(threadId);
                if (fork == null || thread.deletedAt !== null || fork.status === "ready") return;
                const abandoned = isAbandonedFailure(cause);
                const now = yield* DateTime.now;
                const event = yield* metadataEvent(
                  { ...thread, ...(abandoned ? { deletedAt: now } : {}) },
                  now,
                );
                // An abandoned fork is deleted: it releases what deleting it would.
                yield* sink.writeWithEffects({
                  ...withForkRecord(threadId, {
                    ...fork,
                    status: abandoned ? "abandoned" : "failed",
                    error: cause.message,
                  }),
                  events: [abandoned ? { ...event, type: "thread.deleted" } : event],
                  effects: abandoned
                    ? [
                        {
                          id: `scient-fork:${fork.commandId}:abandoned:release-files`,
                          commandId: fork.commandId,
                          threadId,
                          request: { type: "scient.release-thread-files" },
                        },
                      ]
                    : [],
                });
              }),
            ),
      ),
    );
  });

  const asDispatchError =
    (forkDisposition: "rejected" | "failed") =>
    <A, E extends { readonly message: string }, R>(effect: Effect.Effect<A, E, R>) =>
      effect.pipe(
        Effect.mapError((cause) =>
          isDispatchError(cause)
            ? cause
            : new OrchestrationDispatchCommandError({
                message:
                  cause.message.trim() !== ""
                    ? cause.message
                    : "The fork could not be prepared. Retry the fork.",
                cause,
                forkDisposition,
              }),
        ),
      );

  return ConversationForkService.of({
    admit: Effect.fn("ConversationForkService.admit")(function (input) {
      return withoutVcsDiagnostics(admit(input)).pipe(asDispatchError("rejected"));
    }),
    commit,
    withRunningCapture: runningTurn.withCapture,
    retryFailedSetup: Effect.fn("ConversationForkService.retryFailedSetup")(
      function (threadId, commandId) {
        return retryFailedSetup(threadId, commandId).pipe(asDispatchError("failed"));
      },
    ),
    awaitReady: Effect.fn("ConversationForkService.awaitReady")(function (threadId) {
      return awaitReady(threadId).pipe(
        Effect.mapError((cause) =>
          isDispatchError(cause)
            ? cause
            : new OrchestrationDispatchCommandError({
                message:
                  "The fork was accepted, but its setup receipt could not be read. Retry the same fork.",
                cause,
                forkDisposition: "pending",
              }),
        ),
      );
    }),
    provision: Effect.fn("ConversationForkService.provision")(function (threadId, willRetry) {
      return provision(threadId, willRetry).pipe(asDispatchError("failed"));
    }),
    getOptions: Effect.fn("ConversationForkService.getOptions")(function (input) {
      return withoutVcsDiagnostics(
        Effect.gen(function* () {
          yield* legacyImporter.ensureTranscript(input.originThreadId);
          const projection = yield* projections.getThreadProjection(input.originThreadId);
          // A fork whose own worktree setup is pending or failed already shares its
          // history, so it forks in the folder it shows now.
          const source = yield* resolveSource(projection, input);
          const inspected = yield* inspect(
            projection,
            source,
            ThreadId.make(`scient-options:${input.originThreadId}`),
            false,
          );
          return { source, ...inspected };
        }),
      ).pipe(
        Effect.map(({ source, checkpointAvailable, inProjectFolder }): ForkOptions => ({
          available: true,
          localAvailable: true,
          reason: null,
          ...(inProjectFolder
            ? {
                workspaceNotice:
                  "The original worktree was removed, so this fork works in the project folder.",
              }
            : {}),
          newWorktree: checkpointAvailable,
          sourceAssistantMessageId: source.kind === "assistant-response" ? source.messageId : null,
          sourceUserMessageId: source.kind === "user-message" ? source.messageId : null,
          sourceRunningRunId: source.kind === "running-turn" ? source.runId : null,
        })),
        Effect.catch((cause) =>
          !isDispatchError(cause) && !isPlanError(cause)
            ? Effect.fail(
                new OrchestrationDispatchCommandError({
                  message: cause.message,
                  cause,
                  forkDisposition: "rejected",
                }),
              )
            : Effect.succeed({
                available: false,
                localAvailable: false,
                reason: cause.message,
                newWorktree: false,
                sourceAssistantMessageId: null,
                sourceUserMessageId: null,
              }),
        ),
      );
    }),
  });
});

export const layer = Layer.effect(ConversationForkService, make);
