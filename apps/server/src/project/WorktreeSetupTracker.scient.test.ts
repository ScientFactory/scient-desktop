import { describe, expect, it } from "@effect/vitest";
import { ThreadId, WorktreeSetupSnapshot } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as WorktreeSetupTracker from "./WorktreeSetupTracker.ts";

const isWorktreeSetupSnapshot = Schema.is(WorktreeSetupSnapshot);
const threadId = ThreadId.make("thread-1");

describe("WorktreeSetupTracker", () => {
  it.effect("clamps free text to the contract limits before publishing", () =>
    Effect.gen(function* () {
      const tracker = yield* WorktreeSetupTracker.make;
      yield* tracker.begin({
        threadId,
        branch: null,
        baseRef: null,
        stages: ["checkout", "setup-script"],
        fiber: null,
      });
      const long = "x".repeat(2_000);

      yield* tracker.stageStatus(threadId, "checkout", "done", long);
      yield* tracker.stage(threadId, "setup-script", { detail: long });
      yield* tracker.appendTail(threadId, "setup-script", long);
      yield* tracker.finish(threadId, "failed", long);

      const snapshot = yield* tracker.get(threadId);
      expect(snapshot?.stages[0]?.detail?.length).toBe(200);
      expect(snapshot?.stages[1]?.detail?.length).toBe(200);
      expect(snapshot?.stages[1]?.tail[0]?.length).toBe(400);
      expect(snapshot?.error?.length).toBe(1000);
      expect(isWorktreeSetupSnapshot(snapshot)).toBe(true);
    }),
  );
});
