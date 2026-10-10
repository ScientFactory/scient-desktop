import * as PreviewBrowser from "../../../preview/PreviewBrowser.ts";
import * as Orchestrator from "../../../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../../../orchestration-v2/ProjectionStore.ts";
import * as DeviceService from "../../../device/DeviceService.ts";
import * as ServerConfig from "../../../config.ts";
import { expect, it } from "@effect/vitest";
import { NodeHttpServer } from "@effect/platform-node";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { ProviderSessionManagerV2 } from "../../../orchestration-v2/ProviderSessionManager.ts";
import * as Schema from "effect/Schema";
import { HttpBody, HttpClient, HttpRouter } from "effect/http";

import * as WorkspaceBindingResolver from "../../../scient/projectScope/WorkspaceBindingResolver.ts";
import { WorkspaceBindingResolutionError } from "../../../scient/projectScope/WorkspaceBinding.ts";
import * as ServerEnvironment from "../../../environment/ServerEnvironment.ts";
import * as GitWorkflowService from "../../../git/GitWorkflowService.ts";
import * as ProviderAdapterRegistry from "../../../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../../../project/ProjectService.ts";
import * as ProjectSetupScriptRunner from "../../../project/ProjectSetupScriptRunner.ts";
import * as ProviderRegistry from "../../../provider/ProviderRegistry.ts";
import * as ScheduledTaskService from "../../../scheduledTasks/ScheduledTaskService.ts";
import * as SecretRequests from "../../../secrets/SecretRequests.ts";
import * as ServerSettings from "../../../serverSettings.ts";
import * as VcsStatusBroadcaster from "../../../vcs/VcsStatusBroadcaster.ts";
import * as McpHttpServer from "../../McpHttpServer.ts";
import * as McpSessionRegistry from "../../McpSessionRegistry.ts";
import * as PreviewAutomationBroker from "../../PreviewAutomationBroker.ts";
import { DeviceToolkit } from "../device/tools.ts";
import { scientOperationCatalog } from "../../ScientOperationCatalog.ts";

const StubServicesLive = Layer.mergeAll(
  Layer.mock(PreviewBrowser.PreviewBrowser)({}),
  Layer.mock(ProviderSessionManagerV2)({
    resolveMcpInvocationPolicy: () => Effect.die("Tool listing cannot grant mutation authority."),
  }),
  Layer.mock(WorkspaceBindingResolver.WorkspaceBindingResolver)({
    // This fixture has no verified Scient project workspace. Host tools keep
    // their own invocation checks rather than obtaining a workspace grant.
    resolveThread: () =>
      Effect.fail(
        new WorkspaceBindingResolutionError({
          operation: "worktree-registration-fixture",
          kind: "project-required",
        }),
      ),
  }),
  Layer.mock(Orchestrator.OrchestratorV2)({}),
  Layer.mock(ProjectionStore.ProjectionStoreV2)({}),
  Layer.mock(DeviceService.DeviceService)({}),
  Layer.mock(ThreadManagementService.ThreadManagementService)({}),
  Layer.mock(ProviderRegistry.ProviderRegistry)({}),
  Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({}),
  Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
  Layer.mock(SecretRequests.SecretRequests)({}),
  Layer.mock(ProjectService.ProjectService)({}),
  ServerSettings.layerTest({}),
  Layer.mock(GitWorkflowService.GitWorkflowService)({}),
  Layer.mock(ProjectSetupScriptRunner.ProjectSetupScriptRunner)({}),
  Layer.mock(VcsStatusBroadcaster.VcsStatusBroadcaster)({}),
);

const ToolsListPayload = Schema.fromJsonString(
  Schema.Struct({
    result: Schema.Struct({
      tools: Schema.Array(
        Schema.Struct({
          name: Schema.String,
          inputSchema: Schema.Struct({ type: Schema.optional(Schema.String) }),
          annotations: Schema.optional(
            Schema.Struct({
              readOnlyHint: Schema.optional(Schema.Boolean),
              destructiveHint: Schema.optional(Schema.Boolean),
              openWorldHint: Schema.optional(Schema.Boolean),
            }),
          ),
        }),
      ),
    }),
  }),
);
const decodeToolsListPayload = Schema.decodeUnknownEffect(ToolsListPayload);

