import { assert, describe, it } from "@effect/vitest";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { RunAttemptId } from "@t3tools/contracts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { makeClaudeTestTurnInput } from "./ClaudeAdapterV2.fixture.ts";
import {
  claudeSdkFrame,
  makeWakeHarness,
  WAKE_NATIVE_SESSION,
  WAKE_TASK_ID,
  wakeNotification,
} from "./ClaudeAdapterV2.wake.testkit.ts";

const roster = (tasks: ReadonlyArray<readonly [string, string]>, uuid: string) =>
  claudeSdkFrame({
    type: "system",
    subtype: "background_tasks_changed",
    tasks: tasks.map(([taskId, description]) => ({
      task_id: taskId,
      task_type: "local_bash",
      description,
    })),
    uuid,
    session_id: WAKE_NATIVE_SESSION,
  });

describe("ClaudeAdapterV2 background-wait recovery", () => {
  it.effect(
    "names the running unawaited tasks on a miss and reports a finished task as settled",
    () =>
      Effect.gen(function* () {
        const harness = yield* makeWakeHarness;
        const awaitBackgroundTasks = harness.runtime.awaitBackgroundTasks!;
        yield* harness.runtime.startTurn(
          makeClaudeTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now: yield* DateTime.now,
            attemptId: RunAttemptId.make("attempt-claude-background-wait-recovery"),
            text: "Run the tests in the background and the dev server.",
            attachments: [],
          }),
        );
        yield* harness.offerAndWait(
          roster(
            [
              [WAKE_TASK_ID, "npm test"],
              ["dev-server", "npm run dev"],
            ],
            "00000000-0000-4000-8000-000000000901",
          ),
        );
        const wait = (taskIds: ReadonlyArray<string>) =>
          awaitBackgroundTasks({ providerThread: harness.providerThread, taskIds, awaited: true });

        // The id an agent invents before the start result returns.
        assert.deepStrictEqual(yield* wait(["bash_1"]), {
          matched: [],
          running: [
            { taskId: WAKE_TASK_ID, description: "npm test" },
            { taskId: "dev-server", description: "npm run dev" },
          ],
        });
        assert.deepStrictEqual(yield* wait([WAKE_TASK_ID]), { matched: [WAKE_TASK_ID] });
        // An awaited task is no longer offered as the one to wait on.
        assert.deepStrictEqual(yield* wait(["bash_1"]), {
          matched: [],
          running: [{ taskId: "dev-server", description: "npm run dev" }],
        });

        yield* harness.offerAndWait(
          claudeSdkFrame({ ...wakeNotification, uuid: "00000000-0000-4000-8000-000000000902" }),
        );
        // Finished before the agent registered it: nothing to wait on, read the output.
        assert.deepStrictEqual(yield* wait([WAKE_TASK_ID]), {
          matched: [],
          settled: [WAKE_TASK_ID],
        });
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            IdAllocator.layer,
            NodeServices.layer,
            NodeCrypto.layer,
            McpProviderSessions.layer,
          ),
        ),
      ),
  );
});
