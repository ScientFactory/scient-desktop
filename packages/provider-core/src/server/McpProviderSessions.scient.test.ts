import { assert, it } from "@effect/vitest";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as McpProviderSessions from "./McpProviderSessions.ts";

const sessionFor = (threadId: ThreadId, providerSessionId: string) => ({
  environmentId: EnvironmentId.make("epoch-environment"),
  threadId,
  providerSessionId,
  providerInstanceId: ProviderInstanceId.make("epoch-instance"),
  endpoint: "http://127.0.0.1:12345/mcp",
  authorizationHeader: "Bearer fixture",
  capabilities: new Set<string>(),
  connectors: [],
});

// A closed thread keeps no generation, so a write that outlived it must still find no match when
// the thread opens again, even with the same provider session.
it.effect("refuses a write that outlived its closed session after the thread reopens", () =>
  Effect.gen(function* () {
    const sessions = yield* McpProviderSessions.McpProviderSessions;
    const threadId = ThreadId.make("epoch-thread");
    const record = (message: string, epoch: number) =>
      sessions.recordToolResult(
        threadId,
        "send_to_user",
        { message },
        { sentMessage: message },
        { providerSessionId: "session", epoch },
      );
    const take = (message: string) =>
      sessions.takeToolResult(threadId, "send_to_user", { message });

    yield* sessions.set(sessionFor(threadId, "session"));
    const beforeClose = yield* sessions.toolResultEpoch(threadId);
    yield* sessions.clear(threadId);
    // Closed and not yet reopened: nothing may land.
    yield* record("Late while closed", beforeClose);
    assert.isUndefined(yield* take("Late while closed"));

    yield* sessions.set(sessionFor(threadId, "session"));
    const reopened = yield* sessions.toolResultEpoch(threadId);
    assert.notStrictEqual(reopened, beforeClose);
    yield* record("Late after reopen", beforeClose);
    assert.isUndefined(yield* take("Late after reopen"));
    yield* record("Current", reopened);
    assert.deepStrictEqual(yield* take("Current"), { sentMessage: "Current" });
  }).pipe(Effect.provide(McpProviderSessions.layer)),
);

// An admitted call whose session is torn down before its handler asks for a generation.
it.effect("refuses a call's write when its session closed before the call took a generation", () =>
  Effect.gen(function* () {
    const sessions = yield* McpProviderSessions.McpProviderSessions;
    const threadId = ThreadId.make("closed-before-epoch-thread");
    const record = (message: string, epoch?: number) =>
      sessions.recordToolResult(
        threadId,
        "send_to_user",
        { message },
        { sentMessage: message },
        { providerSessionId: "session", epoch },
      );
    const take = (message: string) =>
      sessions.takeToolResult(threadId, "send_to_user", { message });

    yield* sessions.set(sessionFor(threadId, "session"));
    yield* sessions.clear(threadId);
    const afterClose = yield* sessions.toolResultEpoch(threadId, "session");
    yield* record("Late", afterClose);
    assert.isUndefined(yield* take("Late"));
    yield* record("Late without a generation");
    assert.isUndefined(yield* take("Late without a generation"));

    yield* sessions.set(sessionFor(threadId, "session"));
    yield* record("Late after reopen", afterClose);
    assert.isUndefined(yield* take("Late after reopen"));
    const current = yield* sessions.toolResultEpoch(threadId, "session");
    yield* record("Current", current);
    assert.deepStrictEqual(yield* take("Current"), { sentMessage: "Current" });
  }).pipe(Effect.provide(McpProviderSessions.layer)),
);

it.effect("issues a generation only to the thread's active provider session", () =>
  Effect.gen(function* () {
    const sessions = yield* McpProviderSessions.McpProviderSessions;
    const threadId = ThreadId.make("replaced-session-thread");
    yield* sessions.set(sessionFor(threadId, "old"));
    yield* sessions.set(sessionFor(threadId, "new"));
    const stale = yield* sessions.toolResultEpoch(threadId, "old");
    const current = yield* sessions.toolResultEpoch(threadId, "new");
    assert.notStrictEqual(stale, current);
    yield* sessions.recordToolResult(
      threadId,
      "send_to_user",
      { message: "Current" },
      { sentMessage: "Current" },
      { providerSessionId: "new", epoch: stale },
    );
    assert.isUndefined(
      yield* sessions.takeToolResult(threadId, "send_to_user", { message: "Current" }),
    );
  }).pipe(Effect.provide(McpProviderSessions.layer)),
);
