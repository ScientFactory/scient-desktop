import { assert, it } from "@effect/vitest";
import { EnvironmentId, ProviderInstanceId, ProviderSessionId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as McpProviderSession from "@t3tools/provider-core/server/mcpSession";
import { mcpRegistrationForOpenCode2Turn } from "./mcpRegistration.ts";

const threadId = ThreadId.make("thread:opencode2-mcp-registration");

it.effect("does not read or register a valid thread credential when the session disables MCP", () =>
  Effect.gen(function* () {
    McpProviderSession.setMcpProviderSession({
      environmentId: EnvironmentId.make("environment:opencode2-mcp-registration"),
      threadId,
      providerSessionId: ProviderSessionId.make("session:opencode2-mcp-registration"),
      providerInstanceId: ProviderInstanceId.make("opencode"),
      endpoint: "http://127.0.0.1:3773/mcp",
      authorizationHeader: "Bearer valid-thread-credential",
      capabilities: new Set(["skills:read"]),
    });
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => McpProviderSession.clearMcpProviderSession(threadId)),
    );

    assert.isUndefined(
      mcpRegistrationForOpenCode2Turn({
        configureMcp: false,
        threadId,
        external: false,
        name: "scient-thread",
        directory: "/workspace",
      }),
    );
  }),
);

it.effect(
  "uses the credential for an enabled local session and never injects it into external servers",
  () =>
    Effect.gen(function* () {
      McpProviderSession.setMcpProviderSession({
        environmentId: EnvironmentId.make("environment:opencode2-mcp-registration"),
        threadId,
        providerSessionId: ProviderSessionId.make("session:opencode2-mcp-registration"),
        providerInstanceId: ProviderInstanceId.make("opencode"),
        endpoint: "http://127.0.0.1:3773/mcp",
        authorizationHeader: "Bearer valid-thread-credential",
        capabilities: new Set(["skills:read"]),
      });
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => McpProviderSession.clearMcpProviderSession(threadId)),
      );

      const registration = mcpRegistrationForOpenCode2Turn({
        configureMcp: true,
        threadId,
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
          threadId,
          external: true,
          name: "scient-thread",
          directory: "/workspace",
        }),
      );
    }),
);
