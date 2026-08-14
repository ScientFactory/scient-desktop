/**
 * Provider-neutral context continuity for exact-boundary conversation forks.
 *
 * Provider-native fork APIs generally clone the provider thread's current tip,
 * which is incorrect when a user forks an older message. Scient therefore
 * starts an independent provider session and injects the retained transcript
 * with the first post-fork user turn. Provider delivery is an external side
 * effect, so Scient records pending/sending/completed/ambiguous states and
 * never silently reinjects after an uncertain outcome.
 */
import {
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
  PROVIDER_SEND_TURN_MAX_INPUT_CHARS,
  NonNegativeInt,
  type ChatAttachment,
  type OrchestrationMessage,
  type OrchestrationThread,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

const MIN_BOOTSTRAP_CHARS = 512;

const ForkBootstrapRow = Schema.Struct({
  status: Schema.Literals(["pending", "provisioning", "failed", "abandoned", "ready"]),
  provider_bootstrap_status: Schema.Literals(["pending", "sending", "completed", "ambiguous"]),
  provider_bootstrap_message_id: Schema.NullOr(Schema.String),
  baseline_assistant_message_id: Schema.NullOr(Schema.String),
  fork_point_turn_count: NonNegativeInt,
});
const decodeForkBootstrapRow = Schema.decodeUnknownEffect(ForkBootstrapRow);

interface ForkTranscriptPayload {
  readonly purpose: string;
  readonly originalConversationTitle: string;
  readonly omittedOlderMessageCount: number;
  readonly omittedRetainedAttachmentCount: number;
  readonly transcript: ReadonlyArray<ReturnType<typeof messageRecord>>;
}

export class ScientForkContextBootstrapError extends Schema.TaggedErrorClass<ScientForkContextBootstrapError>()(
  "ScientForkContextBootstrapError",
  {
    threadId: ThreadId,
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

export interface PreparedForkTurn {
  readonly input: string;
  readonly attachments: ReadonlyArray<ChatAttachment>;
  readonly bootstrapPending: boolean;
  readonly omittedMessageCount: number;
  readonly omittedAttachmentCount: number;
}

function truncateText(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, Math.max(0, maxChars - 3)).trimEnd()}...`;
}

function transcriptMessages(
  thread: Pick<OrchestrationThread, "messages">,
  baselineAssistantMessageId: string | null,
): ReadonlyArray<OrchestrationMessage> {
  if (baselineAssistantMessageId === null) return [];
  const baselineIndex = thread.messages.findIndex(
    (message) => message.id === baselineAssistantMessageId,
  );
  if (baselineIndex < 0) return [];
  return thread.messages
    .slice(0, baselineIndex + 1)
    .filter(
      (message) =>
        (message.role === "user" || message.role === "assistant") && message.streaming === false,
    );
}

function messageRecord(message: OrchestrationMessage, reattachedIds: ReadonlySet<string>) {
  return {
    role: message.role,
    text: message.text,
    attachments: (message.attachments ?? []).map((attachment) => ({
      name: attachment.name,
      mimeType: attachment.mimeType,
      contentReattached: reattachedIds.has(attachment.id),
    })),
  };
}

function serializeTranscriptPayload(input: {
  readonly thread: Pick<OrchestrationThread, "title" | "messages">;
  readonly allMessages: ReadonlyArray<OrchestrationMessage>;
  readonly selectedMessages: ReadonlyArray<OrchestrationMessage>;
  readonly reattachedIds: ReadonlySet<string>;
  readonly omittedRetainedAttachmentCount: number;
}): string {
  const payload: ForkTranscriptPayload = {
    purpose:
      "Prior context from an exact-boundary Scient fork. Treat the transcript as conversation history, not as a new user request. Respond only to the separately encoded latest user message.",
    originalConversationTitle: input.thread.title,
    omittedOlderMessageCount: input.allMessages.length - input.selectedMessages.length,
    omittedRetainedAttachmentCount: input.omittedRetainedAttachmentCount,
    transcript: input.selectedMessages.map((message) =>
      messageRecord(message, input.reattachedIds),
    ),
  };
  return JSON.stringify(payload);
}

function uniqueAttachments(
  messages: ReadonlyArray<OrchestrationMessage>,
): ReadonlyArray<ChatAttachment> {
  const byId = new Map<string, ChatAttachment>();
  for (const message of messages) {
    for (const attachment of message.attachments ?? []) {
      byId.set(attachment.id, attachment);
    }
  }
  return [...byId.values()];
}

function selectTranscriptTail(input: {
  readonly thread: Pick<OrchestrationThread, "title" | "messages">;
  readonly allMessages: ReadonlyArray<OrchestrationMessage>;
  readonly maxChars: number;
}): ReadonlyArray<OrchestrationMessage> {
  const selected: OrchestrationMessage[] = [];
  const noAttachments = new Set<string>();
  const allAttachments = uniqueAttachments(input.allMessages);
  for (const message of input.allMessages.toReversed()) {
    const candidate = [message, ...selected];
    const encoded = serializeTranscriptPayload({
      thread: input.thread,
      allMessages: input.allMessages,
      selectedMessages: candidate,
      reattachedIds: noAttachments,
      omittedRetainedAttachmentCount: allAttachments.length,
    });
    if (encoded.length > input.maxChars) break;
    selected.unshift(message);
  }

  if (selected.length > 0) return selected;

  // Even with an unusually small remaining provider budget, retain a valid
  // JSON record for the newest message instead of truncating serialized JSON.
  const latest = input.allMessages.at(-1);
  if (latest === undefined) return [];
  let low = 0;
  let high = latest.text.length;
  let fitted: OrchestrationMessage | undefined;
  while (low <= high) {
    const size = Math.floor((low + high) / 2);
    const candidate = { ...latest, text: truncateText(latest.text, size) };
    const encoded = serializeTranscriptPayload({
      thread: input.thread,
      allMessages: input.allMessages,
      selectedMessages: [candidate],
      reattachedIds: noAttachments,
      omittedRetainedAttachmentCount: allAttachments.length,
    });
    if (encoded.length <= input.maxChars) {
      fitted = candidate;
      low = size + 1;
    } else {
      high = size - 1;
    }
  }
  return fitted === undefined ? [] : [fitted];
}

function selectRetainedAttachments(input: {
  readonly selectedMessages: ReadonlyArray<OrchestrationMessage>;
  readonly currentAttachments: ReadonlyArray<ChatAttachment>;
}): {
  readonly attachments: ReadonlyArray<ChatAttachment>;
  readonly reattachedIds: ReadonlySet<string>;
  readonly omittedCount: number;
} {
  const attachmentsById = new Map(
    input.currentAttachments.map((attachment) => [attachment.id, attachment] as const),
  );
  const reattachedIds = new Set<string>();
  const retained = uniqueAttachments(input.selectedMessages);
  for (const message of input.selectedMessages.toReversed()) {
    for (const attachment of (message.attachments ?? []).toReversed()) {
      if (attachmentsById.has(attachment.id)) {
        reattachedIds.add(attachment.id);
        continue;
      }
      if (attachmentsById.size >= PROVIDER_SEND_TURN_MAX_ATTACHMENTS) continue;
      attachmentsById.set(attachment.id, attachment);
      reattachedIds.add(attachment.id);
    }
  }
  return {
    attachments: [...attachmentsById.values()],
    reattachedIds,
    omittedCount: retained.filter((attachment) => !reattachedIds.has(attachment.id)).length,
  };
}

export interface ScientForkContextBootstrapShape {
  readonly prepareTurn: (input: {
    readonly thread: OrchestrationThread;
    readonly currentMessageId: string;
    readonly messageText: string;
    readonly attachments: ReadonlyArray<ChatAttachment>;
  }) => Effect.Effect<PreparedForkTurn, ScientForkContextBootstrapError>;
  readonly markAccepted: (input: {
    readonly threadId: ThreadId;
    readonly messageId: string;
  }) => Effect.Effect<void, ScientForkContextBootstrapError>;
  readonly beginAttempt: (input: {
    readonly threadId: ThreadId;
    readonly messageId: string;
  }) => Effect.Effect<void, ScientForkContextBootstrapError>;
  readonly markAmbiguous: (input: {
    readonly threadId: ThreadId;
    readonly messageId: string;
  }) => Effect.Effect<void, ScientForkContextBootstrapError>;
}

export class ScientForkContextBootstrap extends Context.Service<
  ScientForkContextBootstrap,
  ScientForkContextBootstrapShape
>()("t3/orchestration/scient-fork/ForkContextBootstrap/ScientForkContextBootstrap") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const prepareTurn: ScientForkContextBootstrapShape["prepareTurn"] = Effect.fn(
    "prepareScientForkTurn",
  )(function* (input) {
    const rows = yield* sql<Record<string, unknown>>`
      SELECT
        status,
        provider_bootstrap_status,
        provider_bootstrap_message_id,
        baseline_assistant_message_id,
        fork_point_turn_count
      FROM scient_thread_lineage
      WHERE thread_id = ${input.thread.id}
      LIMIT 1
    `.pipe(
      Effect.mapError(
        (cause) =>
          new ScientForkContextBootstrapError({
            threadId: input.thread.id,
            detail: "Unable to read the fork context state.",
            cause,
          }),
      ),
    );
    const row = rows[0];
    if (row === undefined) {
      return {
        input: input.messageText,
        attachments: input.attachments,
        bootstrapPending: false,
        omittedMessageCount: 0,
        omittedAttachmentCount: 0,
      };
    }
    const state = yield* decodeForkBootstrapRow(row).pipe(
      Effect.mapError(
        (cause) =>
          new ScientForkContextBootstrapError({
            threadId: input.thread.id,
            detail: "The stored fork context state is invalid.",
            cause,
          }),
      ),
    );
    if (state.provider_bootstrap_status === "completed") {
      return {
        input: input.messageText,
        attachments: input.attachments,
        bootstrapPending: false,
        omittedMessageCount: 0,
        omittedAttachmentCount: 0,
      };
    }
    if (state.status !== "ready") {
      return yield* new ScientForkContextBootstrapError({
        threadId: input.thread.id,
        detail: "The fork workspace is not ready yet.",
      });
    }
    if (
      state.provider_bootstrap_status === "sending" ||
      state.provider_bootstrap_status === "ambiguous"
    ) {
      const attemptMessageId = state.provider_bootstrap_message_id;
      const attemptIndex =
        attemptMessageId === null
          ? -1
          : input.thread.messages.findIndex((message) => message.id === attemptMessageId);
      const providerResponseExists =
        attemptIndex >= 0 &&
        input.thread.messages
          .slice(attemptIndex + 1)
          .some((message) => message.role === "assistant" && message.streaming === false);
      if (providerResponseExists) {
        const updatedAt = DateTime.formatIso(yield* DateTime.now);
        yield* sql`
          UPDATE scient_thread_lineage
          SET provider_bootstrap_status = 'completed', updated_at = ${updatedAt}
          WHERE thread_id = ${input.thread.id}
            AND provider_bootstrap_status IN ('sending', 'ambiguous')
        `.pipe(
          Effect.mapError(
            (cause) =>
              new ScientForkContextBootstrapError({
                threadId: input.thread.id,
                detail: "Unable to reconcile the accepted fork context.",
                cause,
              }),
          ),
        );
        return {
          input: input.messageText,
          attachments: input.attachments,
          bootstrapPending: false,
          omittedMessageCount: 0,
          omittedAttachmentCount: 0,
        };
      }
      return yield* new ScientForkContextBootstrapError({
        threadId: input.thread.id,
        detail:
          "Scient cannot prove whether the retained fork context was accepted. To avoid duplicating the request, create a new fork and continue there.",
      });
    }

    const currentAttachments = [
      ...new Map(
        input.attachments.map((attachment) => [attachment.id, attachment] as const),
      ).values(),
    ];
    if (currentAttachments.length > PROVIDER_SEND_TURN_MAX_ATTACHMENTS) {
      return yield* new ScientForkContextBootstrapError({
        threadId: input.thread.id,
        detail: `The latest message contains more than ${PROVIDER_SEND_TURN_MAX_ATTACHMENTS} images.`,
      });
    }

    // @effect-diagnostics-next-line preferSchemaOverJson:off - bounded internal provider prompt DTO.
    const latestMessageJson = JSON.stringify({ latestUserMessage: input.messageText });
    const contextHeader = "SCIENT_FORK_CONTEXT_JSON\n";
    const latestHeader = "\n\nLATEST_USER_MESSAGE_JSON\n";
    const wrapperOverhead = contextHeader.length + latestHeader.length + latestMessageJson.length;
    const available = PROVIDER_SEND_TURN_MAX_INPUT_CHARS - wrapperOverhead;
    if (available < MIN_BOOTSTRAP_CHARS) {
      return yield* new ScientForkContextBootstrapError({
        threadId: input.thread.id,
        detail:
          "The latest message is too long to include the retained fork context. Shorten it and retry.",
      });
    }
    const priorMessages = transcriptMessages(input.thread, state.baseline_assistant_message_id);
    if (priorMessages.length === 0) {
      if (state.fork_point_turn_count === 0) {
        return {
          input: input.messageText,
          attachments: currentAttachments,
          bootstrapPending: true,
          omittedMessageCount: 0,
          omittedAttachmentCount: 0,
        };
      }
      return yield* new ScientForkContextBootstrapError({
        threadId: input.thread.id,
        detail: "The retained fork transcript is unavailable.",
      });
    }
    const selectedMessages = selectTranscriptTail({
      thread: input.thread,
      allMessages: priorMessages,
      maxChars: available,
    });
    if (selectedMessages.length === 0) {
      return yield* new ScientForkContextBootstrapError({
        threadId: input.thread.id,
        detail: "The retained fork transcript does not fit the provider input limit.",
      });
    }
    const retainedAttachments = selectRetainedAttachments({
      selectedMessages,
      currentAttachments,
    });
    const context = serializeTranscriptPayload({
      thread: input.thread,
      allMessages: priorMessages,
      selectedMessages,
      reattachedIds: retainedAttachments.reattachedIds,
      omittedRetainedAttachmentCount: retainedAttachments.omittedCount,
    });

    return {
      input: `${contextHeader}${context}${latestHeader}${latestMessageJson}`,
      attachments: retainedAttachments.attachments,
      bootstrapPending: true,
      omittedMessageCount: priorMessages.length - selectedMessages.length,
      omittedAttachmentCount: retainedAttachments.omittedCount,
    };
  });

  const beginAttempt: ScientForkContextBootstrapShape["beginAttempt"] = Effect.fn(
    "beginScientForkContextAttempt",
  )(function* (input) {
    const updatedAt = DateTime.formatIso(yield* DateTime.now);
    const updated = yield* sql<{ readonly thread_id: string }>`
      UPDATE scient_thread_lineage
      SET
        provider_bootstrap_status = 'sending',
        provider_bootstrap_message_id = ${input.messageId},
        provider_bootstrap_started_at = ${updatedAt},
        updated_at = ${updatedAt}
      WHERE thread_id = ${input.threadId}
        AND status = 'ready'
        AND provider_bootstrap_status = 'pending'
      RETURNING thread_id
    `.pipe(
      Effect.mapError(
        (cause) =>
          new ScientForkContextBootstrapError({
            threadId: input.threadId,
            detail: "Unable to reserve delivery of the retained fork context.",
            cause,
          }),
      ),
    );
    if (updated.length === 0) {
      return yield* new ScientForkContextBootstrapError({
        threadId: input.threadId,
        detail: "The retained fork context is already being delivered or was already used.",
      });
    }
  });

  const markAccepted: ScientForkContextBootstrapShape["markAccepted"] = Effect.fn(
    "markScientForkContextAccepted",
  )(function* (input) {
    const updatedAt = DateTime.formatIso(yield* DateTime.now);
    // markAccepted can only complete bootstrap for the exact reserved message
    // on a ready fork. Non-ready forks (pending, provisioning, failed,
    // abandoned) must never reach a completed acceptance marker. The
    // provider_mode compatibility column is not checked here; the canonical
    // model guarantees transcript-bootstrap through insertPendingFork and
    // migration 3 normalization.
    const updated = yield* sql<{ readonly thread_id: string }>`
      UPDATE scient_thread_lineage
      SET provider_bootstrap_status = 'completed', updated_at = ${updatedAt}
      WHERE thread_id = ${input.threadId}
        AND status = 'ready'
        AND provider_bootstrap_status = 'sending'
        AND provider_bootstrap_message_id = ${input.messageId}
      RETURNING thread_id
    `.pipe(
      Effect.mapError(
        (cause) =>
          new ScientForkContextBootstrapError({
            threadId: input.threadId,
            detail: "Unable to record the accepted fork context.",
            cause,
          }),
      ),
    );
    if (updated.length > 0) return;

    // A guarded UPDATE can legitimately affect zero rows for an already
    // accepted ready fork. All other zero-row cases must be surfaced instead
    // of silently reporting success.
    const rows = yield* sql<{
      readonly status: string;
      readonly provider_bootstrap_status: string;
    }>`
      SELECT status, provider_bootstrap_status
      FROM scient_thread_lineage
      WHERE thread_id = ${input.threadId}
      LIMIT 1
    `.pipe(
      Effect.mapError(
        (cause) =>
          new ScientForkContextBootstrapError({
            threadId: input.threadId,
            detail: "Unable to read the fork context state.",
            cause,
          }),
      ),
    );
    const row = rows[0];
    if (row === undefined) {
      return yield* new ScientForkContextBootstrapError({
        threadId: input.threadId,
        detail: "The fork context state was not found.",
      });
    }
    if (row.status === "ready" && row.provider_bootstrap_status === "completed") return;
    return yield* new ScientForkContextBootstrapError({
      threadId: input.threadId,
      detail: "The fork workspace is not ready to accept context.",
    });
  });

  const markAmbiguous: ScientForkContextBootstrapShape["markAmbiguous"] = Effect.fn(
    "markScientForkContextAmbiguous",
  )(function* (input) {
    const updatedAt = DateTime.formatIso(yield* DateTime.now);
    const updated = yield* sql<{ readonly thread_id: string }>`
      UPDATE scient_thread_lineage
      SET provider_bootstrap_status = 'ambiguous', updated_at = ${updatedAt}
      WHERE thread_id = ${input.threadId}
        AND status = 'ready'
        AND provider_bootstrap_status = 'sending'
        AND provider_bootstrap_message_id = ${input.messageId}
      RETURNING thread_id
    `.pipe(
      Effect.mapError(
        (cause) =>
          new ScientForkContextBootstrapError({
            threadId: input.threadId,
            detail: "Unable to record the uncertain fork context delivery.",
            cause,
          }),
      ),
    );
    if (updated.length > 0) return;

    const rows = yield* sql<{
      readonly status: string;
      readonly provider_bootstrap_status: string;
      readonly provider_bootstrap_message_id: string | null;
    }>`
      SELECT status, provider_bootstrap_status, provider_bootstrap_message_id
      FROM scient_thread_lineage
      WHERE thread_id = ${input.threadId}
      LIMIT 1
    `.pipe(
      Effect.mapError(
        (cause) =>
          new ScientForkContextBootstrapError({
            threadId: input.threadId,
            detail: "Unable to read the uncertain fork context state.",
            cause,
          }),
      ),
    );
    const row = rows[0];
    if (
      row?.status === "ready" &&
      ((row.provider_bootstrap_status === "ambiguous" &&
        row.provider_bootstrap_message_id === input.messageId) ||
        row.provider_bootstrap_status === "completed")
    ) {
      return;
    }
    return yield* new ScientForkContextBootstrapError({
      threadId: input.threadId,
      detail: "The uncertain fork context delivery does not match the reserved message.",
    });
  });

  return {
    prepareTurn,
    beginAttempt,
    markAccepted,
    markAmbiguous,
  } satisfies ScientForkContextBootstrapShape;
});

export const ScientForkContextBootstrapLive = Layer.effect(ScientForkContextBootstrap, make);

export const testLayer = (
  overrides?: Partial<ScientForkContextBootstrapShape>,
): Layer.Layer<ScientForkContextBootstrap> =>
  Layer.succeed(ScientForkContextBootstrap, {
    prepareTurn: (input) =>
      Effect.succeed({
        input: input.messageText,
        attachments: input.attachments,
        bootstrapPending: false,
        omittedMessageCount: 0,
        omittedAttachmentCount: 0,
      }),
    beginAttempt: () => Effect.void,
    markAccepted: () => Effect.void,
    markAmbiguous: () => Effect.void,
    ...overrides,
  });
