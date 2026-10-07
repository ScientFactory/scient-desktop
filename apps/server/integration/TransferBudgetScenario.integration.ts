import {
  ORCHESTRATION_V2_WS_METHODS,
  type OrchestrationV2ShellStreamItem,
  type OrchestrationV2ThreadStreamItem,
  type ProviderDriverKind,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import type { EventSinkV2 } from "../src/orchestration-v2/EventSink.ts";
import type { MeasuredWsClient } from "./NetworkTransferMeasurement.integration.ts";
import { TRANSFER_HISTORY_TURN_COUNT } from "./fixtures/transferBudget.ts";
import { THREAD_ID, threadCreated, turnEvents } from "./TransferBudgetV2Fixture.integration.ts";

export const TRANSFER_THREAD_ID = THREAD_ID;
const TRANSFER_MEASURED_TURN_INDEX = TRANSFER_HISTORY_TURN_COUNT;

/** Persist the same V2 transcript used by the dedicated transport measurement. */
export const seedTransferBudgetHistory = Effect.fn("TransferBudget.seedHistory")(function* (
  sink: EventSinkV2["Service"],
  provider: ProviderDriverKind,
) {
  yield* sink.write({ events: [threadCreated(provider)] });
  for (let index = 0; index < TRANSFER_HISTORY_TURN_COUNT; index += 1) {
    yield* sink.write({ events: turnEvents(provider, index, false) });
  }
});

export const commitMeasuredTransferTurn = Effect.fn("TransferBudget.commitMeasuredTurn")(function* (
  sink: EventSinkV2["Service"],
  provider: ProviderDriverKind,
) {
  return yield* sink.write({
    events: turnEvents(provider, TRANSFER_MEASURED_TURN_INDEX, true),
  });
});

export function expectedMeasuredAssistantText(provider: ProviderDriverKind): string {
  return (
    `Completed ${provider} inspection ${TRANSFER_MEASURED_TURN_INDEX}. ` +
    "The projection preserves transcript text and bounds tool output. ".repeat(60)
  );
}

/** Takes from the queue until one value matches, and returns everything taken. */
export const collectQueueUntil = Effect.fn("TransferBudget.collectQueueUntil")(function* <A>(
  queue: Queue.Queue<A>,
  predicate: (value: A) => boolean,
  waitDescription: string,
) {
  return yield* Effect.gen(function* () {
    const values: A[] = [];
    while (true) {
      const value = yield* Queue.take(queue);
      values.push(value);
      if (predicate(value)) return values;
    }
  }).pipe(
    Effect.timeoutOrElse({
      duration: "10 seconds",
      orElse: () => Effect.die(new Error(`Timed out waiting for ${waitDescription}`)),
    }),
  );
});

/**
 * Resumes the thread subscription from a cursor on a measured client. The
 * consumer runs in the client's scope, so closing the client stops it. Callers
 * read items from the returned queue.
 */
export const subscribeThreadItems = Effect.fn("TransferBudget.subscribeThreadItems")(function* (
  measured: MeasuredWsClient,
  afterSequence: number,
) {
  const items = yield* Queue.unbounded<OrchestrationV2ThreadStreamItem>();
  yield* measured.client[ORCHESTRATION_V2_WS_METHODS.subscribeThread]({
    threadId: TRANSFER_THREAD_ID,
    afterSequence,
    requestCompletionMarker: true,
    acceptBoundedSnapshot: true,
  }).pipe(
    Stream.runForEach((item) => Queue.offer(items, item).pipe(Effect.asVoid)),
    Scope.provide(measured.scope),
    Effect.forkIn(measured.scope),
  );
  return items;
});

/** Shell counterpart of subscribeThreadItems. */
export const subscribeShellItems = Effect.fn("TransferBudget.subscribeShellItems")(function* (
  measured: MeasuredWsClient,
  afterSequence: number,
) {
  const items = yield* Queue.unbounded<OrchestrationV2ShellStreamItem>();
  yield* measured.client[ORCHESTRATION_V2_WS_METHODS.subscribeShell]({
    afterSequence,
    requestCompletionMarker: true,
  }).pipe(
    Stream.runForEach((item) => Queue.offer(items, item).pipe(Effect.asVoid)),
    Scope.provide(measured.scope),
    Effect.forkIn(measured.scope),
  );
  return items;
});

/** Waits for the initial catch-up and reports whether it was a replay or a snapshot reset. */
export const awaitSubscriptionSynchronized = Effect.fn(
  "TransferBudget.awaitSubscriptionSynchronized",
)(function* <Item extends OrchestrationV2ThreadStreamItem | OrchestrationV2ShellStreamItem>(
  items: Queue.Queue<Item>,
  waitDescription: string,
) {
  const initial = yield* collectQueueUntil(
    items,
    (item) => item.kind === "synchronized",
    waitDescription,
  );
  return initial.some((item) => item.kind === "snapshot")
    ? ("snapshot" as const)
    : ("replay" as const);
});

export { TRANSFER_HISTORY_TURN_COUNT };
