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
