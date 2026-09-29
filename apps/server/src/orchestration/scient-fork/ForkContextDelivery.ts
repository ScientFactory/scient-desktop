/**
 * Conversation context for provider sessions that do not hold it natively.
 *
 * SCIENT-OWNED. Replaces the single `provider_bootstrap_status` flag with
 * upstream Orchestration V2's model:
 *
 * - A fork records one **context transfer** (pending until its first dispatch).
 * - Context reaches the provider as a **handoff** delivered to one specific
 *   provider-native thread (`nativeThreadKey`). Any native thread that has not
 *   received it gets it again: a Codex resume that silently fell back to a new
 *   thread, a provider switch, or a session started after a crash.
 * - Delivery is `pending` while the send is in flight and `inline` once the
 *   provider accepted it. A failure that provably sent nothing removes the
 *   pending row, so a retry simply works. A failure that may have reached the
 *   provider, or a pending row found after a restart without provider
 *   evidence, is uncertain: the next turn starts a fresh provider session and
 *   delivers again, so a duplicate can only exist in the abandoned session and
 *   the user never reaches a dead end.
 * - "Accepted" is not proof: some adapters only enqueue in memory. A handoff
 *   counts as received once the provider reported the turn it carried
 *   (matched to the send receipt's turn id, or the pending message for older
 *   receipts), or while that turn still runs. A send receipt alone is not proof:
 *   the carrying turn must also exist in the durable turn projection.
 *   Completed legacy deliveries are the explicit upgrade exception: migration
 *   16 assumes continuity with their saved session, subject to durable undo checks.
 * - A revert that removes the turn which carried the handoff supersedes it
 *   (V2: rollback supersedes handoffs); the next turn delivers again.
 *
 * Only threads with a transfer row use this path: forks, and imported
 * conversations (`type = 'import'`, no local source thread; their history is
 * the thread's own imported records). Fork-only operations (native-fork
 * planning, which reads the source thread and its lineage) never apply to
 * imports. The mechanism itself is thread-generic so it can later cover every
 * thread, as V2 does.
 */
import {
  PROVIDER_CONTEXT_PREAMBLE_MAX_CHARS,
  ThreadForkMidTurnCut,
  ThreadId,
  TurnId,
  type ChatAttachment,
  type ModelSelection,
  type OrchestrationMessage,
  type OrchestrationThread,
} from "@t3tools/contracts";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { ProviderAdapterRegistry } from "../../provider/Services/ProviderAdapterRegistry.ts";
import { resolveForkModelWindow } from "./context/modelContextWindow.ts";
import { nativeThreadKey } from "./context/nativeThreadKey.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import {
  attachmentTokenAllowance,
  estimateTokens,
  handoffBudget,
  handoffTokenCap,
  type ModelContextUsage,
} from "./context/handoffBudget.ts";
import {
  buildHandoffItems,
  importedHistoryKind,
  renderHandoff,
  selectHistory,
} from "./context/handoffHistory.ts";

