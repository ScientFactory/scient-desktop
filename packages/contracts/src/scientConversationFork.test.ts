import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { OrchestrationV2Command } from "./orchestrationV2.ts";

const decodeCommand = Schema.decodeUnknownEffect(OrchestrationV2Command);
const fork = {
  type: "thread.fork",
  commandId: "cmd-fork",
  sourceThreadId: "origin-thread",
  targetThreadId: "fork-thread",
  sourcePoint: { type: "latest_stable" },
  createdBy: "user",
  creationSource: "web",
};

it.effect("T3's fork carries Scient's boundary and workspace choice", () =>
  Effect.gen(function* () {
    const user = yield* decodeCommand({
      ...fork,
      scient: {
        boundary: { kind: "user-message", messageId: "user-3" },
        workspaceMode: "new-worktree",
      },
    });
    const plain = yield* decodeCommand(fork);

    assert.strictEqual(user.type, "thread.fork");
    assert.strictEqual(plain.type, "thread.fork");
    if (user.type !== "thread.fork" || plain.type !== "thread.fork") return;
    assert.strictEqual(user.scient?.boundary.kind, "user-message");
    assert.strictEqual(user.scient?.workspaceMode, "new-worktree");
    assert.strictEqual(plain.scient, undefined);
  }),
);

it.effect("refuses a fork boundary without its identity", () =>
  Effect.gen(function* () {
    const result = yield* Effect.exit(
      decodeCommand({
        ...fork,
        scient: { boundary: { kind: "running-turn" }, workspaceMode: "local" },
      }),
    );
    assert.strictEqual(result._tag, "Failure");
  }),
);
