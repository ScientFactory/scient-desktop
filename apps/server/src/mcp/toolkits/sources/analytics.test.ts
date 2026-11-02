import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { McpSchema, McpServer } from "effect/ai";

import { WorkspaceBindingResolver } from "../../../scient/projectScope/WorkspaceBindingResolver.ts";
import { workspaceResolverForTest } from "../../../scient/projectScope/WorkspaceBindingTestUtils.ts";
import * as AnalyticsService from "../../../telemetry/AnalyticsService.ts";
import { disabledAnalyticsService } from "../../../telemetry/ScientAnalytics.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { ScientSourcesToolkitRegistrationLive } from "../../McpHttpServer.ts";

const scope: McpInvocationContext.McpInvocationScope = {
  environmentId: EnvironmentId.make("sources-analytics-environment"),
  requestNamespace: "sources-analytics-session",
  thread: {
    threadId: ThreadId.make("sources-analytics-thread"),
    providerSessionId: "sources-analytics-session",
    providerInstanceId: ProviderInstanceId.make("codex"),
  },
  client: undefined,
  issuedAt: 0,
  capabilities: new Set(["orchestration"]),
};
const client = McpSchema.McpServerClient.of({
  clientId: 1,
  protocolVersion: "2025-06-18",
  clientCapabilities: {},
  clientInfo: { name: "sources-analytics", version: "1" },
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "sources-analytics", version: "1" },
  },
  getClient: Effect.die("unused"),
});

it.effect("records calls of Scient's tools like T3's, without arguments", () => {
  // Recording runs detached from the tool response, so each event is awaited.
  const recorded = [
    Deferred.makeUnsafe<Readonly<Record<string, unknown>>>(),
    Deferred.makeUnsafe<Readonly<Record<string, unknown>>>(),
  ];
  let count = 0;
  return Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    // No workspace is bound to this thread, so both calls fail before touching any source.
    const calls = [
      ["scient_sources_list", {}],
      ["scient_sources_add", { query: "10.1000/private-doi" }],
    ] as const;
    for (const [index, [name, args]] of calls.entries()) {
      const result = yield* server
        .callTool({ name, arguments: args })
        .pipe(
          Effect.provideService(McpInvocationContext.McpInvocationContext, scope),
          Effect.provideService(McpSchema.McpServerClient, client),
        );
      expect(result.isError).toBe(true);
      expect(yield* Deferred.await(recorded[index]!)).toMatchObject({
        tool: name,
        callerProvider: "unknown",
        outcome: "error",
      });
    }
    expect(JSON.stringify(yield* Deferred.await(recorded[1]!))).not.toContain("private-doi");
  }).pipe(
    Effect.provide(
      ScientSourcesToolkitRegistrationLive.pipe(
        Layer.provide(Layer.succeed(WorkspaceBindingResolver, workspaceResolverForTest(new Map()))),
        Layer.provide(
          Layer.succeed(
            AnalyticsService.AnalyticsService,
            AnalyticsService.AnalyticsService.of({
              ...disabledAnalyticsService,
              record: (event, properties) =>
                event === "mcp.tool.invoked" && count < recorded.length
                  ? Deferred.succeed(recorded[count++]!, properties ?? {}).pipe(Effect.asVoid)
                  : Effect.void,
            }),
          ),
        ),
        Layer.provideMerge(McpServer.McpServer.layer),
      ),
    ),
  );
});
