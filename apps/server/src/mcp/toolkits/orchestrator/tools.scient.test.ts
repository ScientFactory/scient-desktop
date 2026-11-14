import { assert, it } from "@effect/vitest";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import { McpSchema } from "effect/ai";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { OrchestratorToolkit } from "./tools.ts";

const client = { protocolVersion: "2025-06-18", capabilities: {} };

it.effect.each([
  ["a provider with background waits", { backgroundWait: true }, true],
  ["a provider without them", {}, false],
] as const)("lists the background wait for %s: %s", ([, caller, shown]) =>
  Effect.gen(function* () {
    const enabled = Context.getOrUndefined(
      OrchestratorToolkit.tools.scient_background_wait.annotations,
      McpSchema.EnabledWhen,
    );
    if (enabled === undefined) return yield* Effect.die("The background wait has no EnabledWhen.");
    const scope: McpInvocationContext.McpThreadInvocationScope = {
      environmentId: EnvironmentId.make("environment-background-wait"),
      requestNamespace: "session",
      thread: {
        threadId: ThreadId.make("thread-background-wait"),
        providerSessionId: "session",
        providerInstanceId: ProviderInstanceId.make("codex"),
        ...caller,
      },
      client: undefined,
      capabilities: new Set(["orchestration"]),
      issuedAt: 1,
    };
    const listed = yield* Effect.sync(() => enabled(client)).pipe(
      Effect.provideService(McpInvocationContext.McpInvocationContext, scope),
    );
    assert.equal(listed, shown);
  }),
);
