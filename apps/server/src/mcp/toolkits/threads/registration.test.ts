import { hasOperationCapabilities } from "@scientfactory/operations";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { McpServer, Tool } from "effect/unstable/ai";

import { ScientThreadsToolkitRegistrationLive } from "../../McpHttpServer.ts";
import { scientOperationCatalog } from "../../ScientOperationCatalog.ts";
import { ProjectionStoreV2 } from "../../../orchestration-v2/ProjectionStore.ts";
import { LegacyV1ThreadImporter } from "../../../orchestration-v2/legacy/LegacyV1ThreadImporter.ts";
import { WorkspaceBindingResolver } from "../../../scient/projectScope/WorkspaceBindingResolver.ts";
import { workspaceResolverForTest } from "../../../scient/projectScope/WorkspaceBindingTestUtils.ts";
import { ScientThreadReadTool } from "./tools.ts";

const TestLayer = ScientThreadsToolkitRegistrationLive.pipe(
  Layer.provide(Layer.mock(ProjectionStoreV2)({ getThreadShell: () => Effect.succeed(null) })),
  Layer.provide(
    Layer.mock(LegacyV1ThreadImporter)({
      ensureTranscript: () => Effect.succeed({ importedThreadCount: 0, importedMessageCount: 0 }),
    }),
  ),
  Layer.provide(Layer.succeed(WorkspaceBindingResolver, workspaceResolverForTest(new Map()))),
  Layer.provideMerge(McpServer.McpServer.layer),
);

it.effect("registers V2's read-only t3_thread_read contract", () =>
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    const registered = server.tools.find(({ tool }) => tool.name === "t3_thread_read");

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
      "afterPosition",
      "itemId",
      "limit",
      "maxCharsPerItem",
      "runLimit",
      "textOffset",
      "threadId",
      "view",
    ]);
    expect(inputSchema.required).toEqual(["threadId"]);
    expect(registered?.tool.description).toContain("textOffset=nextTextOffset");
  }).pipe(Effect.provide(TestLayer)),
);

it("admits t3_thread_read only with the threads:read session grant", () => {
  const operation = scientOperationCatalog.forTool("t3_thread_read");
  expect(operation).toMatchObject({
    id: "threads.read",
    family: "threads",
    scope: "thread",
    requiredCapabilities: ["threads:read"],
    effects: { readOnly: true, destructive: false, idempotent: true, openWorld: false },
  });
  expect(operation?.input).toBe(ScientThreadReadTool.parametersSchema);
  expect(Tool.getJsonSchema(ScientThreadReadTool).type).toBe("object");
  expect(hasOperationCapabilities(operation!, new Set(["threads:read"]))).toBe(true);
  expect(
    hasOperationCapabilities(
      operation!,
      new Set(["sources:read", "sources:write", "documents:build", "compute:inventory"]),
    ),
  ).toBe(false);
});
