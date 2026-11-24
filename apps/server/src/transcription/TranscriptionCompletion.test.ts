import { ThreadId } from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import { ThreadManagementService } from "../orchestration-v2/ThreadManagementService.ts";
import { layer, completionCommand } from "./TranscriptionCompletion.ts";
import { TranscriptionJobs, type SettledTranscription } from "./TranscriptionJobs.ts";

it.effect("queues durable notices for the originating thread with stable deduplication IDs", () =>
  Effect.gen(function* () {
    const settled = yield* PubSub.unbounded<SettledTranscription>();
    const dispatched = yield* Queue.unbounded<unknown>();
    yield* Layer.build(
      layer.pipe(
        Layer.provide(
          Layer.merge(
            Layer.mock(TranscriptionJobs)({ subscribeSettled: () => PubSub.subscribe(settled) }),
            Layer.mock(ThreadManagementService)({
              dispatch: (command) =>
                Queue.offer(dispatched, command).pipe(
                  Effect.andThen(
                    Effect.die("Simulated dispatch failure after observing the command"),
                  ),
                ),
            }),
          ),
        ),
      ),
    );
    const threadId = ThreadId.make("origin-thread");
    const id = "2026-11-22-audio-abcd1234";
    for (const [stage, outcome] of [
      ["completed", "completed"],
      ["failed", "failed"],
      ["canceled", "cancelled"],
    ] as const) {
      const fact = { threadId, id, stage };
      yield* PubSub.publish(settled, fact);
      const command = yield* Queue.take(dispatched);
      expect(command).toMatchObject({
        type: "message.dispatch",
        threadId,
        dispatchMode: { type: "queue_after_active" },
        notification: { source: { kind: "background_task" }, outcome },
      });
      expect(command).toEqual(completionCommand(fact));
      expect(
        completionCommand({ ...fact, threadId: ThreadId.make("other-thread") }).commandId,
      ).not.toBe(completionCommand(fact).commandId);
    }
  }),
);
