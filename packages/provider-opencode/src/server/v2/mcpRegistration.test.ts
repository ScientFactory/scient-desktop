import { assert, it } from "@effect/vitest";
import { EnvironmentId, ProviderInstanceId, ProviderSessionId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import { mcpRegistrationForOpenCode2Turn } from "./mcpRegistration.ts";

const threadId = ThreadId.make("thread:opencode2-mcp-registration");

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
    });
    yield* Effect.addFinalizer(() => mcpSessions.clear(threadId));

    assert.isUndefined(
      mcpRegistrationForOpenCode2Turn({
        configureMcp: false,
        session: yield* mcpSessions.read(threadId),
        external: false,
        name: "scient-thread",
        directory: "/workspace",
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
      });
      yield* Effect.addFinalizer(() => mcpSessions.clear(threadId));

      const registration = mcpRegistrationForOpenCode2Turn({
        configureMcp: true,
        session: yield* mcpSessions.read(threadId),
        external: false,
        name: "scient-thread",
        directory: "/workspace",
      });
      assert.deepStrictEqual(registration, {
        name: "scient-thread",
        directory: "/workspace",
        credential: "Bearer valid-thread-credential",
        endpoint: "http://127.0.0.1:3773/mcp",
        capabilities: new Set(["skills:read"]),
      });
      assert.isUndefined(
        mcpRegistrationForOpenCode2Turn({
          configureMcp: true,
          session: yield* mcpSessions.read(threadId),
          external: true,
          name: "scient-thread",
          directory: "/workspace",
        }),
      );
    }).pipe(Effect.provide(McpProviderSessions.layer)),
);
