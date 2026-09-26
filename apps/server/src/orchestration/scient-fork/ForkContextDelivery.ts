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
 *   (`projection_turns.pending_message_id`), or while that turn still runs.
 * - A revert that removes the turn which carried the handoff supersedes it
 *   (V2: rollback supersedes handoffs); the next turn delivers again.
 *
 * Only threads with a transfer row (forks) use this path. The mechanism itself
 * is thread-generic so it can later cover every thread, as V2 does.
 */
import {
  PROVIDER_CONTEXT_PREAMBLE_MAX_CHARS,
  ThreadForkMidTurnCut,
  ThreadId,
  TurnId,
  type ChatAttachment,
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

import { ServerSettingsService } from "../../serverSettings.ts";
import {
  estimateTokens,
  handoffBudget,
  handoffTokenCap,
  type ModelContextUsage,
} from "./context/handoffBudget.ts";
import { buildHandoffItems, renderHandoff, selectHistory } from "./context/handoffHistory.ts";

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
    };

/** Where a native fork clones from: the source's provider thread, through a turn. */
export interface NativeForkPlan {
  readonly resumeCursor: unknown;
  readonly throughTurnId: TurnId;
}

export type ForkDeliveryOutcome =
  | { readonly type: "notSent" }
  | { readonly type: "accepted"; readonly nativeThreadKey: string | null }
  | { readonly type: "maybeDelivered" };

export interface ScientForkContextDeliveryShape {
  /** Decides what context this turn must carry. Non-fork threads pass through. */
  readonly prepareTurn: (input: {
    readonly thread: OrchestrationThread;
    readonly message: OrchestrationMessage;
    readonly userText: string;
    readonly attachments: ReadonlyArray<ChatAttachment>;
    readonly nativeThreadKey: string | null;
    /** A turn of this thread is starting or running in the current session. */
    readonly sessionRunning: boolean;
  }) => Effect.Effect<ForkTurnContext, ScientForkContextError>;
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
});
type HandoffRow = typeof HandoffRow.Type;
const decodeHandoffRows = Schema.decodeUnknownEffect(Schema.Array(HandoffRow));

