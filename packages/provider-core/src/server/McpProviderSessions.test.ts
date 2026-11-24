import { assert, describe, it } from "@effect/vitest";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as McpProviderSessions from "./McpProviderSessions.ts";

describe("McpProviderSessions", () => {
  it.effect("captures capability scope and clears the credential before replacement", () =>
    Effect.gen(function* () {
      const sessions = yield* McpProviderSessions.McpProviderSessions;
      const threadId = ThreadId.make("scope-thread");
      const capabilities = new Set(["skills:read"]);
      yield* sessions.set({
        environmentId: EnvironmentId.make("scope-environment"),
        threadId,
        providerSessionId: "scope-session",
        providerInstanceId: ProviderInstanceId.make("scope-instance"),
        endpoint: "http://127.0.0.1:12345/mcp",
        authorizationHeader: "Bearer fixture",
        capabilities,
        connectors: [],
      });
      capabilities.add("preview");
      const captured = yield* sessions.read(threadId);
      assert.deepStrictEqual([...captured!.capabilities], ["skills:read"]);
      (captured!.capabilities as Set<string>).add("preview");
      assert.deepStrictEqual([...(yield* sessions.read(threadId))!.capabilities], ["skills:read"]);
      yield* sessions.clear(threadId);
      assert.isUndefined(yield* sessions.read(threadId));
      yield* sessions.set({
        ...captured!,
        providerSessionId: "replacement",
        capabilities: new Set(),
      });
      const replacement = yield* sessions.read(threadId);
      assert.strictEqual(replacement?.providerSessionId, "replacement");
      assert.deepStrictEqual([...replacement!.capabilities], []);
    }).pipe(Effect.provide(McpProviderSessions.layer)),
  );

  it.effect("captures the delivered connector list independently of the caller", () =>
    Effect.gen(function* () {
      const sessions = yield* McpProviderSessions.McpProviderSessions;
      const threadId = ThreadId.make("connector-thread");
      const connectors = [
        {
          connectorId: "con_linear0001",
          serverName: "linear",
          displayName: "Linear",
          url: "http://127.0.0.1:12345/mcp/connectors/con_linear0001",
        },
      ];
      yield* sessions.set({
        environmentId: EnvironmentId.make("connector-environment"),
        threadId,
        providerSessionId: "connector-session",
        providerInstanceId: ProviderInstanceId.make("connector-instance"),
        endpoint: "http://127.0.0.1:12345/mcp",
        authorizationHeader: "Bearer fixture",
        capabilities: new Set(),
        connectors,
      });
      connectors.push({ ...connectors[0]!, connectorId: "con_widened01", serverName: "widened" });
      connectors[0]!.url = "https://attacker.example/mcp";
      const captured = yield* sessions.read(threadId);
      assert.deepStrictEqual(captured?.connectors, [
        {
          connectorId: "con_linear0001",
          serverName: "linear",
          displayName: "Linear",
          url: "http://127.0.0.1:12345/mcp/connectors/con_linear0001",
        },
      ]);
      (captured!.connectors as Array<(typeof connectors)[number]>).length = 0;
      assert.strictEqual((yield* sessions.read(threadId))?.connectors.length, 1);
    }).pipe(Effect.provide(McpProviderSessions.layer)),
  );
});