export class ScientForkContextError extends Schema.TaggedError<ScientForkContextError>()(
  "ScientForkContextError",
  {
    threadId: ThreadId,
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

export type ForkTurnContext =
  | { readonly kind: "none" }
  | {
      readonly kind: "deliver";
      readonly handoffId: string;
      readonly contextPreamble: string;
      readonly attachments: ReadonlyArray<ChatAttachment>;
      /** The previous delivery may have reached the current provider session. */
      readonly requireFreshSession: boolean;
      readonly includedItemCount: number;
      readonly omittedItemCount: number;
      readonly budgetTokens: number;
      readonly requestTokenBudget: number;
    };

/** Where a native fork clones from: the source's provider thread, through a turn. */
export interface NativeForkPlan {
  readonly resumeCursor: unknown;
  readonly throughTurnId: TurnId;
}

export type ForkDeliveryOutcome =
  | { readonly type: "notSent" }
  | {
      readonly type: "accepted";
      readonly nativeThreadKey: string | null;
      /** The send receipt identifies the carrying turn even if a reset cleared its pending message. */
      readonly turnId?: TurnId;
    }
  | { readonly type: "maybeDelivered" };

/**
 * The thread a turn belongs to: its full history, or a way to read it that
 * runs only when the turn must carry a handoff, so a thread whose history
 * was already delivered is never read in full again.
 */
type PrepareTurnThread =
  | { readonly thread: OrchestrationThread }
  | {
      readonly threadId: ThreadId;
      readonly loadThread: Effect.Effect<OrchestrationThread, ScientForkContextError>;
    };

export interface ScientForkContextDeliveryShape {
  /** Decides what context this turn must carry. Non-fork threads pass through. */
  readonly prepareTurn: (
    input: PrepareTurnThread & {
      readonly message: OrchestrationMessage;
      readonly userText: string;
      readonly attachments: ReadonlyArray<ChatAttachment>;
      readonly nativeThreadKey: string | null;
      /** A turn of this thread is starting or running in the current session. */
      readonly sessionRunning: boolean;
      readonly modelContextWindow?: number | undefined;
      readonly modelSelection?: ModelSelection | undefined;
    },
  ) => Effect.Effect<ForkTurnContext, ScientForkContextError>;
  /** Records the delivery as pending immediately before dispatch. */
  readonly beginDelivery: (input: {
    readonly threadId: ThreadId;
    readonly handoffId: string;
    readonly messageId: string;
    /** The provider-native thread the send targets, when known. */
    readonly nativeThreadKey: string | null;
    readonly includedItemCount: number;
    readonly omittedItemCount: number;
    readonly budgetTokens: number;
    readonly contextPreamble?: string;
    readonly attachmentIds?: ReadonlyArray<string>;
  }) => Effect.Effect<void, ScientForkContextError>;
  readonly settleDelivery: (input: {
    readonly threadId: ThreadId;
    readonly handoffId: string;
    readonly outcome: ForkDeliveryOutcome;
  }) => Effect.Effect<void, ScientForkContextError>;
  /**
   * A native provider fork is possible for this fork's first session: same
   * provider instance as the source, a completed turn the source's provider
   * thread itself produced, no running-turn cut, nothing delivered yet.
   */
  readonly planNativeFork: (input: {
    readonly threadId: ThreadId;
    readonly providerInstanceId: string;
  }) => Effect.Effect<NativeForkPlan | null, ScientForkContextError>;
  /** The provider cloned the conversation natively: nothing to hand off. */
  readonly recordNativeFork: (input: {
    readonly threadId: ThreadId;
    readonly nativeThreadKey: string | null;
  }) => Effect.Effect<void, ScientForkContextError>;
  /** Native fork was attempted and failed; the portable handoff is used instead. */
  readonly recordNativeForkUnavailable: (input: {
    readonly threadId: ThreadId;
    readonly reason: string;
  }) => Effect.Effect<void, ScientForkContextError>;
  /** Supersedes handoffs whose carrying turn the revert removed. */
  readonly onThreadReverted: (input: {
    readonly threadId: ThreadId;
    readonly turnCount: number;
  }) => Effect.Effect<void, ScientForkContextError>;
}

export class ScientForkContextDelivery extends Context.Service<
  ScientForkContextDelivery,
  ScientForkContextDeliveryShape
>()("t3/orchestration/scient-fork/ForkContextDelivery/ScientForkContextDelivery") {}

const HandoffRow = Schema.Struct({
  handoff_id: Schema.String,
  strategy: Schema.String,
  native_thread_key: Schema.NullOr(Schema.String),
  rebind_pending: Schema.Number,
  delivery_status: Schema.Literals(["pending", "inline", "superseded"]),
  message_id: Schema.NullOr(Schema.String),
  turn_id: Schema.NullOr(Schema.String),
  accepted_turn_id: Schema.NullOr(Schema.String),
  continuity_basis: Schema.Literals(["delivery", "legacy_assumed"]),
  legacy_revert_sequence: Schema.NullOr(Schema.Number),
});
type HandoffRow = typeof HandoffRow.Type;
const decodeHandoffRows = Schema.decodeUnknownEffect(Schema.Array(HandoffRow));

const TransferRow = Schema.Struct({
  type: Schema.String,
  status: Schema.String,
  /** Null for imports: an imported thread has no local source. */
  source_thread_id: Schema.NullOr(Schema.String),
  mid_turn_cut_json: Schema.NullOr(Schema.String),
});
const decodeTransferRows = Schema.decodeUnknownEffect(Schema.Array(TransferRow));
const decodeMidTurnCut = Schema.decodeUnknownOption(Schema.fromJsonString(ThreadForkMidTurnCut));
const decodeUsageJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown));

const NATIVE_FORK_STRATEGY = "native_fork";
const LEGACY_FORK_BOUNDARY_TURN_ID = "legacy-fork-boundary";
const decodeUnknownJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown));

/** Keeps the preamble well under the transport ceiling for any window. */
const MAX_BUDGET_TOKENS = Math.floor(PROVIDER_CONTEXT_PREAMBLE_MAX_CHARS / 4);

const handoffTokenCapOverride = Config.Int("T3CODE_CONTEXT_HANDOFF_TOKEN_CAP").pipe(
  Config.option,
  Config.map(Option.getOrUndefined),
);

