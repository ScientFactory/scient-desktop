import { assert, it } from "@effect/vitest";
import {
  ConnectorId,
  type ExtensionDeliveryReceipt,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import * as ExtensionDeliveryReceipts from "./ExtensionDeliveryReceipts.ts";
import { ExtensionDeliveryReceipts as ExtensionDeliveryReceiptsTag } from "./ExtensionsServices.ts";

const receiptFor = (
  threadId: string,
  providerSessionId = "session-1",
): ExtensionDeliveryReceipt => ({
  threadId: ThreadId.make(threadId),
  providerInstanceId: ProviderInstanceId.make("codex"),
  providerSessionId,
  issuedAt: "2026-10-21T00:00:00.000Z",
  delivered: [
    {
      kind: "connector",
      connectorId: ConnectorId.make("con_linear0001"),
      serverName: "linear",
      displayName: "Linear",
    },
  ],
  skipped: [],
});

it.effect("keeps the latest receipt per thread and announces only real changes", () =>
  Effect.gen(function* () {
    const receipts = yield* ExtensionDeliveryReceipts.make;
    const announced = yield* receipts.changes.pipe(
      Stream.take(2),
      Stream.runCollect,
      Effect.forkChild({ startImmediately: true }),
    );
    yield* Effect.yieldNow;

    assert.isTrue(Option.isNone(yield* receipts.get(ThreadId.make("thread-a"))));
    yield* receipts.record(receiptFor("thread-a"));
    // Re-preparing an unchanged session is not news.
    yield* receipts.record(receiptFor("thread-a"));
    yield* receipts.record(receiptFor("thread-a", "session-2"));

    assert.deepEqual(Array.from(yield* Fiber.join(announced)), [
      ThreadId.make("thread-a"),
      ThreadId.make("thread-a"),
    ]);
    assert.equal(
      Option.getOrUndefined(yield* receipts.get(ThreadId.make("thread-a")))?.providerSessionId,
      "session-2",
    );
  }),
);

it.effect("evicts the least recently recorded thread beyond the retention bound", () =>
  Effect.gen(function* () {
    const receipts = yield* ExtensionDeliveryReceipts.make;
    for (let index = 0; index < ExtensionDeliveryReceipts.MAX_RETAINED_RECEIPTS; index += 1) {
      yield* receipts.record(receiptFor(`thread-${index}`));
    }
    // Refreshing thread-0 makes thread-1 the oldest.
    yield* receipts.record(receiptFor("thread-0", "session-refreshed"));
    yield* receipts.record(receiptFor("thread-overflow"));

    assert.isTrue(Option.isSome(yield* receipts.get(ThreadId.make("thread-0"))));
    assert.isTrue(Option.isNone(yield* receipts.get(ThreadId.make("thread-1"))));
    assert.isTrue(Option.isSome(yield* receipts.get(ThreadId.make("thread-overflow"))));
  }),
);

it.effect("applies each registration report as the credential's current state", () =>
  Effect.gen(function* () {
    const receipts = yield* ExtensionDeliveryReceiptsTag;
    const threadId = ThreadId.make("thread-withheld");
    const linear = receiptFor("thread-withheld").delivered[0]!;
    const current = Effect.map(receipts.get(threadId), Option.getOrUndefined);
    const credential = { threadId, providerSessionId: "credential-1" };
    yield* receipts.record(receiptFor("thread-withheld", "credential-1"));

    // A query could not list the agent's servers and left the connector out.
    yield* receipts.reportRegistration({
      ...credential,
      withheld: [{ serverName: "linear", reason: "native-servers-unknown" }],
    });
    assert.deepEqual((yield* current)?.delivered, []);
    assert.deepEqual((yield* current)?.skipped, [
      { entry: linear, reason: "native-servers-unknown" },
    ]);

    // Reusing the same credential re-records the plan; the latest report holds.
    yield* receipts.record(receiptFor("thread-withheld", "credential-1"));
    assert.deepEqual((yield* current)?.delivered, []);

    // A later query recovered and registered it: delivered again, not appended.
    yield* receipts.reportRegistration({ ...credential, withheld: [] });
    assert.deepEqual((yield* current)?.delivered, [linear]);
    assert.deepEqual((yield* current)?.skipped, []);

    // A report for a credential that no longer owns the receipt changes nothing.
    yield* receipts.record(receiptFor("thread-withheld", "credential-2"));
    yield* receipts.reportRegistration({
      ...credential,
      withheld: [{ serverName: "linear", reason: "name-collision" }],
    });
    assert.deepEqual((yield* current)?.delivered, [linear]);
    assert.deepEqual((yield* current)?.skipped, []);
  }).pipe(Effect.provide(ExtensionDeliveryReceipts.layer)),
);
