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