const TransferRow = Schema.Struct({
  status: Schema.String,
  source_thread_id: Schema.String,
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
        handoff_id, strategy, native_thread_key, rebind_pending, delivery_status, message_id, turn_id
      FROM scient_context_handoffs
      WHERE thread_id = ${threadId} AND delivery_status IN ('pending', 'inline')
      ORDER BY created_at DESC, handoff_id DESC
    `.pipe(
      Effect.flatMap(decodeHandoffRows),
      Effect.mapError(fail(threadId, "Unable to read the conversation context deliveries.")),
    );

  /** The provider reported the turn this message started. */
  const providerTurnFor = (threadId: ThreadId, messageId: string | null) =>
    messageId === null
      ? Effect.succeed<string | undefined>(undefined)
      : sql<{ readonly turn_id: string }>`
          SELECT turn_id FROM projection_turns
          WHERE thread_id = ${threadId}
            AND pending_message_id = ${messageId}
            AND turn_id IS NOT NULL
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
          fidelity = COALESCE(fidelity, ${fidelity}),
          updated_at = ${updatedAt}
        WHERE thread_id = ${threadId}
          AND (status IN ('pending', 'resolved_portable') OR ${status} = 'consumed')
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
  }) {
    let requireFreshSession = false;
    for (const handoff of yield* readActiveHandoffs(input.threadId)) {
      if (handoff.delivery_status === "pending") {
        // Its send is still running here; this message follows it into the
        // same provider session.
        if (inFlight.has(handoff.handoff_id)) return { delivered: true, requireFreshSession };
        const turnId = yield* providerTurnFor(input.threadId, handoff.message_id);
        const sameThread =
          handoff.native_thread_key === null ||
          input.nativeThreadKey === null ||
          handoff.native_thread_key === input.nativeThreadKey;
        if (turnId !== undefined && !sameThread) {
          // It reached a provider thread that has since been replaced.
          yield* updateHandoff(input.threadId, handoff.handoff_id, {
            deliveryStatus: "superseded",
          });
          continue;
        }
        if (turnId !== undefined) {
          // It reached the provider after all (the acknowledgement was lost or
          // the process restarted); the current session carries it.
          yield* updateHandoff(input.threadId, handoff.handoff_id, {
            deliveryStatus: "inline",
            nativeThreadKey: input.nativeThreadKey,
            rebindPending: input.nativeThreadKey === null,
            turnId,
          });
          yield* setTransferStatus(input.threadId, "consumed", handoff.handoff_id, "portable");
          return { delivered: true, requireFreshSession };
        }
        yield* updateHandoff(input.threadId, handoff.handoff_id, { deliveryStatus: "superseded" });
        requireFreshSession = true;
        continue;
      }

      // Rebinding deliveries (migrated from the old flag, or kept by a revert
      // that may have moved the provider to a new native thread) are trusted.
      const rebinding = handoff.rebind_pending === 1;
      // A native fork holds the conversation in the provider thread itself.
      const native = handoff.strategy === NATIVE_FORK_STRATEGY;
      if (!rebinding && !native && handoff.turn_id === null) {
        const turnId = yield* providerTurnFor(input.threadId, handoff.message_id);
        if (turnId !== undefined) {
          yield* updateHandoff(input.threadId, handoff.handoff_id, { turnId });
          yield* setTransferStatus(input.threadId, "consumed", handoff.handoff_id, "portable");
        } else if (!input.sessionRunning) {
          // Accepted but never started (for example an adapter that only
          // enqueued it before its process ended).
          yield* updateHandoff(input.threadId, handoff.handoff_id, {
            deliveryStatus: "superseded",
          });
          requireFreshSession = true;
          continue;
        }
      }
      // An unknown identity (recorded before the provider reported one, or a
      // rebinding delivery) adopts the current provider session.
      if (rebinding || handoff.native_thread_key === null) {
        if (input.nativeThreadKey !== null) {
          yield* updateHandoff(input.threadId, handoff.handoff_id, {
            nativeThreadKey: input.nativeThreadKey,
            rebindPending: false,
          });
        }
        return { delivered: true, requireFreshSession };
      }
      if (input.nativeThreadKey === null || input.nativeThreadKey === handoff.native_thread_key) {
        return { delivered: true, requireFreshSession };
      }
      // The provider replaced the native thread: it never received the context.
      yield* updateHandoff(input.threadId, handoff.handoff_id, { deliveryStatus: "superseded" });
    }
    return { delivered: false, requireFreshSession };
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
    const transfer = yield* readTransfer(input.thread.id);
    if (transfer === undefined) return { kind: "none" } as const;

    const existing = yield* resolveExistingDelivery({
      threadId: input.thread.id,
      nativeThreadKey: input.nativeThreadKey,
      sessionRunning: input.sessionRunning,
    });
    if (existing.delivered) return { kind: "none" } as const;

    const midTurnCut =
      transfer.mid_turn_cut_json === null
        ? undefined
        : Option.getOrUndefined(decodeMidTurnCut(transfer.mid_turn_cut_json));
    const items = buildHandoffItems({
      messages: input.thread.messages,
      activities: input.thread.activities,
      proposedPlans: input.thread.proposedPlans,
      beforeMessageId: input.message.id,
      midTurnCut,
    });
    if (items.length === 0) {
      // A fork from the conversation's start has nothing to carry.
      if (transfer.status === "pending") {
        yield* setTransferStatus(input.thread.id, "consumed", "empty_context", "portable");
      }
      return { kind: "none" } as const;
    }

    const serverSettings = yield* settings.getSettings.pipe(
      Effect.mapError(fail(input.thread.id, "Unable to read the fork settings.")),
    );
    const ownUsage = yield* latestUsage(input.thread.id);
    const usage = ownUsage ?? (yield* latestUsage(transfer.source_thread_id));
    const holdsTurns =
      !existing.requireFreshSession &&
      (yield* currentThreadHoldsTurns(input.thread.id, input.nativeThreadKey));
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
    // The purpose and coverage header travel too: charge them before items.
    const headerTokens = estimateTokens(
      renderHandoff({
        threadId: input.thread.id,
        title: input.thread.title,
        selection: {
          items: [],
          omittedItemIds: items.map((item) => item.itemId),
          reattached: [],
          usedTokens: 0,
        },
        totalItemCount: items.length,
        midTurnCut,
      }).preamble,
    );
    const selection = selectHistory({
      items,
      budget: Math.max(0, budget - headerTokens),
      currentAttachments: input.attachments,
      midTurnCut,
    });
    const rendered = renderHandoff({
      threadId: input.thread.id,
      title: input.thread.title,
      selection,
      totalItemCount: items.length,
      midTurnCut,
    });
    const handoffId = `handoff:${yield* crypto.randomUUIDv4.pipe(
      Effect.mapError(fail(input.thread.id, "Unable to identify the context delivery.")),
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
    } as const;
  });

  const beginDelivery: ScientForkContextDeliveryShape["beginDelivery"] = Effect.fn(
    "beginScientForkContextDelivery",
  )(function* (input) {
    const createdAt = yield* now;
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
        ${createdAt},
        ${createdAt}
      )
    `.pipe(Effect.mapError(fail(input.threadId, "Unable to record the context delivery.")));
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
      readonly mid_turn_cut_json: string | null;
    }>`
      SELECT
        transfer.status AS status,
        transfer.source_thread_id AS source_thread_id,
        lineage.fork_point_turn_id AS fork_point_turn_id,
        lineage.mid_turn_cut_json AS mid_turn_cut_json,
        COALESCE(source_lineage.inherited_turn_ids_json, '[]') AS inherited_turn_ids_json
      FROM scient_context_transfers AS transfer
      JOIN scient_thread_lineage AS lineage ON lineage.thread_id = transfer.thread_id
      LEFT JOIN scient_thread_lineage AS source_lineage
        ON source_lineage.thread_id = transfer.source_thread_id
      WHERE transfer.thread_id = ${input.threadId}
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
    if (fork.inherited_turn_ids_json.includes(`"${fork.fork_point_turn_id}"`)) return null;
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
    }>`
      SELECT provider_instance_id, resume_cursor_json FROM provider_session_runtime
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
        : // Rollback may move the provider to a new native thread that keeps
          // the history (Claude and OpenCode fork their session): adopt it.
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
