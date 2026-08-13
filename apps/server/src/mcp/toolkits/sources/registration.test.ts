import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { McpServer } from "effect/unstable/ai";

import { ScientSourcesToolkitRegistrationLive } from "../../McpHttpServer.ts";

const TestLayer = ScientSourcesToolkitRegistrationLive.pipe(
  Layer.provideMerge(McpServer.McpServer.layer),
);

it.effect("registers one shared Sources toolkit with explicit read and note-write semantics", () =>
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    const sourceTools = server.tools.filter(({ tool }) => tool.name.startsWith("scient_sources_"));

    expect(sourceTools.map(({ tool }) => tool.name).sort()).toEqual([
      "scient_sources_get",
      "scient_sources_list",
      "scient_sources_note_update",
    ]);
    for (const { tool } of sourceTools.filter(
      ({ tool }) => tool.name !== "scient_sources_note_update",
    )) {
      expect(tool.annotations?.readOnlyHint).toBe(true);
      expect(tool.annotations?.destructiveHint).toBe(false);
      expect(tool.annotations?.idempotentHint).toBe(true);
      expect(tool.annotations?.openWorldHint).toBe(false);
    }
    const noteTool = sourceTools.find(
      ({ tool }) => tool.name === "scient_sources_note_update",
    )?.tool;
    expect(noteTool?.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    });
  }).pipe(Effect.provide(TestLayer)),
);
