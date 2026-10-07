import * as Schema from "effect/Schema";
import {
  IsoDateTime,
  MessageId,
  PositiveInt,
  ThreadId,
  TrimmedNonEmptyString,
  TurnId,
} from "./baseSchemas.ts";

/** What an imported conversation's file did not carry, as the thread's import banner lists it. */
export const OrchestrationConversationImportOmission = Schema.Union([
  Schema.TaggedStruct("work-log-excluded", {}),
  Schema.TaggedStruct("reasoning-excluded", {}),
  Schema.TaggedStruct("range-truncated", { throughMessageN: PositiveInt }),
  Schema.TaggedStruct("running-turn-omitted", {}),
  Schema.TaggedStruct("attachments-unavailable", { count: PositiveInt }),
  Schema.TaggedStruct("records-skipped", { count: PositiveInt }),
]);
export type OrchestrationConversationImportOmission =
  typeof OrchestrationConversationImportOmission.Type;

/** At most this many file notices are kept on an imported thread. */
export const CONVERSATION_IMPORT_MAX_NOTICES = 10;

/**
 * A note the imported file carried about itself that no omission states (for
 * example that attachment contents were not included): one line of plain
 * text, without paths or codes, shown by the thread's import banner.
 */
export const OrchestrationConversationImportNotice = TrimmedNonEmptyString.check(
  Schema.isMaxLength(300),
);
export type OrchestrationConversationImportNotice =
  typeof OrchestrationConversationImportNotice.Type;

/**
 * External source identity and known omissions of imported history. The
 * identifiers came from a package: they are provenance only, never local ids.
 */
export const OrchestrationConversationImportSource = Schema.Struct({
  source: Schema.Literals(["scic", "markdown"]),
  exportId: TrimmedNonEmptyString.check(Schema.isMaxLength(128)),
  sourceThreadId: Schema.NullOr(TrimmedNonEmptyString.check(Schema.isMaxLength(512))),
  packageDigest: TrimmedNonEmptyString.check(Schema.isPattern(/^sha256:[a-f0-9]{64}$/)),
  sourceFormat: TrimmedNonEmptyString.check(Schema.isMaxLength(128)),
  sourceFormatVersion: PositiveInt,
  importedAt: IsoDateTime,
  omissions: Schema.Array(OrchestrationConversationImportOmission),
  /**
   * How far the imported times were moved back, in milliseconds, because some
   * were later than the importing server's clock (the sender's clock was
   * ahead). Absent when nothing was moved; earlier transfers' moves add up.
   */
  timesShiftedMs: Schema.optional(PositiveInt),
  /** The file's own notes, deduplicated against the omissions; absent when there are none. */
  notices: Schema.optional(
    Schema.Array(OrchestrationConversationImportNotice).check(
      Schema.isMaxLength(CONVERSATION_IMPORT_MAX_NOTICES),
    ),
  ),
});
export type OrchestrationConversationImportSource =
  typeof OrchestrationConversationImportSource.Type;

export const OrchestrationConversationImport = Schema.Struct({
  ...OrchestrationConversationImportSource.fields,
  /**
   * Server read model only: turns holding imported history. Revert keeps
   * them, as it keeps a fork's inherited turns. Client-facing payloads omit it.
   */
  inheritedTurnIds: Schema.optional(Schema.Array(TurnId)),
});
export type OrchestrationConversationImport = typeof OrchestrationConversationImport.Type;

/** Fork lineage and any external source history retained through the fork. */
export const OrchestrationForkLineage = Schema.Struct({
  originThreadId: ThreadId,
  baselineAssistantMessageId: Schema.NullOr(MessageId),
  sourceImport: Schema.optional(OrchestrationConversationImportSource),
  /**
   * Server read model only: destination turns holding inherited transcript.
   * Revert never removes them. Client-facing payloads omit it.
   */
  inheritedTurnIds: Schema.optional(Schema.Array(TurnId)),
});
export type OrchestrationForkLineage = typeof OrchestrationForkLineage.Type;
