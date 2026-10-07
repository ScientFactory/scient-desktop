import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { ThreadForkCommand } from "./scientConversationFork.ts";

const decodeFork = Schema.decodeUnknownEffect(ThreadForkCommand);

it.effect("accepts exactly one assistant or user fork source", () =>
  Effect.gen(function* () {
    const assistant = yield* decodeFork({
      type: "thread.fork",
      commandId: "cmd-fork-assistant",
      originThreadId: "origin-thread",
      newThreadId: "assistant-fork",
      sourceAssistantMessageId: "assistant-3",
      workspaceMode: "local",
    });
    const user = yield* decodeFork({
      type: "thread.fork",
      commandId: "cmd-fork-user",
      originThreadId: "origin-thread",
      newThreadId: "user-fork",
      sourceUserMessageId: "user-3",
      workspaceMode: "local",
    });

    assert.strictEqual(assistant.type, "thread.fork");
    assert.strictEqual(user.type, "thread.fork");

    const neither = yield* Effect.exit(
      decodeFork({
        type: "thread.fork",
        commandId: "cmd-fork-neither",
        originThreadId: "origin-thread",
        newThreadId: "invalid-fork-neither",
        workspaceMode: "local",
      }),
    );
    const both = yield* Effect.exit(
      decodeFork({
        type: "thread.fork",
        commandId: "cmd-fork-both",
        originThreadId: "origin-thread",
        newThreadId: "invalid-fork-both",
        sourceAssistantMessageId: "assistant-3",
        sourceUserMessageId: "user-3",
        workspaceMode: "local",
      }),
    );

    assert.strictEqual(neither._tag, "Failure");
    assert.strictEqual(both._tag, "Failure");
  }),
);

it.effect("decodes an optional trimmed title override for a fork", () =>
  Effect.gen(function* () {
    const automatic = yield* decodeFork({
      type: "thread.fork",
      commandId: "cmd-fork-automatic-title",
      originThreadId: "origin-thread",
      newThreadId: "automatic-title-fork",
      sourceAssistantMessageId: "assistant-3",
      workspaceMode: "local",
    });
    const explicit = yield* decodeFork({
      type: "thread.fork",
      commandId: "cmd-fork-explicit-title",
      originThreadId: "origin-thread",
      newThreadId: "explicit-title-fork",
      sourceUserMessageId: "user-3",
      workspaceMode: "new-worktree",
      titleOverride: "  Deliberate fork title  ",
    });

    assert.strictEqual(automatic.type, "thread.fork");
    assert.strictEqual(explicit.type, "thread.fork");
    if (automatic.type !== "thread.fork" || explicit.type !== "thread.fork") return;
    assert.strictEqual(automatic.titleOverride, undefined);
    assert.strictEqual(explicit.titleOverride, "Deliberate fork title");
  }),
);

it.effect("rejects a blank fork title override", () =>
  Effect.gen(function* () {
    const result = yield* Effect.exit(
      decodeFork({
        type: "thread.fork",
        commandId: "cmd-fork-blank-title",
        originThreadId: "origin-thread",
        newThreadId: "blank-title-fork",
        sourceAssistantMessageId: "assistant-3",
        workspaceMode: "local",
        titleOverride: "   ",
      }),
    );
    assert.strictEqual(result._tag, "Failure");
  }),
);
