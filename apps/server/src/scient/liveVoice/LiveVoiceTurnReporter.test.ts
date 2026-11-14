import { describe, expect, it } from "@effect/vitest";
import type { OrchestrationV2DomainEvent } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { makeLiveVoiceTurnReporter } from "./LiveVoiceTurnReporter.ts";

const message = (id: string, role: "user" | "assistant", text: string, runId: string | null) =>
  ({
    type: "message.updated",
    payload: { id, role, text, runId },
  }) as unknown as OrchestrationV2DomainEvent;

const run = (id: string, status: string) =>
  ({ type: "run.updated", payload: { id, status } }) as unknown as OrchestrationV2DomainEvent;

const follow = (events: ReadonlyArray<OrchestrationV2DomainEvent>, request: string) =>
  Effect.gen(function* () {
    const reports: Array<[string, boolean]> = [];
    const reporter = makeLiveVoiceTurnReporter((text, final) =>
      Effect.sync(() => void reports.push([text, final])),
    );
    reporter.expect(request);
    for (const event of events) yield* reporter.observe(event);
    return reports;
  });

describe("LiveVoiceTurnReporter", () => {
  it.effect(
    "reports the request's turn: earlier messages as progress, the last as its answer",
    () =>
      Effect.gen(function* () {
        const reports = yield* follow(
          [
            message("u1", "user", "list the files", "r1"),
            message("a1", "assistant", "Looking", "r1"),
            message("a1", "assistant", "Looking at the folder.", "r1"),
            message("a2", "assistant", "It holds a.txt.", "r1"),
            run("r1", "completed"),
          ],
          "list the files",
        );
        expect(reports).toEqual([
          ["Looking at the folder.", false],
          ["It holds a.txt.", true],
        ]);
      }),
  );

  it.effect("speaks nothing of a turn that was already running when the request was queued", () =>
    Effect.gen(function* () {
      const reports = yield* follow(
        [
          message("u0", "user", "an earlier request", "r0"),
          message("a0", "assistant", "earlier answer", "r0"),
          run("r0", "completed"),
          // Queued: no run until it starts.
          message("u1", "user", "list the files", null),
          message("u1", "user", "list the files", "r1"),
          message("a1", "assistant", "a.txt", "r1"),
          run("r1", "completed"),
        ],
        "list the files",
      );
      expect(reports).toEqual([["a.txt", true]]);
    }),
  );

  it.effect("says the turn stopped when it ends without an answer", () =>
    Effect.gen(function* () {
      const reports = yield* follow(
        [message("u1", "user", "list the files", "r1"), run("r1", "failed")],
        "list the files",
      );
      expect(reports).toEqual([["The task failed before it finished.", true]]);
    }),
  );
});
