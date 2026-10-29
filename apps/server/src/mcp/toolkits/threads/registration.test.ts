import { hasOperationCapabilities } from "@scientfactory/operations";
import { expect, it } from "@effect/vitest";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { vi } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { McpSchema, McpServer, Tool } from "effect/ai";

import { ScientThreadsToolkitRegistrationLive } from "../../McpHttpServer.ts";
import { scientOperationCatalog } from "../../ScientOperationCatalog.ts";
import { ProjectionStoreV2 } from "../../../orchestration-v2/ProjectionStore.ts";
import { McpInvocationContext, type McpCapability } from "../../McpInvocationContext.ts";
import { WorkspaceBindingResolver } from "../../../scient/projectScope/WorkspaceBindingResolver.ts";
import { workspaceResolverForTest } from "../../../scient/projectScope/WorkspaceBindingTestUtils.ts";
import { ScientHandoffSummaryReadTool } from "./tools.ts";

const TestLayer = ScientThreadsToolkitRegistrationLive.pipe(
  Layer.provide(Layer.mock(ProjectionStoreV2)({ getThreadShell: () => Effect.succeed(null) })),
  Layer.provide(Layer.succeed(WorkspaceBindingResolver, workspaceResolverForTest(new Map()))),
  Layer.provideMerge(McpServer.McpServer.layer),
);

it.effect("registers the read-only handoff summary reader contract", () =>
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    const registered = server.tools.find(({ tool }) => tool.name === "scient_handoff_summary_read");

    expect(registered?.tool.annotations).toMatchObject({
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    });
    const inputSchema = registered?.tool.inputSchema as {
      readonly type?: unknown;
      readonly properties?: Record<string, unknown>;
      readonly required?: ReadonlyArray<string>;
    };
    expect(inputSchema.type).toBe("object");
    expect(Object.keys(inputSchema.properties ?? {}).sort()).toEqual([
      "contextHandoffId",
      "textOffset",
      "threadId",
    ]);
    expect(inputSchema.required).toEqual(["threadId", "contextHandoffId"]);
  }).pipe(Effect.provide(TestLayer)),
);

it("admits scient_handoff_summary_read only with the threads:read session grant", () => {
  const operation = scientOperationCatalog.forTool("scient_handoff_summary_read");
  expect(operation).toMatchObject({
    id: "threads.handoff-summary.read",
    family: "threads",
    scope: "thread",
    requiredCapabilities: ["threads:read"],
    effects: { readOnly: true, destructive: false, idempotent: true, openWorld: false },
  });
  expect(scientOperationCatalog.forTool("scient_thread_read")).toBeUndefined();
  expect(scientOperationCatalog.forTool("t3_thread_read")).toBeUndefined();
  expect(operation?.input).toBe(ScientHandoffSummaryReadTool.parametersSchema);
  expect(Tool.getJsonSchema(ScientHandoffSummaryReadTool).type).toBe("object");
  expect(hasOperationCapabilities(operation!, new Set(["threads:read"]))).toBe(true);
  expect(
    hasOperationCapabilities(
      operation!,
      new Set(["sources:read", "sources:write", "documents:build", "compute:inventory"]),
    ),
  ).toBe(false);
});

it.effect(
  "dispatches the summary reader, rejects the retired names, and honors revoked grants",
  () => {
    const lookup = vi.fn(() => Effect.succeed(null));
    const layer = ScientThreadsToolkitRegistrationLive.pipe(
      Layer.provide(
        Layer.mock(ProjectionStoreV2)({
          getThreadShell: lookup,
        }),
      ),
      Layer.provide(Layer.succeed(WorkspaceBindingResolver, workspaceResolverForTest(new Map()))),
      Layer.provideMerge(McpServer.McpServer.layer),
    );
    return Effect.gen(function* () {
      const server = yield* McpServer.McpServer;
      const threadId = ThreadId.make("thread-reader-cutover");
      const client = McpSchema.McpServerClient.of({
        clientId: 1,
        clientCapabilities: {},
        clientInfo: { name: "reader-cutover", version: "1" },
        protocolVersion: "2025-06-18",
        initializePayload: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "reader-cutover", version: "1" },
        },
        getClient: Effect.die("Unused client callback"),
      });
      const call = (name: string, capabilities: ReadonlySet<McpCapability>) =>
        server.callTool({ name, arguments: { threadId, contextHandoffId: "handoff" } }).pipe(
          Effect.provideService(McpSchema.McpServerClient, client),
          Effect.provideService(McpInvocationContext, {
            environmentId: EnvironmentId.make("environment-reader-cutover"),
            requestNamespace: "reader-cutover",
            thread: {
              threadId,
              providerSessionId: "reader-cutover",
              providerInstanceId: ProviderInstanceId.make("codex"),
            },
            client: undefined,
            capabilities,
            issuedAt: 1,
          }),
        );
      const granted = new Set<McpCapability>();
      granted.add("threads:read");
      yield* call("scient_handoff_summary_read", granted);
      expect(lookup).toHaveBeenCalledExactlyOnceWith(threadId);

      for (const name of ["scient_thread_read", "t3_thread_read"]) {
        const retired = yield* Effect.flip(call(name, granted));
        expect(retired._tag).toBe("InvalidParams");
      }
      expect(lookup).toHaveBeenCalledTimes(1);

      granted.clear();
      const revoked = yield* call("scient_handoff_summary_read", granted);
      expect(revoked.isError).toBe(true);
      expect(lookup).toHaveBeenCalledTimes(1);
    }).pipe(Effect.provide(layer));
  },
);
