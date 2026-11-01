import { assert, it } from "@effect/vitest";
import {
  ContextTransferId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ProviderThreadId,
  RunId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2AppThread,
  type OrchestrationV2Run,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ContextHandoffService from "./ContextHandoffService.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import { ContextHandoffPolicyOverride } from "./ScientContextHandoffPolicy.ts";
import {
  contextHistoryCandidate,
  type ContextHistoryCandidate,
} from "./scient-fork/ContextHistoryCandidates.ts";
import { ProjectionStoreThreadNotFoundError } from "./ProjectionStore.ts";

const layerTest = ContextHandoffService.layer.pipe(Layer.provide(IdAllocator.layer));

it.layer(layerTest)("ContextHandoffService resource contract", (it) => {
  it.effect("rejects a source-only candidate when the requested preparation requires bodies", () =>
    Effect.gen(function* () {
      const service = yield* ContextHandoffService.ContextHandoffServiceV2;
      const error = yield* service
        .prepareProviderHandoff({
          threadId: ThreadId.make("thread:legacy-context"),
          targetRunId: RunId.make("run:next"),
          transferId: null,
          fromProviderThreadIds: [],
          toProviderThreadId: ProviderThreadId.make("provider-thread:next"),
          fromProviderInstanceId: ProviderInstanceId.make("codex"),
          toProviderInstanceId: ProviderInstanceId.make("codex"),
          coveredRunOrdinals: { from: 1, to: 1 },
          strategy: "full_thread_summary",
          items: [
            contextHistoryCandidate(
              importedItem({ role: "user", id: "metadata", text: "Retained", ordinal: 0 }),
            ),
          ],
          createdAt: DateTime.makeUnsafe("2026-01-02T00:00:00Z"),
        })
        .pipe(Effect.flip);
      assert.equal(error._tag, "ContextHandoffPrepareError");
    }),
  );
  it.effect(
    "stores immutable source references instead of a transcript on the default Scient path",
    () =>
      Effect.gen(function* () {
        const service = yield* ContextHandoffService.ContextHandoffServiceV2;
        const text = "historical output ".repeat(60_000);
        const handoff = yield* service.prepareProviderHandoff({
          threadId: ThreadId.make("thread:legacy-context"),
          targetRunId: RunId.make("run:next"),
          transferId: null,
          purpose: "scient_fork",
          fromProviderThreadIds: [],
          toProviderThreadId: ProviderThreadId.make("provider-thread:next"),
          fromProviderInstanceId: ProviderInstanceId.make("codex"),
          toProviderInstanceId: ProviderInstanceId.make("codex"),
          coveredRunOrdinals: { from: 1, to: 1 },
          strategy: "full_thread_summary",
          items: Array.from({ length: 12 }, (_, ordinal) =>
            importedItem({
              role: ordinal === 0 ? "user" : "assistant",
              id: `large:${ordinal}`,
              text,
              ordinal,
            }),
          ),
          createdAt: DateTime.makeUnsafe("2026-01-02T00:00:00.000Z"),
        });
        assert.isBelow(JSON.stringify(handoff).length, 16_000);
        assert.notInclude(handoff.summaryText, text);
        assert.deepEqual(handoff.history?.messages ?? [], []);
      }),
  );
});

function importedItem(
  input:
    | {
        readonly role: "user";
        readonly id: string;
        readonly text: string;
        readonly ordinal: number;
      }
    | {
        readonly role: "assistant";
        readonly id: string;
        readonly text: string;
        readonly ordinal: number;
      },
): OrchestrationV2TurnItem {
  const now = DateTime.makeUnsafe("2026-01-01T00:00:00.000Z");
  const base = {
    id: TurnItemId.make(`turn-item:${input.id}`),
    threadId: ThreadId.make("thread:legacy-context"),
    runId: null,
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: input.ordinal,
    status: "completed" as const,
    title: null,
    startedAt: now,
    completedAt: now,
    updatedAt: now,
    messageId: MessageId.make(`message:${input.id}`),
    text: input.text,
  };
  return input.role === "user"
    ? {
        ...base,
        createdBy: "user",
        creationSource: "server",
        type: "user_message",
        inputIntent: "turn_start",
        attachments: [],
      }
    : {
        ...base,
        type: "assistant_message",
        streaming: false,
      };
}

it.layer(layerTest)("ContextHandoffService legacy import", (it) => {
  it.effect("prepares imported history for the first native v2 turn", () =>
    Effect.gen(function* () {
      const service = yield* ContextHandoffService.ContextHandoffServiceV2;
      const handoff = yield* service.prepareLegacyImport({
        threadId: ThreadId.make("thread:legacy-context"),
        targetRunId: RunId.make("run:first-v2"),
        toProviderThreadId: ProviderThreadId.make("provider-thread:first-v2"),
        toProviderInstanceId: ProviderInstanceId.make("codex"),
        items: [
          importedItem({ role: "user", id: "one", text: "What did we decide?", ordinal: 1 }),
          importedItem({
            role: "assistant",
            id: "two",
            text: "We decided to keep the migration lightweight.",
            ordinal: 2,
          }),
        ],
        createdAt: DateTime.makeUnsafe("2026-01-02T00:00:00.000Z"),
      });

      assert.equal(handoff.strategy, "manual_context");
      assert.deepStrictEqual(handoff.fromProviderThreadIds, []);
      assert.include(handoff.summaryText, "What did we decide?");
      assert.include(handoff.summaryText, "keep the migration lightweight");
    }),
  );

  it.effect("preserves role attribution when truncating imported history", () =>
    Effect.gen(function* () {
      const service = yield* ContextHandoffService.ContextHandoffServiceV2;
      const handoff = yield* service.prepareLegacyImport({
        threadId: ThreadId.make("thread:legacy-context"),
        targetRunId: RunId.make("run:first-v2"),
        toProviderThreadId: ProviderThreadId.make("provider-thread:first-v2"),
        toProviderInstanceId: ProviderInstanceId.make("codex"),
        items: [
          importedItem({
            role: "user",
            id: "long",
            text: `${"x".repeat(35_000)} retained final words`,
            ordinal: 1,
          }),
        ],
        createdAt: DateTime.makeUnsafe("2026-01-02T00:00:00.000Z"),
      });

      assert.isAtMost(handoff.summaryText.length, 32_000);
      assert.include(handoff.summaryText, "User:\n... retained final words");
      assert.notMatch(handoff.summaryText, /\n+x+ retained final words/);
    }),
  );

  it.effect("retains the newest oversized import even when it has no whitespace", () =>
    Effect.gen(function* () {
      const service = yield* ContextHandoffService.ContextHandoffServiceV2;
      const handoff = yield* service.prepareLegacyImport({
        threadId: ThreadId.make("thread:legacy-context"),
        targetRunId: RunId.make("run:first-v2"),
        toProviderThreadId: ProviderThreadId.make("provider-thread:first-v2"),
        toProviderInstanceId: ProviderInstanceId.make("codex"),
        items: [
          importedItem({
            role: "assistant",
            id: "older",
            text: "older message",
            ordinal: 1,
          }),
          importedItem({
            role: "user",
            id: "long-single-token",
            text: `${"🧪".repeat(20_000)}LATEST_SINGLE_TOKEN`,
            ordinal: 2,
          }),
        ],
        createdAt: DateTime.makeUnsafe("2026-01-02T00:00:00.000Z"),
      });

      assert.deepEqual(handoff.history?.omittedItemIds, []);
      assert.equal(handoff.budgetPolicy, "scient");
      assert.deepEqual(
        handoff.historySource?.entries?.map((entry) => entry.itemId),
        [TurnItemId.make("turn-item:older"), TurnItemId.make("turn-item:long-single-token")],
      );
      assert.isAtMost(handoff.summaryText.length, 32_000);
      assert.include(handoff.summaryText, "User:\n... ");
      assert.include(handoff.summaryText, "LATEST_SINGLE_TOKEN");
      assert.notInclude(handoff.summaryText, "\ufffd");
    }),
  );
});

it.layer(layerTest)("ContextHandoffService preparation policy", (it) => {
  it.effect("keeps generic switch preparation capped while Scient retains intact candidates", () =>
    Effect.gen(function* () {
      const service = yield* ContextHandoffService.ContextHandoffServiceV2;
      const text = `whole:${"x".repeat(300_000)}:end`;
      const input = {
        threadId: ThreadId.make("thread:legacy-context"),
        targetRunId: RunId.make("run:first-v2"),
        transferId: null,
        fromProviderThreadIds: [],
        toProviderThreadId: ProviderThreadId.make("provider-thread:first-v2"),
        fromProviderInstanceId: ProviderInstanceId.make("codex"),
        toProviderInstanceId: ProviderInstanceId.make("acp"),
        coveredRunOrdinals: { from: 1, to: 1 },
        strategy: "full_thread_summary" as const,
        items: [importedItem({ role: "assistant", id: "large", text, ordinal: 1 })],
        createdAt: DateTime.makeUnsafe("2026-01-02T00:00:00.000Z"),
      };
      const generic = yield* service.prepareProviderHandoff(input);
      assert.isUndefined(generic.budgetPolicy);
      assert.deepEqual(generic.history?.messages, []);
      assert.deepEqual(generic.history?.omittedItemIds, [TurnItemId.make("turn-item:large")]);
      for (const purpose of ["scient_fork", "scient_history", "session_recovery"] as const) {
        const retained = yield* service.prepareProviderHandoff({ ...input, purpose });
        assert.equal(retained.budgetPolicy, "scient");
        assert.deepEqual(
          retained.historySource?.entries?.map((entry) => entry.itemId),
          [TurnItemId.make("turn-item:large")],
        );
        assert.deepEqual(retained.history?.omittedItemIds, []);
      }
    }),
  );
});

// Preserve the pre-composition bounded replay assertion under its explicit fixture policy.
it.layer(
  ContextHandoffService.layer.pipe(
    Layer.provide(
      Layer.merge(IdAllocator.layer, Layer.succeed(ContextHandoffPolicyOverride, "byte")),
    ),
  ),
)("ContextHandoffService explicit byte fixture", (it) => {
  it.effect(
    "preserves conservative byte-fixture omission and bounded summary for oversized imports",
    () =>
      Effect.gen(function* () {
        const service = yield* ContextHandoffService.ContextHandoffServiceV2;
        const handoff = yield* service.prepareLegacyImport({
          threadId: ThreadId.make("thread:legacy-context"),
          targetRunId: RunId.make("run:first-v2"),
          toProviderThreadId: ProviderThreadId.make("provider-thread:first-v2"),
          toProviderInstanceId: ProviderInstanceId.make("codex"),
          items: [
            importedItem({
              role: "assistant",
              id: "older",
              text: "older message",
              ordinal: 1,
            }),
            importedItem({
              role: "user",
              id: "long-single-token",
              text: `${"🧪".repeat(20_000)}LATEST_SINGLE_TOKEN`,
              ordinal: 2,
            }),
          ],
          createdAt: DateTime.makeUnsafe("2026-01-02T00:00:00.000Z"),
        });

        assert.include(
          handoff.history?.omittedItemIds ?? [],
          TurnItemId.make("turn-item:long-single-token"),
        );
        assert.isAtMost(handoff.summaryText.length, 32_000);
        assert.include(handoff.summaryText, "User:\n... ");
        assert.include(handoff.summaryText, "LATEST_SINGLE_TOKEN");
        assert.notInclude(handoff.summaryText, "\ufffd");
      }),
  );
});

it.effect("caps the side chat context block without summarizing discarded parent history", () =>
  Effect.gen(function* () {
    const parentThreadId = ThreadId.make("thread:side-chat-parent");
    let summarizedItems = 0;
    const parentItems = Array.from({ length: 60 }, (_, index) => ({
      ...importedItem({
        role: index % 2 === 0 ? "user" : "assistant",
        id: `parent-${index}`,
        text: `item-${index} ${"x".repeat(300)}`,
        ordinal: index,
      }),
      get text() {
        summarizedItems++;
        return `item-${index} ${"x".repeat(300)}`;
      },
    }));
    const service = yield* ContextHandoffService.ContextHandoffServiceV2;
    const handoff = yield* service.prepareSideChatContext({
      parentThreadId,
      threadId: ThreadId.make("thread:side-chat"),
      targetRunId: RunId.make("run:side-chat"),
      transferId: ContextTransferId.make("transfer:side-chat"),
      toProviderThreadId: ProviderThreadId.make("provider-thread:side-chat"),
      fromProviderInstanceId: ProviderInstanceId.make("codex"),
      toProviderInstanceId: ProviderInstanceId.make("codex"),
      coveredRunOrdinals: { from: 1, to: 1 },
      parentItems,
      createdAt: DateTime.makeUnsafe(0),
    });
    const context = handoff.summaryText;
    assert.isBelow(summarizedItems, parentItems.length);

    assert.include(context, "- Earlier items truncated.");
    assert.notInclude(context, "item-0 ");
    assert.include(context, "- Assistant: item-59 ");
    assert.isAtMost(context.length, 8_000);
    assert.isTrue(
      context.endsWith(
        `Use scient_thread_inspect on thread ${parentThreadId} to see the main thread's live state.`,
      ),
    );

    const framingOnly = ContextHandoffService.makeSideChatContext({
      parentThreadId,
      digest: [],
    });
    assert.isTrue(framingOnly.startsWith("You are in a side chat beside the main thread."));
    assert.notInclude(framingOnly, "Main thread activity");
  }).pipe(Effect.provide(layerTest)),
);

it("covers the run range of a very long delta", () => {
  const runs = [
    { id: RunId.make("run:long-delta-early"), ordinal: 2 },
    { id: RunId.make("run:long-delta-late"), ordinal: 5 },
  ];
  const items = Array.from({ length: 150_000 }, (_, index) => ({
    runId: runs[index % 2]!.id,
  }));

  assert.deepEqual(
    ContextHandoffService.visibleDeltaRunOrdinals({ runs }, [...items, { runId: null }]),
    { from: 2, to: 5 },
  );
});

it.effect("inherited history stops at a missing fork ancestor", () =>
  Effect.gen(function* () {
    const now = DateTime.makeUnsafe("2026-01-01T00:00:00.000Z");
    const threadId = ThreadId.make("thread:fork-of-missing");
    const thread: OrchestrationV2AppThread = {
      createdBy: "user",
      creationSource: "web",
      id: threadId,
      projectId: ProjectId.make("project:fork-of-missing"),
      title: "Fork of a missing thread",
      providerInstanceId: ProviderInstanceId.make("codex"),
      modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      activeProviderThreadId: null,
      lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
      forkedFrom: {
        type: "run",
        threadId: ThreadId.make("thread:missing-ancestor"),
        runId: RunId.make("run:missing-ancestor"),
      },
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
      settledOverride: null,
      settledAt: null,
      lastVisitedAt: null,
      snoozedUntil: null,
      snoozedAt: null,
      deletedAt: null,
    };
    const items = yield* ContextHandoffService.readInheritedHandoffItems(
      {
        getForkHistoryItems: () => Effect.succeed([]),
        getThreadRecords: (missing) =>
          Effect.fail(new ProjectionStoreThreadNotFoundError({ threadId: missing })),
      },
      thread,
    );
    assert.deepEqual(items, []);
  }),
);

// SCIENT-FORK:START — portable side chat history comes by reference, not from `forkedFrom`.
it.effect("portable fork references keep frozen rows and drop removed conversation", () =>
  Effect.gen(function* () {
    const threadId = ThreadId.make("thread:frozen-parent");
    const run = (id: string, ordinal: number, status: OrchestrationV2Run["status"]) =>
      ({ id: RunId.make(id), ordinal, status }) as OrchestrationV2Run;
    const candidate = (
      id: string,
      runId: string | null,
      inputIntent: string,
    ): ContextHistoryCandidate => ({
      sourceOnly: true,
      id: TurnItemId.make(id),
      threadId,
      runId: runId === null ? null : RunId.make(runId),
      nodeId: null,
      type: "user_message",
      inputIntent,
      partialSnapshot: false,
    });
    const source = {
      thread: {
        id: threadId,
        historyOrigin: "scient_fork",
        forkedFrom: null,
        lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
      } as unknown as OrchestrationV2AppThread,
      runs: [
        run("run:rolled-back", 1, "rolled_back"),
        run("run:cancelled", 2, "cancelled"),
        run("run:kept", 3, "completed"),
        run("run:later", 4, "running"),
      ],
      attempts: [],
    };
    const requested: Array<ReadonlyArray<RunId | null> | undefined> = [];
    const items = yield* ContextHandoffService.readPortableForkItems(
      {
        getForkHistoryItems: () => Effect.die("A bounded read keeps bodies out of memory."),
        getThreadRecords: () => Effect.die("A Scient fork names no run-fork ancestor."),
        getContextHistoryCandidates: (_threadId, runIds) =>
          Effect.sync(() => {
            requested.push(runIds);
            return [
              candidate("item:frozen", null, "turn_start"),
              candidate("item:rolled-back", "run:rolled-back", "turn_start"),
              candidate("item:cancelled-queued", "run:cancelled", "queued_turn"),
              candidate("item:kept", "run:kept", "turn_start"),
            ];
          }),
      },
      source,
      source.runs[2]!,
      true,
    );

    assert.deepEqual(requested, [
      [RunId.make("run:rolled-back"), RunId.make("run:cancelled"), RunId.make("run:kept"), null],
    ]);
    assert.deepEqual(
      items.map((item) => item.id),
      [TurnItemId.make("item:frozen"), TurnItemId.make("item:kept")],
    );
  }),
);

it.effect("a Scient fork's frozen rows are its inherited history, once each", () =>
  Effect.gen(function* () {
    const threadId = ThreadId.make("thread:frozen-digest-parent");
    const frozen = importedItem({ role: "user", id: "frozen", text: "Frozen", ordinal: 0 });
    const imported = importedItem({ role: "user", id: "imported", text: "Imported", ordinal: 1 });
    const source = {
      thread: {
        id: threadId,
        historyOrigin: "scient_fork",
        forkedFrom: null,
        lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
      } as unknown as OrchestrationV2AppThread,
      runs: [],
      attempts: [],
    };
    const items = yield* ContextHandoffService.readForkHistoryItems(
      {
        getForkHistoryItems: () => Effect.succeed([frozen]),
        // The thread's own runless rows include the copy its history already lists.
        getThreadRecords: () => Effect.succeed({ turnItems: [frozen, imported] }) as never,
      },
      source,
      null,
    );
    assert.deepEqual(
      items.map((item) => item.id),
      [frozen.id, imported.id],
    );
  }),
);

it.effect("a side chat's context keeps its text through the handoff projection", () =>
  Effect.gen(function* () {
    const service = yield* ContextHandoffService.ContextHandoffServiceV2;
    const handoff = yield* service.prepareSideChatContext({
      threadId: ThreadId.make("thread:side-chat"),
      parentThreadId: ThreadId.make("thread:side-chat-parent"),
      targetRunId: RunId.make("run:side-chat"),
      transferId: ContextTransferId.make("transfer:side-chat"),
      toProviderThreadId: ProviderThreadId.make("provider-thread:side-chat"),
      fromProviderInstanceId: ProviderInstanceId.make("codex"),
      toProviderInstanceId: ProviderInstanceId.make("codex"),
      coveredRunOrdinals: { from: 1, to: 1 },
      parentItems: [],
      createdAt: DateTime.makeUnsafe("2026-01-02T00:00:00.000Z"),
    });
    // Handoff reads blank the summary of any handoff that has no history source.
    assert.deepEqual(handoff.historySource?.entries, []);
    assert.isTrue(ContextHandoffService.isSideChatContextHandoff(handoff));
  }).pipe(Effect.provide(layerTest)),
);
// SCIENT-FORK:END
