/**
 * The conversation importer: turns one validated, leased import into a new
 * independent thread with a single `thread.conversation.import` command, and
 * settles attempts that will not continue. See `ConversationImporter.ts` for
 * the contract with staging.
 *
 * One attempt, in order:
 *
 * 1. **Journal.** Mint fresh local ids, choose the exact final attachment
 *    paths, and write the journal durably. Nothing is published before this.
 * 2. **Publish.** Copy each staged attachment to its final path (temporary
 *    file and rename, in staging's `copyAttachment`), before the history that
 *    references it commits.
 * 3. **Commit once.** Dispatch the command with the journal's command id. Its
 *    native history events commit in
 *    one transaction with the command receipt. From the dispatch on, nothing
 *    is interruptible.
 *
 * The command receipt decides every outcome, never whether a thread exists
 * now (a committed thread may since have been deleted): accepted means the
 * published files belong to the thread and are never removed; rejected or
 * absent means exactly the journal-listed files are removed when the attempt
 * ends. An in-process lock per import keeps settling and importing apart, so
 * cleanup never runs while a dispatch for the attempt can still commit.
 */
import { SCIENT_CONVERSATION_IMPORT_REQUIRED_SCOPE, type CommandId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import { resolveAttachmentPath } from "../../attachmentStore.ts";
import * as ServerConfig from "../../config.ts";
import { ProjectStoreV2 } from "../../orchestration-v2/ProjectStore.ts";
import { layer as OrchestrationCommandReceiptRepositoryLive } from "../../persistence/OrchestrationCommandReceipts.ts";
import { OrchestrationCommandReceiptRepository } from "../../persistence/OrchestrationCommandReceipts.ts";
import { ProjectCloneTracker } from "../../project/ProjectCloneTracker.ts";
import { ProviderRegistry } from "../../provider/ProviderRegistry.ts";
import {
  ConversationImporter,
  ConversationImporterError,
  ConversationImportSettleError,
  conversationImportDestination,
  sameConversationImportDestination,
  type ConversationImportCompletion,
  type ConversationImportLease,
  type ConversationImportRequest,
} from "./ConversationImporter.ts";
import {
  clearConversationImportAttempt,
  readConversationImportJournal,
  writeConversationImportJournal,
  type ConversationImportJournal,
} from "./ConversationImportJournal.ts";
import {
  buildConversationImportCommand,
  idsCoverImport,
  mintConversationImportIds,
  plannedAttachments,
} from "./conversationImportPlan.ts";
import * as ConversationImportCommit from "./ConversationImportCommit.ts";

type Receipt =
  | { readonly _tag: "accepted"; readonly acceptedAt: string }
  | { readonly _tag: "rejected"; readonly detail: string }
  | { readonly _tag: "absent" };

const isSettleError = Schema.is(ConversationImportSettleError);

const importerError = (reason: ConversationImporterError["reason"], detail: string) =>
  new ConversationImporterError({ reason, detail });

function completionOf(
  journal: ConversationImportJournal,
  completedAt: string,
): ConversationImportCompletion {
  return {
    packageSha256: journal.binding.packageSha256,
    result: {
      importId: journal.importId,
      threadId: journal.ids.threadId,
      destination: journal.binding.destination,
      messageCount: journal.messageCount,
      attachmentCount: journal.attachmentCount,
    },
    completedAt,
  };
}

const make = Effect.gen(function* () {
  const engine = yield* ConversationImportCommit.ConversationImportCommit;
  const receipts = yield* OrchestrationCommandReceiptRepository;
  const projects = yield* ProjectStoreV2;
  const providers = yield* ProviderRegistry;
  const clones = yield* ProjectCloneTracker;
  const config = yield* ServerConfig.ServerConfig;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const crypto = yield* Crypto.Crypto;

  const provide = <A, E>(
    effect: Effect.Effect<A, E, FileSystem.FileSystem | Path.Path | Crypto.Crypto>,
  ) =>
    effect.pipe(
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, path),
      Effect.provideService(Crypto.Crypto, crypto),
    );

  // One lock per import: an import and the settling of its attempt never overlap.
  const locks = new Map<string, { readonly lock: Semaphore.Semaphore; users: number }>();
  const withAttemptLock = <A, E, R>(importId: string, effect: Effect.Effect<A, E, R>) =>
    Effect.acquireUseRelease(
      Effect.sync(() => {
        const entry = locks.get(importId) ?? { lock: Semaphore.makeUnsafe(1), users: 0 };
        entry.users += 1;
        locks.set(importId, entry);
        return entry;
      }),
      (entry) => entry.lock.withPermits(1)(effect),
      (entry) =>
        Effect.sync(() => {
          entry.users -= 1;
          if (entry.users === 0) locks.delete(importId);
        }),
    );

  const readReceipt = (commandId: CommandId) =>
    receipts
      .getByCommandId({ commandId })
      .pipe(
        Effect.map((receipt): Receipt =>
          Option.isNone(receipt)
            ? { _tag: "absent" }
            : receipt.value.status === "accepted"
              ? { _tag: "accepted", acceptedAt: receipt.value.acceptedAt }
              : { _tag: "rejected", detail: receipt.value.error ?? "The import was refused." },
        ),
      );

  /** Removes exactly the journal-listed files this server owns, then the journal. */
  const rollBack = Effect.fn("ConversationImporter.rollBack")(function* (
    journal: ConversationImportJournal,
    attemptDirectory: string,
  ) {
    const attachmentsRoot = path.resolve(config.attachmentsDir);
    for (const attachment of journal.attachments) {
      const target = path.resolve(attachment.path);
      // Never outside the attachment store, whatever the journal says.
      if (path.dirname(target) !== attachmentsRoot) continue;
      yield* fileSystem.remove(target, { force: true });
    }
    yield* provide(clearConversationImportAttempt(attemptDirectory));
  });

  const checkAuthority = Effect.fn("ConversationImporter.checkAuthority")(function* (
    request: ConversationImportRequest,
  ) {
    // The confirm endpoint already required the scope; reaching here without
    // it is a server defect, refused before anything is touched.
    if (!request.principal.scopes.has(SCIENT_CONVERSATION_IMPORT_REQUIRED_SCOPE)) {
      return yield* Effect.die(
        new Error("The conversation import was confirmed without the operate scope."),
      );
    }
    const { projectId, modelSelection } = request.destination;
    const project = yield* projects
      .get(projectId)
      .pipe(
        Effect.mapError(() =>
          importerError("import-failed", "The destination project could not be read."),
        ),
      );
    if (Option.isNone(project)) {
      return yield* importerError("project-not-found", "The destination project does not exist.");
    }
    const clone = yield* clones.get(projectId);
    if (clone !== null && clone.phase !== "done") {
      return yield* importerError(
        "project-not-found",
        clone.phase === "running"
          ? "The destination project's repository is still being cloned."
          : "The destination project's repository was not cloned.",
      );
    }
    const provider = (yield* providers.getProviders).find(
      (candidate) => candidate.instanceId === modelSelection.instanceId,
    );
    if (provider === undefined || !provider.enabled) {
      return yield* importerError(
        "provider-unavailable",
        "The chosen provider is not configured or is turned off on this server.",
      );
    }
  });

  const beginAttempt = Effect.fn("ConversationImporter.beginAttempt")(function* (
    lease: ConversationImportLease,
    request: ConversationImportRequest,
  ) {
    const ids = yield* provide(mintConversationImportIds(lease.input)).pipe(
      Effect.mapError(() =>
        importerError("import-failed", "The import's ids could not be minted."),
      ),
    );
    const attachments = [];
    for (const { resourceId, attachment } of plannedAttachments(lease.input, ids)) {
      const target = resolveAttachmentPath({ attachmentsDir: config.attachmentsDir, attachment });
      if (target === null) {
        return yield* importerError("import-failed", `Attachment ${attachment.name} has no path.`);
      }
      attachments.push({ resourceId, attachmentId: attachment.id, path: target });
    }
    const journal: ConversationImportJournal = {
      version: 1,
      importId: lease.importId,
      attemptId: yield* crypto.randomUUIDv4.pipe(Effect.orDie),
      binding: {
        packageSha256: lease.input.package.packageSha256,
        destination: request.destination,
      },
      package: {
        exportId: lease.input.package.exportId,
        contentDigest: lease.input.package.contentDigest,
      },
      ids,
      attachments,
      messageCount: lease.input.snapshot.messages.length,
      attachmentCount: attachments.length,
      importedAt: DateTime.formatIso(yield* DateTime.now),
    };
    yield* provide(writeConversationImportJournal(lease.attemptDirectory, journal)).pipe(
      Effect.mapError((error) => importerError("import-failed", error.detail)),
    );
    return journal;
  });

  /** Dispatches once and lets the receipt decide. Uninterruptible: the command may commit. */
  const commit = Effect.fn("ConversationImporter.commit")(function* (
    lease: ConversationImportLease,
    journal: ConversationImportJournal,
  ) {
    const command = buildConversationImportCommand({
      validated: lease.input,
      ids: journal.ids,
      destination: journal.binding.destination,
      importedAt: journal.importedAt,
    });
    const dispatched = yield* Effect.exit(engine.dispatch(command));
    const receipt = yield* readReceipt(journal.ids.commandId).pipe(
      Effect.retry({ times: 2 }),
      Effect.orElseSucceed((): Receipt | null => null),
    );
    if (receipt?._tag === "accepted") return completionOf(journal, receipt.acceptedAt);
    if (receipt === null && Exit.isSuccess(dispatched)) {
      return completionOf(journal, DateTime.formatIso(yield* DateTime.now));
    }
    if (receipt?._tag === "rejected") {
      const cleared = yield* rollBack(journal, lease.attemptDirectory).pipe(
        Effect.as(true),
        Effect.orElseSucceed(() => false),
      );
      return yield* cleared
        ? importerError("import-rejected", receipt.detail)
        : importerError(
            "import-failed",
            "The import was refused, and its files are still in place.",
          );
    }
    const failure = Exit.isFailure(dispatched) ? Cause.squash(dispatched.cause) : undefined;
    return yield* importerError(
      "import-failed",
      failure instanceof Error
        ? `The import did not commit: ${failure.message}`
        : "The import did not commit.",
    );
  }, Effect.uninterruptible);

  const importConversation: ConversationImporter["Service"]["importConversation"] = (
    lease,
    requested,
  ) => {
    const request = {
      ...requested,
      destination: conversationImportDestination(requested.destination),
    };
    return withAttemptLock(
      lease.importId,
      Effect.gen(function* () {
        let kept = yield* provide(readConversationImportJournal(lease.attemptDirectory)).pipe(
          Effect.mapError((error) => importerError("import-failed", error.detail)),
        );
        if (Option.isSome(kept)) {
          const journal = kept.value;
          if (
            journal.importId !== lease.importId ||
            journal.binding.packageSha256 !== lease.input.package.packageSha256 ||
            !idsCoverImport(journal.ids, lease.input)
          ) {
            return yield* Effect.die(
              new Error("The import journal does not belong to this staged package."),
            );
          }
          const receipt = yield* readReceipt(journal.ids.commandId).pipe(
            Effect.mapError(() =>
              importerError("import-failed", "The import's commit receipt could not be read."),
            ),
          );
          if (receipt._tag === "accepted") return completionOf(journal, receipt.acceptedAt);
          if (receipt._tag === "rejected") {
            // That attempt is over; this confirm starts a new one.
            yield* rollBack(journal, lease.attemptDirectory).pipe(
              Effect.mapError(() =>
                importerError("import-failed", "The refused attempt could not be cleared."),
              ),
            );
            kept = Option.none();
          } else if (
            !sameConversationImportDestination(journal.binding.destination, request.destination)
          ) {
            return yield* importerError(
              "destination-changed",
              "An unfinished import of this file is bound to another destination. Confirm it with that destination, or cancel it.",
            );
          }
        }
        yield* checkAuthority(request);
        const journal = Option.isSome(kept) ? kept.value : yield* beginAttempt(lease, request);
        for (const attachment of journal.attachments) {
          yield* lease
            .copyAttachment({ resourceId: attachment.resourceId, destinationPath: attachment.path })
            .pipe(Effect.mapError((error) => importerError("import-failed", error.detail)));
        }
        return yield* commit(lease, journal);
      }),
    );
  };

  const settleAttempt: ConversationImporter["Service"]["settleAttempt"] = (attempt) =>
    withAttemptLock(
      attempt.importId,
      Effect.gen(function* () {
        const journal = yield* provide(readConversationImportJournal(attempt.attemptDirectory));
        if (Option.isNone(journal)) {
          // Only an interrupted journal write: nothing was published.
          yield* provide(clearConversationImportAttempt(attempt.attemptDirectory));
          return { _tag: "rolled-back" } as const;
        }
        if (journal.value.importId !== attempt.importId) {
          return yield* new ConversationImportSettleError({
            detail: `The import journal in ${attempt.attemptDirectory} belongs to another import.`,
            cause: null,
          });
        }
        const receipt = yield* readReceipt(journal.value.ids.commandId);
        switch (receipt._tag) {
          case "accepted":
            return {
              _tag: "committed",
              completion: completionOf(journal.value, receipt.acceptedAt),
            } as const;
          case "rejected":
            yield* rollBack(journal.value, attempt.attemptDirectory);
            return { _tag: "rejected", detail: receipt.detail } as const;
          case "absent":
            yield* rollBack(journal.value, attempt.attemptDirectory);
            return { _tag: "rolled-back" } as const;
        }
      }).pipe(
        Effect.mapError((cause) =>
          isSettleError(cause)
            ? cause
            : new ConversationImportSettleError({
                detail: `The import attempt for ${attempt.importId} could not be settled.`,
                cause,
              }),
        ),
      ),
    );

  return ConversationImporter.of({ importConversation, settleAttempt });
});

export const layer = Layer.effect(ConversationImporter, make).pipe(
  Layer.provide(OrchestrationCommandReceiptRepositoryLive),
);
