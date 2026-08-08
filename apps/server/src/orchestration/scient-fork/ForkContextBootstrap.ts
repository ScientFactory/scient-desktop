/**
 * Provider-neutral context continuity for exact-boundary conversation forks.
 *
 * Provider-native fork APIs generally clone the provider thread's current tip,
 * which is incorrect when a user forks an older message. Scient therefore
 * starts an independent provider session and injects the retained transcript
 * exactly once with the first post-fork user turn. The pending/completed marker
 * is durable so app restarts cannot silently lose the bootstrap.
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
  provider_mode: Schema.Literal("transcript-bootstrap"),
  provider_bootstrap_status: Schema.Literals(["pending", "completed"]),
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
}

function truncateText(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, Math.max(0, maxChars - 3)).trimEnd()}...`;
}

function transcriptMessages(
  thread: Pick<OrchestrationThread, "messages">,
  currentMessageId: string,
): ReadonlyArray<OrchestrationMessage> {
  const currentIndex = thread.messages.findIndex((message) => message.id === currentMessageId);
  if (currentIndex < 0) return [];
  return thread.messages
    .slice(0, currentIndex)
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
  readonly markAccepted: (
    threadId: ThreadId,
  ) => Effect.Effect<void, ScientForkContextBootstrapError>;
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
      SELECT status, provider_mode, provider_bootstrap_status, fork_point_turn_count
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
      };
    }
    if (state.status !== "ready") {
      return yield* new ScientForkContextBootstrapError({
        threadId: input.thread.id,
        detail: "The fork workspace is not ready yet.",
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
    const priorMessages = transcriptMessages(input.thread, input.currentMessageId);
    if (priorMessages.length === 0) {
      if (state.fork_point_turn_count === 0) {
        return {
          input: input.messageText,
          attachments: currentAttachments,
          bootstrapPending: true,
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
    };
  });

  const markAccepted: ScientForkContextBootstrapShape["markAccepted"] = Effect.fn(
    "markScientForkContextAccepted",
  )(function* (threadId) {
    const updatedAt = DateTime.formatIso(yield* DateTime.now);
    yield* sql`
      UPDATE scient_thread_lineage
      SET provider_bootstrap_status = 'completed', updated_at = ${updatedAt}
      WHERE thread_id = ${threadId}
        AND provider_mode = 'transcript-bootstrap'
        AND provider_bootstrap_status = 'pending'
    `.pipe(
      Effect.mapError(
        (cause) =>
          new ScientForkContextBootstrapError({
            threadId,
            detail: "Unable to record the accepted fork context.",
            cause,
          }),
      ),
    );
  });

  return { prepareTurn, markAccepted } satisfies ScientForkContextBootstrapShape;
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
      }),
    markAccepted: () => Effect.void,
    ...overrides,
  });
