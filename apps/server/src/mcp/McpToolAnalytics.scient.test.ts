import {
  EnvironmentId,
  ProviderInstanceId,
  RunId,
  ThreadId,
  type OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import { McpSchema, McpServer, Tool, Toolkit } from "effect/ai";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import { FetchHttpClient } from "effect/http";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";

import * as ServerConfig from "../config.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as PreviewBrowser from "../preview/PreviewBrowser.ts";
import * as DocumentText from "../provider/DocumentText.ts";
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

const CallerFaultToolkit = Toolkit.make(
  Tool.make("probe_page", {
    description: "Refuses a non-positive page size.",
    parameters: Schema.Struct({ limit: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)) }),
    success: Schema.Struct({}),
  }),
  Tool.make("probe_cancelled", { description: "Is cancelled.", success: Schema.Struct({}) }),
  Tool.make("probe_defect", { description: "Dies.", success: Schema.Struct({}) }),
);

it.effect(
  "blames refused arguments on the caller and a cancellation on no one, not on Scient",
  () =>
    Effect.gen(function* () {
      const recorded = yield* Queue.unbounded<Readonly<Record<string, unknown>>>();
      const outcome = (name: string, args: Record<string, unknown> = {}) =>
        Effect.gen(function* () {
          const server = yield* McpServer.McpServer;
          yield* server
            .callTool({ name, arguments: args })
            .pipe(
              Effect.provideService(McpInvocationContext.McpInvocationContext, scope),
              Effect.provideService(McpSchema.McpServerClient, client),
              Effect.exit,
            );
          const { errorCode, failureOwner } = yield* Queue.take(recorded);
          return { errorCode, failureOwner };
        });
      yield* Effect.gen(function* () {
        expect(yield* outcome("probe_page", { limit: 0 })).toEqual({
          errorCode: "invalid_params",
          failureOwner: "input",
        });
        expect(yield* outcome("probe_cancelled")).toEqual({
          errorCode: "interrupted",
          failureOwner: "cancelled",
        });
        // A real defect stays Scient's: Effect returns it as a scrubbed internal-error result.
        expect((yield* outcome("probe_defect")).failureOwner).not.toBe("input");
      }).pipe(
        Effect.provide(
          McpHttpServer.toolkitRegistration(
            CallerFaultToolkit,
            McpToolAccess.toLayer(CallerFaultToolkit, {
              probe_page: McpToolAccess.reads(() => Effect.succeed({})),
              probe_cancelled: McpToolAccess.reads(() => Effect.interrupt),
              probe_defect: McpToolAccess.reads(() => Effect.die("probe defect")),
            }),
          ).pipe(
            Layer.provideMerge(McpHttpServer.layerInProcessMcpServer),
            Layer.provide(McpToolAccessTestkit.fullAccessCapturedPolicyLayer),
            Layer.provide(Layer.succeed(BrowserToolCalls, new BrowserToolCallLedger())),
            Layer.provide(
              Layer.succeed(
                AnalyticsService.AnalyticsService,
                AnalyticsService.AnalyticsService.of({
                  ...disabledAnalyticsService,
                  record: (event, properties) =>
                    event === "mcp.tool.invoked"
                      ? Queue.offer(recorded, properties ?? {}).pipe(Effect.asVoid)
                      : Effect.void,
                }),
              ),
            ),
          ),
        ),
      );
    }),
);

const fullAccessThreadId = ThreadId.make("mcp-scient-full-access-thread");

it.effect("an HTML refusal reports its own code and reason, to the agent and to analytics", () =>
  Effect.gen(function* () {
    const recorded = yield* Queue.unbounded<Readonly<Record<string, unknown>>>();
    const fullAccess = { ...scope, thread: { ...scope.thread!, threadId: fullAccessThreadId } };
    const missing = "/scient-missing-dir/figure.html";
    const outcome = (
      name: string,
      args: Record<string, unknown>,
      caller: McpInvocationContext.McpInvocationScope = scope,
    ) =>
      Effect.gen(function* () {
        const server = yield* McpServer.McpServer;
        const result = yield* server
          .callTool({
            name,
            arguments: name === "html_render" ? { ...args, title: "Figure", height: 240 } : args,
          })
          .pipe(
            Effect.provideService(McpInvocationContext.McpInvocationContext, caller),
            Effect.provideService(McpSchema.McpServerClient, client),
          );
        const { errorCode, failureClass, failureOwner } = yield* Queue.take(recorded);
        const structured = result.structuredContent as
          | { readonly code?: unknown; readonly error?: { readonly code?: unknown } }
          | undefined;
        return {
          agentCode: structured?.error?.code ?? structured?.code,
          errorCode,
          failureClass,
          failureOwner,
        };
      });
    yield* Effect.gen(function* () {
      expect(yield* outcome("html_preview", { html: "<p>x</p>", path: missing })).toEqual({
        agentCode: "invalid_request",
        errorCode: "invalid_request",
        failureClass: "html_source_invalid",
        failureOwner: "input",
      });
      expect(yield* outcome("html_preview", { path: missing })).toEqual({
        agentCode: "capability_denied",
        errorCode: "capability_denied",
        failureClass: "html_path_denied",
        failureOwner: "environment",
      });
      expect(yield* outcome("html_preview", { path: missing }, fullAccess)).toEqual({
        agentCode: "invalid_request",
        errorCode: "invalid_request",
        failureClass: "html_render_file",
        failureOwner: "input",
      });
      // html_render returns its declared failure, code included, as the tool's result.
      expect(yield* outcome("html_render", { path: missing }, fullAccess)).toMatchObject({
        errorCode: "invalid_request",
        failureClass: "html_render_file",
        failureOwner: "input",
      });
    }).pipe(
      Effect.provide(
        McpHttpServer.layerHtmlToolkit.pipe(
          Layer.provide(McpToolAccessTestkit.fullAccessCapturedPolicyLayer),
          Layer.provideMerge(McpHttpServer.layerInProcessMcpServer),
          Layer.provide(McpProviderSessions.layer),
          Layer.provide(PreviewBrowser.layer),
          Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "scient-mcp-html-" })),
          Layer.provide(
            DocumentText.layer.pipe(
              Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
            ),
          ),
          Layer.provide(FetchHttpClient.layer),
          Layer.provide(
            Layer.mock(ThreadManagement.ThreadManagementService)({
              getThreadShell: (id) =>
                Effect.succeed({
                  id,
                  deletedAt: null,
                  archivedAt: null,
                  activeRunId: RunId.make("mcp-scient-run"),
                  providerInstanceId: ProviderInstanceId.make("codex"),
                  runtimeMode: id === fullAccessThreadId ? "full-access" : "approval-required",
                  interactionMode: "default",
                } as OrchestrationV2ThreadShell),
            }),
          ),
          Layer.provide(Layer.succeed(BrowserToolCalls, new BrowserToolCallLedger())),
          Layer.provide(
            Layer.succeed(
              AnalyticsService.AnalyticsService,
              AnalyticsService.AnalyticsService.of({
                ...disabledAnalyticsService,
                record: (event, properties) =>
                  event === "mcp.tool.invoked"
                    ? Queue.offer(recorded, properties ?? {}).pipe(Effect.asVoid)
                    : Effect.void,
              }),
            ),
          ),
        ),
      ),
    );
  }),
);
