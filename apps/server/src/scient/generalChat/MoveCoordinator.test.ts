import { CommandId, ProjectId, ThreadId, type OrchestrationCommand } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import { assertTrue } from "@effect/vitest/utils";
import * as Effect from "effect/Effect";

import { ensureScientGeneralChatMoveHasNoRunningTerminals } from "./MoveCoordinator.ts";

const command = {
  type: "thread.meta.update",
  commandId: CommandId.make("command-move"),
  threadId: ThreadId.make("thread-general"),
  moveToProjectId: ProjectId.make("project-target"),
} satisfies OrchestrationCommand;

it.effect("rejects moving a General Chat while a terminal PTY remains active", () =>
  Effect.gen(function* () {
    const error = yield* Effect.flip(
      ensureScientGeneralChatMoveHasNoRunningTerminals({
        command,
        hasRunningSessionsForThread: () => Effect.succeed(true),
      }),
    );
    assertTrue(error._tag === "OrchestrationDispatchCommandError");
    assert.include(error.message, "SCIENT_GENERAL_CHAT_MOVE_TERMINALS_OPEN");
  }),
);

it.effect("permits moving after every terminal PTY has stopped", () =>
  Effect.gen(function* () {
    const result = yield* ensureScientGeneralChatMoveHasNoRunningTerminals({
      command,
      hasRunningSessionsForThread: () => Effect.succeed(false),
    });
    assert.isUndefined(result);
  }),
);
