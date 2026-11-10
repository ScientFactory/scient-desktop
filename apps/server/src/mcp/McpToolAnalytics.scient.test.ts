import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import { McpSchema, McpServer, Tool, Toolkit } from "effect/ai";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import * as AnalyticsService from "../telemetry/AnalyticsService.ts";
import { disabledAnalyticsService } from "../telemetry/ScientAnalytics.ts";
import { BrowserToolCallLedger, BrowserToolCalls } from "../telemetry/ScientMcpAnalytics.ts";
import * as McpHttpServer from "./McpHttpServer.ts";
import * as McpInvocationContext from "./McpInvocationContext.ts";
import * as McpToolAccess from "./McpToolAccess.ts";
import * as McpToolAccessTestkit from "./McpToolAccess.testkit.ts";

// Same tag as the contract's error; a declared failure with a message reaches MCP as text only.
class PreviewAutomationTimeoutError extends Schema.TaggedError<PreviewAutomationTimeoutError>()(
  "PreviewAutomationTimeoutError",
  { timeoutMs: Schema.Number },
) {
  override get message() {
    return `Preview automation timed out after ${this.timeoutMs}ms.`;
  }
}

const PreviewProbeToolkit = Toolkit.make(
  Tool.make("preview_status", { description: "Succeeds.", success: Schema.Struct({}) }),
  Tool.make("preview_wait_for", {
    description: "Times out.",
    success: Schema.Struct({}),
    failure: PreviewAutomationTimeoutError,
  }),
);

const threadId = ThreadId.make("mcp-scient-thread");
const scope: McpInvocationContext.McpInvocationScope = {
  environmentId: EnvironmentId.make("mcp-scient-environment"),
  requestNamespace: "mcp-scient-session",
  thread: {
    threadId,
    providerSessionId: "mcp-scient-session",
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
  clientInfo: { name: "mcp-scient", version: "1" },
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "mcp-scient", version: "1" },
  },
  getClient: Effect.die("unused"),
});

it.effect("names a browser tool's failure and counts every browser call toward its turn", () => {
  const recorded = Deferred.makeUnsafe<object>();
  const ledger = new BrowserToolCallLedger();
  return Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    const call = (name: string) =>
      server
        .callTool({ name, arguments: {} })
        .pipe(
          Effect.provideService(McpInvocationContext.McpInvocationContext, scope),
          Effect.provideService(McpSchema.McpServerClient, client),
        );
    expect((yield* call("preview_status")).isError).not.toBe(true);
    const failed = yield* call("preview_wait_for");
    expect(failed.isError).toBe(true);
    expect(failed.structuredContent).toBeUndefined();

    expect(ledger.take(threadId, Number.MAX_SAFE_INTEGER)).toEqual({ calls: 2, failures: 1 });
    expect(yield* Deferred.await(recorded)).toMatchObject({
      tool: "preview_wait_for",
      outcome: "error",
      errorCode: "timeout",
    });
  }).pipe(
    Effect.provide(
      McpHttpServer.toolkitRegistration(
        PreviewProbeToolkit,
        McpToolAccess.toLayer(PreviewProbeToolkit, {
          preview_status: McpToolAccess.reads(() => Effect.succeed({})),
          preview_wait_for: McpToolAccess.reads(() =>
            Effect.fail(new PreviewAutomationTimeoutError({ timeoutMs: 5_000 })),
          ),
        }),
      ).pipe(
        Layer.provideMerge(McpHttpServer.layerInProcessMcpServer),
        Layer.provide(McpToolAccessTestkit.fullAccessCapturedPolicyLayer),
        Layer.provide(Layer.succeed(BrowserToolCalls, ledger)),
        Layer.provide(
          Layer.succeed(
            AnalyticsService.AnalyticsService,
            AnalyticsService.AnalyticsService.of({
              ...disabledAnalyticsService,
              record: (event, properties) =>
                event === "mcp.tool.invoked"
                  ? Deferred.succeed(recorded, properties ?? {}).pipe(Effect.asVoid)
                  : Effect.void,
            }),
          ),
        ),
      ),
    ),
  );
});