it.effect.each(
  [false, true].map((includeThreadRead) => ({
    caseTitle: `production mcp layer lists worktree tools over http with thread-read grant ${includeThreadRead}`,
    includeThreadRead,
  })),
)("$caseTitle", ({ includeThreadRead }) =>
  Effect.scoped(
    Effect.gen(function* () {
      const routes = McpHttpServer.layer.pipe(Layer.provide(McpSessionRegistry.layer));
      yield* HttpRouter.serve(routes, {
        disableListenLog: true,
        disableLogger: true,
      }).pipe(
        Layer.provide(
          Layer.mock(ServerEnvironment.ServerEnvironment)({
            getEnvironmentId: Effect.succeed(EnvironmentId.make("environment-scratch")),
          }),
        ),
        Layer.provide(PreviewAutomationBroker.layer),
        Layer.provide(StubServicesLive),
        Layer.build,
      );

      const registry = McpSessionRegistry.issueActiveMcpCredential({
        threadId: ThreadId.make("thread-scratch"),
        providerInstanceId: ProviderInstanceId.make("claudeAgent"),
        capabilities: new Set([
          "worktree",
          "orchestration",
          "preview",
          ...(includeThreadRead ? ["threads:read" as const] : []),
        ]),
      });
      const credential = yield* registry;
      expect(credential).toBeDefined();

      const httpClient = yield* HttpClient.HttpClient;
      const auth = credential!.config.authorizationHeader;
      const initResponse = yield* httpClient.post("/mcp", {
        headers: {
          accept: "application/json, text/event-stream",
          "x-t3-orchestration-protocol": "2",
          authorization: auth,
        },
        body: HttpBody.text(
          `{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"scratch","version":"1.0.0"}}}`,
          "application/json",
        ),
      });
      expect(initResponse.status).toBe(200);
      const sessionId = initResponse.headers["mcp-session-id"];

      const listResponse = yield* httpClient.post("/mcp", {
        headers: {
          accept: "application/json, text/event-stream",
          "x-t3-orchestration-protocol": "2",
          authorization: auth,
          "mcp-protocol-version": "2025-06-18",
          ...(sessionId ? { "mcp-session-id": sessionId } : {}),
        },
        body: HttpBody.text(
          `{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}`,
          "application/json",
        ),
      });
      const bodyText = yield* listResponse.text;
      expect(listResponse.status, bodyText).toBe(200);
      expect(
        bodyText,
        "tool discovery must return a result rather than a JSON-RPC error",
      ).not.toContain('"error":');
      const payload = yield* decodeToolsListPayload(bodyText.match(/\{.*\}/s)![0]);
      const tools = payload.result.tools;
      const toolNames = tools.map((tool) => tool.name);
      const deviceNames = new Set(Object.keys(DeviceToolkit.tools));
      const hostNames = McpHttpServer.hostMcpTools.map((tool) => tool.name);
      expect(toolNames.filter((name) => name === "scient_thread_read")).toHaveLength(
        includeThreadRead ? 1 : 0,
      );
      if (includeThreadRead)
        expect(
          tools.find((tool) => tool.name === "scient_thread_read")?.annotations?.readOnlyHint,
        ).toBe(true);
      expect(toolNames.filter((name) => name === "scient_thread_inspect")).toHaveLength(1);
      expect(
        tools.find((tool) => tool.name === "scient_thread_inspect")?.annotations?.readOnlyHint,
      ).toBe(false);
      expect(new Set(hostNames).size).toBe(hostNames.length);
      expect(new Set(toolNames).size).toBe(toolNames.length);
      for (const name of hostNames) {
        expect(scientOperationCatalog.forTool(name), `${name} must have one owner`).toBeUndefined();
        expect(toolNames.includes(name), `registered host tool ${name}`).toBe(
          !deviceNames.has(name),
        );
      }
      for (const name of toolNames) {
        expect(
          hostNames.includes(name) || scientOperationCatalog.forTool(name) !== undefined,
          `${name} must be declared`,
        ).toBe(true);
      }
      expect(toolNames).toContain("scient_worktree_handoff");
      expect(toolNames).toContain("scient_worktree_status");
      // The worktree registration merges alongside the other toolkits rather
      // than replacing them.
      expect(toolNames).toContain("preview_status");
      expect(toolNames).toContain("delegate_task");

      // The handoff tool mutates thread state, reaches the network (origin
      // fetch), and runs project setup scripts, so its MCP hints must not
      // promise a read-only, closed-world, non-destructive tool.
      const handoff = tools.find((tool) => tool.name === "scient_worktree_handoff");
      expect(handoff?.annotations?.readOnlyHint).toBe(false);
      expect(handoff?.annotations?.destructiveHint).toBe(true);
      expect(handoff?.annotations?.openWorldHint).toBe(true);
      const status = tools.find((tool) => tool.name === "scient_worktree_status");
      expect(status?.annotations?.readOnlyHint).toBe(true);
      expect(status?.annotations?.destructiveHint).toBe(false);

      // MCP requires every tool input schema to be a top-level object schema.
      // A non-object schema (e.g. the anyOf produced by an empty
      // Schema.Struct({})) makes clients reject the entire server.
      for (const tool of tools) {
        expect(tool.inputSchema.type, `inputSchema.type of ${tool.name}`).toBe("object");
      }
    }),
  ).pipe(
    Effect.provide(
      Layer.mergeAll(
        NodeHttpServer.layerTest,
        ServerConfig.layerTest(process.cwd(), { prefix: "t3-worktree-mcp-" }).pipe(
          Layer.provide(NodeServices.layer),
        ),
        NodeServices.layer,
      ),
    ),
  ),
);
