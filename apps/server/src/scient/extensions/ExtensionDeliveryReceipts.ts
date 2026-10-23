/**
 * Latest extensions delivery receipt per thread: what the thread's current
 * provider session received and what it did not, with reasons. Written by
 * `ProviderSessionManagerV2.prepareMcpSession` under its per-thread lock, so
 * the stored receipt always describes the most recently prepared credential.
 * An adapter that withholds a delivered connector at registration (a live
 * provider-native server owns its name, or the agent cannot say which servers
 * it has) amends that credential's receipt through the callback the manager
 * put on the session's MCP config; the amendment holds for every later
 * receipt of the same credential.
 * In memory only: a server restart re-prepares every session it resumes.
 */
import {
  ExtensionDeliveryReceipt,
  type ExtensionDeliverySkipReason,
  type ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import {
  ExtensionDeliveryReceipts,
  type ExtensionDeliveryReceiptsShape,
} from "./ExtensionsServices.ts";

/** Threads whose receipt is kept; the least recently recorded is evicted first. */
export const MAX_RETAINED_RECEIPTS = 1_024;

const sameReceipt = Schema.toEquivalence(ExtensionDeliveryReceipt);

interface ThreadReceipt {
  /** As recorded at credential preparation, before any adapter report. */
  readonly recorded: ExtensionDeliveryReceipt;
  /**
   * Server names the latest accepted registration report for
   * `recorded.providerSessionId` left out. Each report replaces it: a later
   * query that registers a connector returns it to delivered. Which report is
   * latest is decided by the credential's tracker (`ConnectorSessionDelivery`),
   * which lives as long as the credential, not by this retained entry.
   */
  readonly withheld: ReadonlyMap<string, ExtensionDeliverySkipReason>;
  /** `recorded` with `withheld` moved from delivered to skipped. */
  readonly effective: ExtensionDeliveryReceipt;
}

const applyWithheld = (
  receipt: ExtensionDeliveryReceipt,
  withheld: ReadonlyMap<string, ExtensionDeliverySkipReason>,
): ExtensionDeliveryReceipt =>
  withheld.size === 0
    ? receipt
    : {
        ...receipt,
        delivered: receipt.delivered.filter((entry) => !withheld.has(entry.serverName)),
        skipped: [
          ...receipt.skipped,
          ...receipt.delivered.flatMap((entry) => {
            const reason = withheld.get(entry.serverName);
            return reason === undefined ? [] : [{ entry, reason }];
          }),
        ],
      };

export const make = Effect.gen(function* () {
  const threads = yield* Ref.make<ReadonlyMap<ThreadId, ThreadReceipt>>(new Map());
  const changes = yield* PubSub.unbounded<ThreadId>();

  /** Stores `update`'s result as the thread's most recent entry and reports a visible change. */
  const store = (
    threadId: ThreadId,
    update: (current: ThreadReceipt | undefined) => ThreadReceipt | undefined,
  ) =>
    Ref.modify(threads, (current) => {
      const previous = current.get(threadId);
      const updated = update(previous);
      if (updated === undefined) return [false, current] as const;
      const next = new Map(current);
      // Re-insert so Map order tracks recency for eviction.
      next.delete(threadId);
      next.set(threadId, updated);
      for (const key of next.keys()) {
        if (next.size <= MAX_RETAINED_RECEIPTS) break;
        next.delete(key);
      }
      // Re-preparing an unchanged session is not news.
      return [
        previous === undefined || !sameReceipt(previous.effective, updated.effective),
        next,
      ] as const;
    }).pipe(
      Effect.flatMap((changed) => (changed ? PubSub.publish(changes, threadId) : Effect.void)),
    );

  const record: ExtensionDeliveryReceiptsShape["record"] = Effect.fn(
    "ExtensionDeliveryReceipts.record",
  )(function* (receipt, options) {
    yield* store(receipt.threadId, (previous) => {
      const withheld: ReadonlyMap<string, ExtensionDeliverySkipReason> =
        options?.withheld !== undefined
          ? new Map(options.withheld.map(({ serverName, reason }) => [serverName, reason] as const))
          : previous?.recorded.providerSessionId === receipt.providerSessionId
            ? previous.withheld
            : new Map();
      return { recorded: receipt, withheld, effective: applyWithheld(receipt, withheld) };
    });
  });

  const reportRegistration: ExtensionDeliveryReceiptsShape["reportRegistration"] = Effect.fn(
    "ExtensionDeliveryReceipts.reportRegistration",
  )(function* (input) {
    yield* store(input.threadId, (previous) => {
      // Another credential owns the thread's receipt; the report is stale.
      if (previous?.recorded.providerSessionId !== input.providerSessionId) return undefined;
      const withheld = new Map(
        input.withheld.map(({ serverName, reason }) => [serverName, reason] as const),
      );
      return { ...previous, withheld, effective: applyWithheld(previous.recorded, withheld) };
    });
  });

  const get: ExtensionDeliveryReceiptsShape["get"] = Effect.fn("ExtensionDeliveryReceipts.get")(
    function* (threadId) {
      return Option.fromUndefinedOr((yield* Ref.get(threads)).get(threadId)?.effective);
    },
  );

  return ExtensionDeliveryReceipts.of({
    record,
    reportRegistration,
    get,
    changes: Stream.fromPubSub(changes),
  });
});

export const layer = Layer.effect(ExtensionDeliveryReceipts, make);
