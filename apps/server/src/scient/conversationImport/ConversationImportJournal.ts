/**
 * The importer's attempt journal: one small JSON file in the import's
 * `attemptDirectory`, written atomically and flushed before any attachment is
 * published or the import command is dispatched. It is the only record of
 * what an uncommitted attempt owns, so it names the exact final paths.
 *
 * An attempt directory holds either nothing (no attempt), or this journal
 * (possibly beside the temporary directory of an interrupted write, which
 * never names published files: publication starts only after the rename).
 */
import {
  ConversationExternalExportId,
  ConversationImportId,
  ConversationImportResourceId,
  IsoDateTime,
  NonNegativeInt,
  Sha256Digest,
  TrimmedNonEmptyString,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { writeFileStringAtomically } from "../../atomicWrite.ts";
import { ConversationImportAttemptBinding } from "./ConversationImporter.ts";
import { ConversationImportIds } from "./conversationImportPlan.ts";

export const CONVERSATION_IMPORT_JOURNAL_FILE = "journal.json";

export const ConversationImportJournal = Schema.Struct({
  version: Schema.Literal(1),
  importId: ConversationImportId,
  attemptId: TrimmedNonEmptyString,
  /** The confirm this attempt is bound to: package digest and destination. */
  binding: ConversationImportAttemptBinding,
  /** The package's external identity, recorded as the thread's provenance. */
  package: Schema.Struct({
    exportId: ConversationExternalExportId,
    contentDigest: Sha256Digest,
  }),
  /** The local id of every record the command writes: command, thread, messages, turns, attachments. */
  ids: ConversationImportIds,
  /** The exact final attachment paths this attempt owns. */
  attachments: Schema.Array(
    Schema.Struct({
      resourceId: ConversationImportResourceId,
      attachmentId: TrimmedNonEmptyString,
      path: TrimmedNonEmptyString,
    }),
  ),
  messageCount: NonNegativeInt,
  attachmentCount: NonNegativeInt,
  importedAt: IsoDateTime,
});
export type ConversationImportJournal = typeof ConversationImportJournal.Type;

const JournalJson = Schema.fromJsonString(ConversationImportJournal);
const encodeJournal = Schema.encodeEffect(JournalJson);
const decodeJournal = Schema.decodeUnknownEffect(JournalJson);

export class ConversationImportJournalError extends Schema.TaggedError<ConversationImportJournalError>()(
  "ConversationImportJournalError",
  { detail: Schema.String, cause: Schema.Defect() },
) {
  override get message(): string {
    return this.detail;
  }
}

/** Writes the journal durably: temporary file, flush, rename, directory flush. */
export const writeConversationImportJournal = Effect.fn("writeConversationImportJournal")(
  function* (attemptDirectory: string, journal: ConversationImportJournal) {
    const path = yield* Path.Path;
    const contents = yield* encodeJournal(journal);
    yield* writeFileStringAtomically({
      filePath: path.join(attemptDirectory, CONVERSATION_IMPORT_JOURNAL_FILE),
      contents,
      durable: true,
    });
  },
  Effect.mapError(
    (cause) =>
      new ConversationImportJournalError({
        detail: "The import journal could not be written.",
        cause,
      }),
  ),
);

/** The attempt's journal, or none when no attempt was journaled. */
export const readConversationImportJournal = Effect.fn("readConversationImportJournal")(
  function* (attemptDirectory: string) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const file = path.join(attemptDirectory, CONVERSATION_IMPORT_JOURNAL_FILE);
    if (!(yield* fs.exists(file))) return Option.none<ConversationImportJournal>();
    return Option.some(yield* decodeJournal(yield* fs.readFileString(file)));
  },
  Effect.mapError(
    (cause) =>
      new ConversationImportJournalError({
        detail: "The import journal could not be read.",
        cause,
      }),
  ),
);

/** Empties the attempt directory (the journal and any interrupted write); the directory stays. */
export const clearConversationImportAttempt = Effect.fn("clearConversationImportAttempt")(
  function* (attemptDirectory: string) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    if (!(yield* fs.exists(attemptDirectory))) return;
    for (const entry of yield* fs.readDirectory(attemptDirectory)) {
      yield* fs.remove(path.join(attemptDirectory, entry), { recursive: true, force: true });
    }
  },
  Effect.mapError(
    (cause) =>
      new ConversationImportJournalError({
        detail: "The import attempt could not be cleared.",
        cause,
      }),
  ),
);
