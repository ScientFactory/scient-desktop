import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { McpServer } from "effect/ai";
import { WorkspaceBindingResolver } from "../../../scient/projectScope/WorkspaceBindingResolver.ts";
import { workspaceResolverForTest } from "../../../scient/projectScope/WorkspaceBindingTestUtils.ts";

import { ScientSourcesToolkitRegistrationLive } from "../../McpHttpServer.ts";

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
      "scient_sources_collections",
      "scient_sources_detach_pdf",
      "scient_sources_get",
      "scient_sources_list",
      "scient_sources_note_update",
      "scient_sources_organize",
      "scient_sources_quote_check",
      "scient_sources_read_text",
      "scient_sources_remove",
      "scient_sources_restore",
      "scient_sources_revert",
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
        "scient_sources_detach_pdf",
        "scient_sources_note_update",
        "scient_sources_organize",
        "scient_sources_remove",
        "scient_sources_restore",
        "scient_sources_revert",
        "scient_sources_update",
      ].includes(tool.name),
    );
    for (const { tool } of writeTools) {
      expect(tool.annotations).toMatchObject({
        readOnlyHint: false,
        destructiveHint: ["scient_sources_detach_pdf", "scient_sources_remove"].includes(tool.name),
        idempotentHint: true,
        openWorldHint: tool.name === "scient_sources_add",
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
