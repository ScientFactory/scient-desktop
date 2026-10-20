import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, it } from "@effect/vitest";
import { EnvironmentId, ProviderInstanceId, ProviderSessionId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import {
  mcpRegistrationForOpenCode2Turn,
  openCode2ConnectorKey,
  openCode2ConnectorServerName,
  staleOpenCode2McpEntries,
} from "./mcpRegistration.ts";

const threadId = ThreadId.make("thread:opencode2-mcp-registration");
const connectorKey = "0123456789abcdef";

it.effect("does not register a valid thread credential when the session disables MCP", () =>
  Effect.gen(function* () {
    const mcpSessions = yield* McpProviderSessions.McpProviderSessions;
    yield* mcpSessions.set({
      environmentId: EnvironmentId.make("environment:opencode2-mcp-registration"),
      threadId,
      providerSessionId: ProviderSessionId.make("session:opencode2-mcp-registration"),
      providerInstanceId: ProviderInstanceId.make("opencode"),
      endpoint: "http://127.0.0.1:3773/mcp",
      authorizationHeader: "Bearer valid-thread-credential",
      capabilities: new Set(["skills:read"]),
      connectors: [],
    });
    yield* Effect.addFinalizer(() => mcpSessions.clear(threadId));

    assert.isUndefined(
      mcpRegistrationForOpenCode2Turn({
        configureMcp: false,
        session: yield* mcpSessions.read(threadId),
        external: false,
        name: "scient-thread",
        directory: "/workspace",
        connectorKey,
      }),
    );
  }).pipe(Effect.provide(McpProviderSessions.layer)),
);

it.effect(
  "uses the credential for an enabled local session and never injects it into external servers",
  () =>
    Effect.gen(function* () {
      const mcpSessions = yield* McpProviderSessions.McpProviderSessions;
      yield* mcpSessions.set({
        environmentId: EnvironmentId.make("environment:opencode2-mcp-registration"),
        threadId,
        providerSessionId: ProviderSessionId.make("session:opencode2-mcp-registration"),
        providerInstanceId: ProviderInstanceId.make("opencode"),
        endpoint: "http://127.0.0.1:3773/mcp",
        authorizationHeader: "Bearer valid-thread-credential",
        capabilities: new Set(["skills:read"]),
        connectors: [],
      });
      yield* Effect.addFinalizer(() => mcpSessions.clear(threadId));

      const registration = mcpRegistrationForOpenCode2Turn({
        configureMcp: true,
        session: yield* mcpSessions.read(threadId),
        external: false,
        name: "scient-thread",
        directory: "/workspace",
        connectorKey,
      });
      assert.deepStrictEqual(registration, {
        name: "scient-thread",
        directory: "/workspace",
        credential: "Bearer valid-thread-credential",
        endpoint: "http://127.0.0.1:3773/mcp",
        capabilities: new Set(["skills:read"]),
        connectors: [],
      });
      assert.isUndefined(
        mcpRegistrationForOpenCode2Turn({
          configureMcp: true,
          session: yield* mcpSessions.read(threadId),
          external: true,
          name: "scient-thread",
          directory: "/workspace",
          connectorKey,
        }),
      );
    }).pipe(Effect.provide(McpProviderSessions.layer)),
);

it.effect("registers every connector under the thread's key with the thread's credential", () =>
  Effect.gen(function* () {
    const mcpSessions = yield* McpProviderSessions.McpProviderSessions;
    yield* mcpSessions.set({
      environmentId: EnvironmentId.make("environment:opencode2-mcp-registration"),
      threadId,
      providerSessionId: ProviderSessionId.make("session:opencode2-mcp-registration"),
      providerInstanceId: ProviderInstanceId.make("opencode"),
      endpoint: "http://127.0.0.1:3773/mcp",
      authorizationHeader: "Bearer valid-thread-credential",
      capabilities: new Set(),
      connectors: [
        {
          connectorId: "connector-github",
          serverName: "github",
          displayName: "GitHub",
          url: "http://127.0.0.1:3773/mcp/connectors/connector-github",
        },
        {
          connectorId: "connector-linear",
          serverName: "linear",
          displayName: "Linear",
          url: "http://127.0.0.1:3773/mcp/connectors/connector-linear",
        },
      ],
    });
    yield* Effect.addFinalizer(() => mcpSessions.clear(threadId));

    const registration = mcpRegistrationForOpenCode2Turn({
      configureMcp: true,
      session: yield* mcpSessions.read(threadId),
      external: false,
      name: "scient-thread",
      directory: "/workspace",
      connectorKey,
    });
    assert.deepStrictEqual(registration?.connectors, [
      {
        name: "t3-code-0123456789abcdef-github",
        directory: "/workspace",
        credential: "Bearer valid-thread-credential",
        url: "http://127.0.0.1:3773/mcp/connectors/connector-github",
        displayName: "GitHub",
      },
      {
        name: "t3-code-0123456789abcdef-linear",
        directory: "/workspace",
        credential: "Bearer valid-thread-credential",
        url: "http://127.0.0.1:3773/mcp/connectors/connector-linear",
        displayName: "Linear",
      },
    ]);
  }).pipe(Effect.provide(McpProviderSessions.layer)),
);

it.effect("keys each thread's connectors apart and keeps every name within OpenCode's limit", () =>
  Effect.gen(function* () {
    const key = yield* openCode2ConnectorKey(threadId);
    assert.match(key, /^[0-9a-f]{16}$/);
    assert.deepEqual(yield* openCode2ConnectorKey(threadId), key);
    assert.notEqual(yield* openCode2ConnectorKey(`${threadId}:other`), key);
    const longest = openCode2ConnectorServerName(key, "a".repeat(48));
    assert.equal(longest.length, 64);
    assert.equal(longest, `t3-code-${key.slice(0, 7)}-${"a".repeat(48)}`);
  }).pipe(Effect.provide(NodeCrypto.layer)),
);

it("forgets connectors that are dropped and every server once the credential rotates", () => {
  const scient = { name: "t3-code-thread", directory: "/workspace", credential: "Bearer old" };
  const connector = (name: string, credential = "Bearer old") => ({
    name,
    directory: "/workspace",
    credential,
    url: `http://127.0.0.1:3773/mcp/connectors/${name}`,
    displayName: name,
  });
  const github = connector("t3-code-key-github");
  const linear = connector("t3-code-key-linear");
  const registered = [scient, github, linear];
  const wanted = {
    ...scient,
    endpoint: "http://127.0.0.1:3773/mcp",
    capabilities: new Set<string>(),
    connectors: [github],
  };

  assert.deepEqual(staleOpenCode2McpEntries(registered, wanted), [linear]);
  assert.deepEqual(staleOpenCode2McpEntries([scient], { ...wanted, connectors: [] }), []);
  assert.deepEqual(
    staleOpenCode2McpEntries(registered, {
      ...wanted,
      credential: "Bearer new",
      connectors: [connector("t3-code-key-github", "Bearer new")],
    }),
    registered,
  );
  assert.deepEqual(staleOpenCode2McpEntries(registered, undefined), registered);
});