describe("McpProviderSessions tool results", () => {
  const threadId = ThreadId.make("thread-tool-results");

  it.effect(
    "requires exact (tool, input, output) match when reported and refuses ambiguous differing outputs",
    () =>
      Effect.gen(function* () {
        const sessions = yield* McpProviderSessions.McpProviderSessions;
        yield* sessions.recordToolResult(
          threadId,
          "send_to_user",
          { message: "A" },
          { isError: true },
        );
        yield* sessions.recordToolResult(
          threadId,
          "send_to_user",
          { message: "B" },
          { sentMessage: "B" },
        );

        // A reported error for input B must not drain A's error or B's success.
        assert.strictEqual(
          yield* sessions.takeToolResult(
            threadId,
            "send_to_user",
            { message: "B" },
            { isError: true },
          ),
          undefined,
        );
        assert.deepEqual(
          yield* sessions.takeToolResult(
            threadId,
            "send_to_user",
            { message: "A" },
            { isError: true },
          ),
          { isError: true },
        );
        assert.deepEqual(
          yield* sessions.takeToolResult(threadId, "send_to_user", { message: "B" }),
          { sentMessage: "B" },
        );

        // Identical inputs with identical outputs are interchangeable.
        yield* sessions.recordToolResult(
          threadId,
          "send_to_user",
          { message: "Same" },
          { sentMessage: "Same" },
        );
        yield* sessions.recordToolResult(
          threadId,
          "send_to_user",
          { message: "Same" },
          { sentMessage: "Same" },
        );
        assert.deepEqual(
          yield* sessions.takeToolResult(threadId, "send_to_user", { message: "Same" }),
          { sentMessage: "Same" },
        );
        assert.deepEqual(
          yield* sessions.takeToolResult(threadId, "send_to_user", { message: "Same" }),
          { sentMessage: "Same" },
        );

        // Identical inputs with differing outputs stay unclaimed on input-only lookup.
        yield* sessions.recordToolResult(
          threadId,
          "delegate_task",
          { task: "Audit" },
          { taskId: "task-1" },
        );
        yield* sessions.recordToolResult(
          threadId,
          "delegate_task",
          { task: "Audit" },
          { taskId: "task-2" },
        );
        assert.strictEqual(
          yield* sessions.takeToolResult(threadId, "delegate_task", { task: "Audit" }),
          undefined,
        );
        assert.deepEqual(
          yield* sessions.takeToolResult(
            threadId,
            "delegate_task",
            { task: "Audit" },
            { taskId: "task-2" },
          ),
          { taskId: "task-2" },
        );
        assert.deepEqual(
          yield* sessions.takeToolResult(threadId, "delegate_task", { task: "Audit" }),
          { taskId: "task-1" },
        );
      }).pipe(Effect.provide(McpProviderSessions.layer)),
  );

  it.effect("drops stale-session writes and clears unconsumed results on clearToolResults", () =>
    Effect.gen(function* () {
      const sessions = yield* McpProviderSessions.McpProviderSessions;
      yield* sessions.set({
        environmentId: EnvironmentId.make("env-tool-results"),
        threadId,
        providerSessionId: "session-2",
        providerInstanceId: ProviderInstanceId.make("codex"),
        endpoint: "http://127.0.0.1/mcp",
        authorizationHeader: "Bearer token",
        // SCIENT-FORK: Scient sessions carry capabilities and connectors instead.
        capabilities: new Set(),
        connectors: [],
      });
      // A handler finishing for replaced session-1 must not populate session-2.
      yield* sessions.recordToolResult(
        threadId,
        "send_to_user",
        { message: "Old" },
        { sentMessage: "Old" },
        { providerSessionId: "session-1" },
      );
      assert.strictEqual(
        yield* sessions.takeToolResult(threadId, "send_to_user", { message: "Old" }),
        undefined,
      );

      yield* sessions.recordToolResult(
        threadId,
        "send_to_user",
        { message: "Current" },
        { sentMessage: "Current" },
        { providerSessionId: "session-2" },
      );
      const turn1Epoch = yield* sessions.toolResultEpoch(threadId);
      yield* sessions.clearToolResults(threadId);
      assert.strictEqual(
        yield* sessions.takeToolResult(threadId, "send_to_user", { message: "Current" }),
        undefined,
      );

      // A handler started in turn 1 that finishes after turn cleanup must not populate turn 2,
      // even when the same provider session is reused.
      yield* sessions.recordToolResult(
        threadId,
        "send_to_user",
        { message: "Late from turn 1" },
        { sentMessage: "Late from turn 1" },
        { providerSessionId: "session-2", epoch: turn1Epoch },
      );
      assert.strictEqual(
        yield* sessions.takeToolResult(threadId, "send_to_user", { message: "Late from turn 1" }),
        undefined,
      );
    }).pipe(Effect.provide(McpProviderSessions.layer)),
  );
});
