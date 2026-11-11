import { expect, it } from "@effect/vitest";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { McpSchema, McpServer } from "effect/ai";
import { WorkspaceBindingResolver } from "../../../scient/projectScope/WorkspaceBindingResolver.ts";
import {
  workspaceResolverForTest,
  workspaceScopeForTest,
} from "../../../scient/projectScope/WorkspaceBindingTestUtils.ts";

import { ScientSourcesToolkitRegistrationLive } from "../../McpHttpServer.ts";
import { McpInvocationContext, type McpCapability } from "../../McpInvocationContext.ts";

const TestLayer = ScientSourcesToolkitRegistrationLive.pipe(
  Layer.provide(Layer.succeed(WorkspaceBindingResolver, workspaceResolverForTest(new Map()))),
  Layer.provideMerge(McpServer.McpServer.layer),
);

it.effect("registers one shared Sources toolkit with explicit read and note-write semantics", () =>
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    const sourceTools = server.tools.filter(({ tool }) => tool.name.startsWith("scient_sources_"));

    expect(sourceTools.map(({ tool }) => tool.name).sort()).toEqual([
      "scient_sources_add",
      "scient_sources_attach_pdf",
      "scient_sources_bibliography",
      "scient_sources_bulk_update",
      "scient_sources_check",
      "scient_sources_cite",
      "scient_sources_collections",
      "scient_sources_detach_pdf",
      "scient_sources_export",
      "scient_sources_get",
      "scient_sources_import_file",
      "scient_sources_list",
      "scient_sources_note_update",
      "scient_sources_organize",
      "scient_sources_quote_check",
      "scient_sources_read_text",
      "scient_sources_remove",
      "scient_sources_restore",
      "scient_sources_revert",
      "scient_sources_save_page",
      "scient_sources_search",
      "scient_sources_update",
      "scient_sources_zotero_browse",
      "scient_sources_zotero_import",
      "scient_sources_zotero_refresh",
      "scient_sources_zotero_send",
    ]);
    for (const { tool } of sourceTools.filter(({ tool }) =>
      [
        "scient_sources_collections",
        "scient_sources_get",
        "scient_sources_list",
        "scient_sources_search",
        "scient_sources_read_text",
        "scient_sources_quote_check",
      ].includes(tool.name),
    )) {
      expect(tool.annotations?.readOnlyHint).toBe(true);
      expect(tool.annotations?.destructiveHint).toBe(false);
      expect(tool.annotations?.idempotentHint).toBe(true);
      expect(tool.annotations?.openWorldHint).toBe(false);
    }
    const writeTools = sourceTools.filter(({ tool }) =>
      [
        "scient_sources_add",
        "scient_sources_attach_pdf",
        "scient_sources_bibliography",
        "scient_sources_bulk_update",
        "scient_sources_check",
        "scient_sources_cite",
        "scient_sources_detach_pdf",
        "scient_sources_export",
        "scient_sources_import_file",
        "scient_sources_note_update",
        "scient_sources_organize",
        "scient_sources_remove",
        "scient_sources_restore",
        "scient_sources_revert",
        "scient_sources_save_page",
        "scient_sources_update",
      ].includes(tool.name),
    );
    for (const { tool } of writeTools) {
      expect(tool.annotations).toMatchObject({
        readOnlyHint: false,
        destructiveHint: ["scient_sources_detach_pdf", "scient_sources_remove"].includes(tool.name),
        idempotentHint: true,
        openWorldHint: [
          "scient_sources_add",
          "scient_sources_check",
          "scient_sources_cite",
          "scient_sources_save_page",
        ].includes(tool.name),
      });
    }
    for (const { tool } of sourceTools.filter(({ tool }) => tool.name.includes("_zotero_"))) {
      expect(tool.annotations).toMatchObject({
        readOnlyHint: tool.name === "scient_sources_zotero_browse",
        destructiveHint: tool.name === "scient_sources_zotero_send",
        openWorldHint: true,
      });
    }
  }).pipe(Effect.provide(TestLayer)),
);

const readTextRoot = "/test/read-text";
const readTextEnvironment = EnvironmentId.make("environment-read-text");
const readTextFixture = workspaceResolverForTest(
  new Map([
    [
      readTextRoot,
      {
        projectId: "project-read-text",
        scope: workspaceScopeForTest("binding-read-text", readTextRoot),
      },
    ],
  ]),
);
const ReadTextLayer = ScientSourcesToolkitRegistrationLive.pipe(
  Layer.provide(
    Layer.succeed(WorkspaceBindingResolver, {
      ...readTextFixture,
      resolveThread: Effect.fn("ReadTextTest.resolveThread")(function* () {
        const resolved = yield* readTextFixture.resolveWorkspaceRoot(readTextRoot);
        return {
          ...resolved,
          binding: { ...resolved.binding, environmentId: readTextEnvironment },
        };
      }),
    }),
  ),
  Layer.provideMerge(McpServer.McpServer.layer),
);

it.effect("refuses read_text parameters it does not know instead of reading page 1", () =>
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    const refused = yield* server
      .callTool({ name: "scient_sources_read_text", arguments: { sourceId: "src-1", page: 2 } })
      .pipe(
        Effect.provideService(McpSchema.McpServerClient, {
          clientId: 1,
          clientCapabilities: {},
          clientInfo: { name: "read-text", version: "1" },
          protocolVersion: "2025-06-18",
          initializePayload: {
            protocolVersion: "2025-06-18",
            capabilities: {},
            clientInfo: { name: "read-text", version: "1" },
          },
          getClient: Effect.die("Unused client callback"),
        }),
        Effect.provideService(McpInvocationContext, {
          environmentId: readTextEnvironment,
          requestNamespace: "read-text",
          thread: {
            threadId: ThreadId.make("thread-read-text"),
            providerSessionId: "read-text",
            providerInstanceId: ProviderInstanceId.make("codex"),
          },
          client: undefined,
          capabilities: new Set<McpCapability>(["sources:read"]),
          issuedAt: 1,
        }),
        Effect.flip,
      );

    expect(refused).toBeInstanceOf(McpSchema.InvalidParams);
    expect(refused.message).toContain('["page"]');
    expect(refused.message).toContain("Accepted: sourceId, attachmentId, fromPage, maxCharacters");
  }).pipe(Effect.provide(ReadTextLayer)),
);