function usageFromPayload(payload: unknown): ModelContextUsage | undefined {
  if (!Predicate.isObject(payload)) return undefined;
  const record = payload as Record<string, unknown>;
  const number = (value: unknown) =>
    typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
  return {
    maxTokens: number(record.maxTokens),
    usedTokens: number(record.usedTokens),
    autoCompactThreshold: number(record.autoCompactThreshold),
  };
}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const settings = yield* ServerSettingsService;
  const registry = yield* Effect.serviceOption(ProviderAdapterRegistry);
  const crypto = yield* Crypto.Crypto;
  const tokenCapOverride = yield* handoffTokenCapOverride.pipe(
    Effect.orElseSucceed(() => undefined),
  );
  /** Handoffs whose send is in flight in this process. */
  const inFlight = new Set<string>();

  const fail = (threadId: ThreadId, detail: string) => (cause: unknown) =>
    new ScientForkContextError({ threadId, detail, cause });

  const now = Effect.map(DateTime.now, DateTime.formatIso);

  const readTransfer = (threadId: ThreadId) =>
    sql<Record<string, unknown>>`
      SELECT
        transfer.type AS type,
        transfer.status AS status,
        transfer.source_thread_id AS source_thread_id,
        lineage.mid_turn_cut_json AS mid_turn_cut_json
      FROM scient_context_transfers AS transfer
      LEFT JOIN scient_thread_lineage AS lineage ON lineage.thread_id = transfer.thread_id
      WHERE transfer.thread_id = ${threadId}
      LIMIT 1
    `.pipe(
      Effect.flatMap(decodeTransferRows),
      Effect.map((rows) => rows[0]),
      Effect.mapError(fail(threadId, "Unable to read the conversation context state.")),
    );

  const readActiveHandoffs = (threadId: ThreadId) =>
    sql<Record<string, unknown>>`
      SELECT
        handoff_id, strategy, native_thread_key, rebind_pending, delivery_status, message_id, turn_id, accepted_turn_id,
        continuity_basis, legacy_revert_sequence
      FROM scient_context_handoffs
      WHERE thread_id = ${threadId} AND delivery_status IN ('pending', 'inline')
      ORDER BY created_at DESC, handoff_id DESC
    `.pipe(
      Effect.flatMap(decodeHandoffRows),
      Effect.mapError(fail(threadId, "Unable to read the conversation context deliveries.")),
    );

  /** The provider reported the turn this message started. */
  const providerTurnFor = (
    threadId: ThreadId,
    messageId: string | null,
    acceptedTurnId: string | null = null,
  ) =>
    messageId === null && acceptedTurnId === null
      ? Effect.succeed<string | undefined>(undefined)
      : sql<{ readonly turn_id: string }>`
          SELECT turn_id FROM projection_turns
          WHERE thread_id = ${threadId}
            AND turn_id IS NOT NULL
            AND state <> 'pending'
            AND (
              (${acceptedTurnId} IS NULL AND pending_message_id = ${messageId})
              OR (turn_id = ${acceptedTurnId}
                AND (pending_message_id = ${messageId}
                  OR (pending_message_id IS NULL AND state IN ('running', 'completed', 'error'))))
            )
          LIMIT 1
        `.pipe(
          Effect.map((rows) => rows[0]?.turn_id),
          Effect.mapError(fail(threadId, "Unable to read provider delivery evidence.")),
        );

  const latestUsage = (threadId: string) =>
    sql<{ readonly payload_json: string }>`
      SELECT payload_json FROM projection_thread_activities
      WHERE thread_id = ${threadId} AND kind = 'context-window.updated'
      ORDER BY created_at DESC
      LIMIT 1
    `.pipe(
      Effect.map((rows) =>
        rows[0] === undefined
          ? undefined
          : Option.match(decodeUsageJson(rows[0].payload_json), {
              onNone: () => undefined,
              onSome: usageFromPayload,
            }),
      ),
      Effect.orElseSucceed(() => undefined),
    );

  const updateHandoff = (
    threadId: ThreadId,
    handoffId: string,
    fields: {
      readonly deliveryStatus?: HandoffRow["delivery_status"];
      readonly nativeThreadKey?: string | null;
      readonly rebindPending?: boolean;
      readonly turnId?: string;
      readonly acceptedTurnId?: string;
      /** Only update a row still in this status (a concurrent turn may have moved it). */
      readonly onlyIfStatus?: HandoffRow["delivery_status"];
    },
  ) =>
    Effect.gen(function* () {
      const updatedAt = yield* now;
      yield* sql`
        UPDATE scient_context_handoffs
        SET
          delivery_status = COALESCE(${fields.deliveryStatus ?? null}, delivery_status),
          native_thread_key = ${
            fields.nativeThreadKey === undefined
              ? sql`native_thread_key`
              : sql`${fields.nativeThreadKey}`
          },
          rebind_pending = ${
            fields.rebindPending === undefined
              ? sql`rebind_pending`
              : sql`${fields.rebindPending ? 1 : 0}`
          },
          turn_id = COALESCE(${fields.turnId ?? null}, turn_id),
          accepted_turn_id = COALESCE(${fields.acceptedTurnId ?? null}, accepted_turn_id),
          updated_at = ${updatedAt}
        WHERE handoff_id = ${handoffId}
          AND (${fields.onlyIfStatus ?? null} IS NULL OR delivery_status = ${fields.onlyIfStatus ?? null})
      `;
    }).pipe(Effect.mapError(fail(threadId, "Unable to update the conversation context delivery.")));

  const setTransferStatus = (
    threadId: ThreadId,
    status: "resolved_portable" | "consumed",
    handoffId: string,
    fidelity: string,
  ) =>
    Effect.gen(function* () {
      const updatedAt = yield* now;
      // @effect-diagnostics-next-line preferSchemaOverJson:off - fixed two-field record.
      const resolution = JSON.stringify({ type: "portable_context", handoffId });
      yield* sql`
        UPDATE scient_context_transfers
        SET
          status = ${status},
          resolution_json = ${resolution},
          fidelity = ${fidelity},
          updated_at = ${updatedAt}
        WHERE thread_id = ${threadId}
          AND (status IN ('pending', 'resolved_portable', 'resolved_native') OR ${status} = 'consumed')
      `;
    }).pipe(Effect.mapError(fail(threadId, "Unable to update the conversation context transfer.")));

  /**
   * Whether the current provider session already holds the conversation.
   * Returns `requireFreshSession` when a previous delivery is uncertain.
   */
  const resolveExistingDelivery = Effect.fnUntraced(function* (input: {
    readonly threadId: ThreadId;
    readonly nativeThreadKey: string | null;
    readonly sessionRunning: boolean;
  }): Effect.fn.Return<
    { delivered: boolean; requireFreshSession: boolean },
    ScientForkContextError
  > {
    for (const handoff of yield* readActiveHandoffs(input.threadId)) {
      if (inFlight.has(handoff.handoff_id)) {
        // This caller runs on the provider command queue shared by every
        // thread, so it must never wait for the send to return: some providers
        // hold it open for the whole turn. The provider starting the turn that
        // carries the history is the proof of delivery; until then (usually a
        // second or two) the next message is refused, not queued behind it.
        const carriedBy = yield* providerTurnFor(input.threadId, handoff.message_id);
        const sameSession =
          handoff.native_thread_key === null ||
          input.nativeThreadKey === null ||
          handoff.native_thread_key === input.nativeThreadKey;
        if (carriedBy !== undefined && sameSession) {
          return { delivered: true, requireFreshSession: false };
        }
        return yield* new ScientForkContextError({
          threadId: input.threadId,
          detail:
            "This thread is still sending its conversation history to the provider. Send your message again in a moment.",
        });
      }
      const sameThread =
        input.nativeThreadKey !== null && handoff.native_thread_key === input.nativeThreadKey;
      const native = handoff.strategy === NATIVE_FORK_STRATEGY;
      const turnId = yield* providerTurnFor(
        input.threadId,
        handoff.message_id,
        handoff.accepted_turn_id,
      );

      const legacyAssumed = handoff.continuity_basis === "legacy_assumed";
      if (legacyAssumed && handoff.turn_id === null) {
        // Old deliveries may have no carrying-turn evidence. Any later undo
        // invalidates their upgrade assumption, even if its live event was lost.
        const [revert] = yield* sql<{ readonly sequence: number }>`
          SELECT COALESCE(MAX(sequence), 0) AS sequence FROM orchestration_events
          WHERE aggregate_kind = 'thread' AND stream_id = ${input.threadId}
            AND event_type = 'thread.reverted'
        `.pipe(Effect.mapError(fail(input.threadId, "Unable to verify legacy fork continuity.")));
        if (handoff.legacy_revert_sequence !== revert?.sequence) {
          return { delivered: false, requireFreshSession: true };
        }
      }

      // Reconcile even cached evidence against durable history. A revert can
      // commit before its live notification reaches this service.
      if (!native && handoff.turn_id !== null && turnId !== handoff.turn_id) {
        yield* updateHandoff(input.threadId, handoff.handoff_id, { deliveryStatus: "superseded" });
        continue;
      }
      if (
        sameThread &&
        (legacyAssumed ||
          native ||
          turnId !== undefined ||
          (handoff.delivery_status === "inline" &&
            input.sessionRunning &&
            handoff.rebind_pending === 0))
      ) {
        yield* updateHandoff(input.threadId, handoff.handoff_id, {
          deliveryStatus: "inline",
          rebindPending: false,
          ...(turnId === undefined ? {} : { turnId }),
        });
        if (!native && turnId !== undefined) {
          yield* setTransferStatus(input.threadId, "consumed", handoff.handoff_id, "portable");
        }
        return { delivered: true, requireFreshSession: false };
      }
      // A replacement may be either fresh or a rollback retaining history.
      // Without concrete continuity proof, reset it before sending. Keep the
      // old row active until beginDelivery, after reset has actually succeeded;
      // a crash or failed reset must preserve this requirement on the next try.
      return { delivered: false, requireFreshSession: true };
    }
    return { delivered: false, requireFreshSession: false };
  });

  /**
   * Whether the current provider thread already holds this conversation's
   * later turns (a revert superseded the handoff but kept the thread). Only
   * then does its reported usage reduce the budget; a new or replaced thread
   * holds nothing.
   */
  const currentThreadHoldsTurns = (threadId: ThreadId, nativeThreadKey: string | null) =>
    nativeThreadKey === null
      ? Effect.succeed(false)
      : sql<{ readonly native_thread_key: string | null }>`
          SELECT native_thread_key FROM scient_context_handoffs
          WHERE thread_id = ${threadId} AND delivery_status = 'superseded'
          ORDER BY updated_at DESC
          LIMIT 1
        `.pipe(
          Effect.map((rows) => rows[0]?.native_thread_key === nativeThreadKey),
          Effect.orElseSucceed(() => false),
        );

  const prepareTurn: ScientForkContextDeliveryShape["prepareTurn"] = Effect.fn(
    "prepareScientForkContext",
  )(function* (input) {
    const threadId = "thread" in input ? input.thread.id : input.threadId;
    const transfer = yield* readTransfer(threadId);
    if (transfer === undefined) return { kind: "none" } as const;

    const existing = yield* resolveExistingDelivery({
      threadId,
      nativeThreadKey: input.nativeThreadKey,
      sessionRunning: input.sessionRunning,
    });
    if (existing.delivered) return { kind: "none" } as const;
    const thread = "thread" in input ? input.thread : yield* input.loadThread;

    const midTurnCut =
      transfer.mid_turn_cut_json === null
        ? undefined
        : Option.getOrUndefined(decodeMidTurnCut(transfer.mid_turn_cut_json));
    const items = buildHandoffItems({
      messages: thread.messages,
      activities: thread.activities,
      proposedPlans: thread.proposedPlans,
      beforeMessageId: input.message.id,
      // Imported history is an inherited prefix, whatever the clocks say.
      inheritedThrough:
        transfer.type === "import" ? thread.conversationImport?.importedAt : undefined,
      midTurnCut,
    });
    if (items.length === 0) {
      // A fork from the conversation's start has nothing to carry.
      if (transfer.status === "pending") {
        yield* setTransferStatus(thread.id, "consumed", "empty_context", "portable");
      }
      return { kind: "none" } as const;
    }

    const serverSettings = yield* settings.getSettings.pipe(
      Effect.mapError(fail(thread.id, "Unable to read the fork settings.")),
    );
    const ownUsage = yield* latestUsage(thread.id);
    // Usage windows belong to a model and session; a source thread's window
    // cannot size a destination, especially after a model switch.
    const modelWindow =
      input.modelContextWindow ??
      (yield* resolveForkModelWindow({
        threadId: thread.id,
        modelSelection: input.modelSelection ?? thread.modelSelection,
        settings: serverSettings,
        registry: Option.getOrUndefined(registry),
        sql,
      }).pipe(
        Effect.mapError(fail(thread.id, "Unable to resolve the destination model capacity.")),
      ));
    const usage = modelWindow === undefined ? undefined : { maxTokens: modelWindow };
    const holdsTurns =
      !existing.requireFreshSession &&
      (yield* currentThreadHoldsTurns(thread.id, input.nativeThreadKey));
    const requestTokenBudget = handoffBudget({
      tokenCap: null,
      userText: "",
      attachments: [],
      usage,
      nativeUsedTokens: holdsTurns ? (ownUsage?.usedTokens ?? 0) : 0,
    });
    const budget = Math.min(
      MAX_BUDGET_TOKENS,
      handoffBudget({
        tokenCap: handoffTokenCap(serverSettings.scientFork.contextHandoffSize, tokenCapOverride),
        userText: input.userText,
        attachments: input.attachments,
        usage,
        // A new or replaced provider thread holds nothing yet; a thread that is
        // re-receiving after a revert still holds its own later turns.
        nativeUsedTokens: holdsTurns ? (ownUsage?.usedTokens ?? 0) : 0,
      }),
    );
    const imported = importedHistoryKind({
      transferType: transfer.type,
      conversationImport: thread.conversationImport,
      sourceImport: thread.forkLineage?.sourceImport,
    });
    const importOmissions =
      thread.forkLineage?.sourceImport?.omissions ?? thread.conversationImport?.omissions;
    // The purpose and coverage header travel too: charge them before items.
    const headerTokens = estimateTokens(
      renderHandoff({
        threadId: thread.id,
        title: thread.title,
        selection: {
          items: [],
          omittedItemIds: items.map((item) => item.itemId),
          reattached: [],
          usedTokens: 0,
        },
        totalItemCount: items.length,
        midTurnCut,
        imported,
        importOmissions,
      }).preamble,
    );
    const selection = selectHistory({
      items,
      budget: Math.max(0, budget - headerTokens),
      currentAttachments: input.attachments,
      midTurnCut,
    });
    const rendered = renderHandoff({
      threadId: thread.id,
      title: thread.title,
      selection,
      totalItemCount: items.length,
      midTurnCut,
      imported,
      importOmissions,
    });
    const renderedTokens =
      estimateTokens(rendered.preamble) + attachmentTokenAllowance(selection.reattached);
    if (renderedTokens > budget)
      return yield* new ScientForkContextError({
        threadId: thread.id,
        detail:
          "This model has insufficient room for the conversation history header and current message. Shorten the message or choose a larger-context model; nothing was sent.",
      });
    const handoffId = `handoff:${yield* crypto.randomUUIDv4.pipe(
      Effect.mapError(fail(thread.id, "Unable to identify the context delivery.")),
    )}`;
    return {
      kind: "deliver",
      handoffId,
      contextPreamble: rendered.preamble,
      attachments: [...input.attachments, ...selection.reattached],
      requireFreshSession: existing.requireFreshSession,
      includedItemCount: rendered.includedItemCount,
      omittedItemCount: rendered.omittedItemCount,
      budgetTokens: budget,
      requestTokenBudget,
    } as const;
  });

  const beginDelivery: ScientForkContextDeliveryShape["beginDelivery"] = Effect.fn(
    "beginScientForkContextDelivery",
  )(function* (input) {
    const createdAt = yield* now;
    const attachmentIdsJson =
      input.attachmentIds === undefined
        ? null
        : yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Array(Schema.String)))(
            input.attachmentIds,
          ).pipe(Effect.mapError(fail(input.threadId, "Unable to encode delivery attachments.")));
    yield* sql
      .withTransaction(
        Effect.gen(function* () {
          yield* sql`UPDATE scient_context_handoffs SET delivery_status = 'superseded', updated_at = ${createdAt}
        WHERE thread_id = ${input.threadId} AND delivery_status IN ('pending', 'inline')`;
          yield* sql`
      INSERT INTO scient_context_handoffs (
        handoff_id,
        thread_id,
        strategy,
        native_thread_key,
        delivery_status,
        message_id,
        included_item_count,
        omitted_item_count,
        budget_tokens,
        context_preamble,
        attachment_ids_json,
        created_at,
        updated_at
      ) VALUES (
        ${input.handoffId},
        ${input.threadId},
        'full_thread_summary',
        ${input.nativeThreadKey},
        'pending',
        ${input.messageId},
        ${input.includedItemCount},
        ${input.omittedItemCount},
        ${input.budgetTokens},
        ${input.contextPreamble ?? null},
        ${attachmentIdsJson},
        ${createdAt},
        ${createdAt}
      )
      `;
          // Keep the current preamble and three preceding artifacts. Older
          // receipts retain their status/counts without repeated megabyte text.
          yield* sql`UPDATE scient_context_handoffs SET context_preamble = NULL, attachment_ids_json = NULL
            WHERE thread_id = ${input.threadId} AND delivery_status = 'superseded'
              AND handoff_id NOT IN (SELECT handoff_id FROM scient_context_handoffs
                WHERE thread_id = ${input.threadId} ORDER BY rowid DESC LIMIT 4)`;
        }),
      )
      .pipe(Effect.mapError(fail(input.threadId, "Unable to record the context delivery.")));
    inFlight.add(input.handoffId);
  });

  const settleOutcome: ScientForkContextDeliveryShape["settleDelivery"] = Effect.fn(
    "settleScientForkContextDelivery",
  )(function* (input) {
    switch (input.outcome.type) {
      case "notSent":
        // Nothing left the process: the thread is exactly as before.
        yield* sql`DELETE FROM scient_context_handoffs WHERE handoff_id = ${input.handoffId}`.pipe(
          Effect.mapError(fail(input.threadId, "Unable to clear the unsent context delivery.")),
        );
        return;
      case "maybeDelivered":
        // Stays pending: the next turn settles it from provider evidence or
        // delivers again on a fresh provider session.
        return;
      case "accepted": {
        yield* updateHandoff(input.threadId, input.handoffId, {
          deliveryStatus: "inline",
          nativeThreadKey: input.outcome.nativeThreadKey,
          ...(input.outcome.turnId === undefined ? {} : { acceptedTurnId: input.outcome.turnId }),
          rebindPending: false,
          onlyIfStatus: "pending",
        });
        const cut = yield* sql<{ readonly mid_turn_cut_json: string | null }>`
          SELECT mid_turn_cut_json FROM scient_thread_lineage WHERE thread_id = ${input.threadId}
        `.pipe(Effect.orElseSucceed(() => []));
        yield* setTransferStatus(
          input.threadId,
          "resolved_portable",
          input.handoffId,
          cut[0]?.mid_turn_cut_json ? "portable_mid_turn" : "portable",
        );
        return;
      }
    }
  });

  // Clear the in-flight mark only once the outcome is durable, so a concurrent
  // turn never sees a pending row that is neither in flight nor settled.
  const settleDelivery: ScientForkContextDeliveryShape["settleDelivery"] = (input) =>
    settleOutcome(input).pipe(Effect.ensuring(Effect.sync(() => inFlight.delete(input.handoffId))));

  const planNativeFork: ScientForkContextDeliveryShape["planNativeFork"] = Effect.fn(
    "planScientNativeFork",
  )(function* (input) {
    const rows = yield* sql<{
      readonly status: string;
      readonly source_thread_id: string;
      readonly fork_point_turn_id: string | null;
      readonly inherited_turn_ids_json: string;
      readonly imported_turn_ids_json: string;
      readonly mid_turn_cut_json: string | null;
    }>`
      SELECT
        transfer.status AS status,
        transfer.source_thread_id AS source_thread_id,
        lineage.fork_point_turn_id AS fork_point_turn_id,
        lineage.mid_turn_cut_json AS mid_turn_cut_json,
        COALESCE(source_lineage.inherited_turn_ids_json, '[]') AS inherited_turn_ids_json,
        COALESCE(source_import.inherited_turn_ids_json, '[]') AS imported_turn_ids_json
      FROM scient_context_transfers AS transfer
      JOIN scient_thread_lineage AS lineage ON lineage.thread_id = transfer.thread_id
      LEFT JOIN scient_thread_lineage AS source_lineage
        ON source_lineage.thread_id = transfer.source_thread_id
      LEFT JOIN scient_context_transfers AS source_import
        ON source_import.thread_id = transfer.source_thread_id AND source_import.type = 'import'
      WHERE transfer.thread_id = ${input.threadId} AND transfer.type = 'fork'
      LIMIT 1
    `.pipe(Effect.mapError(fail(input.threadId, "Unable to read the fork's source.")));
    const fork = rows[0];
    if (
      fork === undefined ||
      fork.status !== "pending" ||
      fork.mid_turn_cut_json !== null ||
      fork.fork_point_turn_id === null ||
      fork.fork_point_turn_id === LEGACY_FORK_BOUNDARY_TURN_ID
    ) {
      return null;
    }
    // A turn the source itself inherited was never a turn of its provider thread.
    // Imported history has no strong native source ref. Keep portable until
    // that complete prefix has explicit native coverage of its own.
    if (fork.inherited_turn_ids_json !== "[]" || fork.imported_turn_ids_json !== "[]") return null;
    if ((yield* readActiveHandoffs(input.threadId)).length > 0) return null;
    // A native fork creates the fork's first provider thread; there must be none.
    const forkBinding = yield* sql<{ readonly resume_cursor_json: string | null }>`
      SELECT resume_cursor_json FROM provider_session_runtime WHERE thread_id = ${input.threadId}
    `.pipe(Effect.mapError(fail(input.threadId, "Unable to read the fork's provider thread.")));
    if (forkBinding.some((row) => row.resume_cursor_json !== null)) return null;
    const turns = yield* sql<{ readonly state: string }>`
      SELECT state FROM projection_turns
      WHERE thread_id = ${fork.source_thread_id} AND turn_id = ${fork.fork_point_turn_id}
      LIMIT 1
    `.pipe(Effect.mapError(fail(input.threadId, "Unable to read the forked turn.")));
    if (turns[0]?.state !== "completed") return null;
    const bindings = yield* sql<{
      readonly provider_instance_id: string | null;
      readonly resume_cursor_json: string | null;
      readonly provider_name: string;
    }>`
      SELECT provider_instance_id, resume_cursor_json, provider_name FROM provider_session_runtime
      WHERE thread_id = ${fork.source_thread_id}
      LIMIT 1
    `.pipe(Effect.mapError(fail(input.threadId, "Unable to read the source provider thread.")));
    const binding = bindings[0];
    if (
      binding === undefined ||
      binding.provider_instance_id !== input.providerInstanceId ||
      binding.resume_cursor_json === null
    ) {
      return null;
    }
    const resumeCursor = Option.getOrUndefined(decodeUnknownJson(binding.resume_cursor_json));
    if (resumeCursor === undefined || resumeCursor === null) return null;
    const key = nativeThreadKey(binding.provider_name, resumeCursor, binding.provider_instance_id);
    if (key === null) return null;
    const missing = yield* sql<{ readonly count: number }>`
      SELECT COUNT(*) AS count FROM projection_turns AS turn
      LEFT JOIN scient_native_turn_sources AS evidence
        ON evidence.thread_id = turn.thread_id AND evidence.turn_id = turn.turn_id
      WHERE turn.thread_id = ${fork.source_thread_id} AND turn.turn_id IS NOT NULL
        AND turn.requested_at <= (SELECT requested_at FROM projection_turns
          WHERE thread_id = ${fork.source_thread_id} AND turn_id = ${fork.fork_point_turn_id})
        AND (evidence.native_thread_key IS NULL OR evidence.native_thread_key <> ${key}
          OR evidence.provider_instance_id <> ${input.providerInstanceId})
    `.pipe(Effect.mapError(fail(input.threadId, "Unable to verify native history coverage.")));
    if (missing[0]?.count !== 0) return null;
    return { resumeCursor, throughTurnId: TurnId.make(fork.fork_point_turn_id) };
  });

  const recordNativeFork: ScientForkContextDeliveryShape["recordNativeFork"] = Effect.fn(
    "recordScientNativeFork",
  )(function* (input) {
    const now_ = yield* now;
    const handoffId = `native:${input.threadId}`;
    yield* sql`
      INSERT OR REPLACE INTO scient_context_handoffs (
        handoff_id, thread_id, strategy, native_thread_key, rebind_pending,
        delivery_status, created_at, updated_at
      ) VALUES (
        ${handoffId}, ${input.threadId}, ${NATIVE_FORK_STRATEGY}, ${input.nativeThreadKey}, 0,
        'inline', ${now_}, ${now_}
      )
    `.pipe(Effect.mapError(fail(input.threadId, "Unable to record the native fork.")));
    // @effect-diagnostics-next-line preferSchemaOverJson:off - fixed two-field record.
    const resolution = JSON.stringify({
      type: "native_fork",
      providerThreadRef: input.nativeThreadKey,
    });
    yield* sql`
      UPDATE scient_context_transfers
      SET status = 'resolved_native', resolution_json = ${resolution}, fidelity = 'native',
          error = NULL, updated_at = ${now_}
      WHERE thread_id = ${input.threadId}
    `.pipe(Effect.mapError(fail(input.threadId, "Unable to record the native fork.")));
  });

  const recordNativeForkUnavailable: ScientForkContextDeliveryShape["recordNativeForkUnavailable"] =
    Effect.fn("recordScientNativeForkUnavailable")(function* (input) {
      const updatedAt = yield* now;
      yield* sql`
        UPDATE scient_context_transfers
        SET error = ${`Native fork unavailable: ${input.reason}`.slice(0, 2_000)},
            updated_at = ${updatedAt}
        WHERE thread_id = ${input.threadId}
      `.pipe(Effect.mapError(fail(input.threadId, "Unable to record the native fork outcome.")));
    });

  const onThreadReverted: ScientForkContextDeliveryShape["onThreadReverted"] = Effect.fn(
    "scientForkContextThreadReverted",
  )(function* (input) {
    for (const handoff of yield* readActiveHandoffs(input.threadId)) {
      // Unconfirmed deliveries settle from provider evidence on the next turn.
      if (handoff.delivery_status !== "inline" || handoff.turn_id === null) continue;
      const turn = (yield* sql<{ readonly checkpoint_turn_count: number | null }>`
              SELECT checkpoint_turn_count FROM projection_turns
              WHERE thread_id = ${input.threadId} AND turn_id = ${handoff.turn_id}
              LIMIT 1
            `.pipe(Effect.mapError(fail(input.threadId, "Unable to read the reverted turns."))))[0];
      const removed =
        turn === undefined ||
        (turn.checkpoint_turn_count !== null && turn.checkpoint_turn_count > input.turnCount);
      yield* removed
        ? updateHandoff(input.threadId, handoff.handoff_id, { deliveryStatus: "superseded" })
        : // Rollback can replace the provider thread. Recheck its identity
          // before trusting retained history on the next turn.
          updateHandoff(input.threadId, handoff.handoff_id, { rebindPending: true });
    }
  });

  return {
    prepareTurn,
    beginDelivery,
    settleDelivery,
    planNativeFork,
    recordNativeFork,
    recordNativeForkUnavailable,
    onThreadReverted,
  } satisfies ScientForkContextDeliveryShape;
});

export const ScientForkContextDeliveryLive = Layer.effect(ScientForkContextDelivery, make);

export const testLayer = (
  overrides?: Partial<ScientForkContextDeliveryShape>,
): Layer.Layer<ScientForkContextDelivery> =>
  Layer.succeed(ScientForkContextDelivery, {
    prepareTurn: () => Effect.succeed({ kind: "none" } as const),
    beginDelivery: () => Effect.void,
    settleDelivery: () => Effect.void,
    planNativeFork: () => Effect.succeed(null),
    recordNativeFork: () => Effect.void,
    recordNativeForkUnavailable: () => Effect.void,
    onThreadReverted: () => Effect.void,
    ...overrides,
  });
