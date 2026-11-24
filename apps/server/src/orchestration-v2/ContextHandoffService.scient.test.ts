import { assert, it } from "@effect/vitest";
import {
  MessageId,
  RunId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2AppThread,
  type OrchestrationV2Run,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as ContextHandoffService from "./ContextHandoffService.ts";
import type { ContextHistoryCandidate } from "./scient-fork/ContextHistoryCandidates.ts";

// Bounded fork reads take body-less references, so the `/clear` boundary reads the prompts itself.
const threadId = ThreadId.make("thread:bounded-clear");
const run = (id: string, ordinal: number, freshContext?: true) =>
  ({
    id: RunId.make(id),
    ordinal,
    status: "completed",
    userMessageId: MessageId.make(`message:${id}`),
    startedAt: "2026-01-01T00:00:00.000Z",
    ...(freshContext ? { freshContext } : {}),
  }) as unknown as OrchestrationV2Run;
const candidate = (id: string, runId: string | null): ContextHistoryCandidate => ({
  sourceOnly: true,
  id: TurnItemId.make(id),
  threadId,
  runId: runId === null ? null : RunId.make(runId),
  nodeId: null,
  type: "user_message",
  inputIntent: "turn_start",
  partialSnapshot: false,
});
const prompt = (runId: string, scheduledTaskId?: string) =>
  ({
    id: TurnItemId.make(`prompt:${runId}`),
    threadId,
    runId: RunId.make(runId),
    type: "user_message",
    messageId: MessageId.make(`message:${runId}`),
    ordinal: 1,
    ...(scheduledTaskId === undefined ? {} : { scheduledTaskId }),
  }) as unknown as OrchestrationV2TurnItem;

const readBounded = (scheduledTaskId?: string) => {
  const source = {
    thread: {
      id: threadId,
      historyOrigin: "scient_fork",
      forkedFrom: null,
      lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
    } as unknown as OrchestrationV2AppThread,
    runs: [run("run:before", 1), run("run:fresh", 2, true)],
    attempts: [],
  };
  return ContextHandoffService.readPortableForkItems(
    {
      getForkHistoryItems: () => Effect.die("A bounded read keeps bodies out of memory."),
      getThreadRecords: () =>
        Effect.succeed({ turnItems: [prompt("run:fresh", scheduledTaskId)] }) as never,
      getContextHistoryCandidates: () =>
        Effect.succeed([
          candidate("item:frozen", null),
          candidate("item:before", "run:before"),
          candidate("item:fresh", "run:fresh"),
        ]),
    },
    source,
    source.runs[1]!,
    true,
  ).pipe(Effect.map((items) => items.map((item) => item.id)));
};

it.effect("a bounded portable fork starts at the source's /clear", () =>
  Effect.gen(function* () {
    assert.deepEqual(yield* readBounded(), [TurnItemId.make("item:fresh")]);
  }),
);

it.effect("a bounded portable fork keeps history past a scheduled fresh run", () =>
  Effect.gen(function* () {
    assert.deepEqual(yield* readBounded("task:scheduled"), [
      TurnItemId.make("item:frozen"),
      TurnItemId.make("item:before"),
      TurnItemId.make("item:fresh"),
    ]);
  }),
);
