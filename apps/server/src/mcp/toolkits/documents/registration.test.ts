import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { McpServer } from "effect/unstable/ai";

import { ScientDocumentsToolkitRegistrationLive } from "../../McpHttpServer.ts";

const TestLayer = ScientDocumentsToolkitRegistrationLive.pipe(
  Layer.provideMerge(McpServer.McpServer.layer),
);

it.effect("registers the HTML and LaTeX document build operations", () =>
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    const documentTools = server.tools.filter(({ tool }) =>
      ["scient_pdf_build", "scient_latex_build"].includes(tool.name),
    );

    expect(documentTools.map(({ tool }) => tool.name).sort()).toEqual([
      "scient_latex_build",
      "scient_pdf_build",
    ]);
    expect(
      documentTools.find(({ tool }) => tool.name === "scient_pdf_build")?.tool.annotations,
    ).toMatchObject({
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false,
    });
    expect(
      documentTools.find(({ tool }) => tool.name === "scient_latex_build")?.tool.annotations,
    ).toMatchObject({
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: false,
    });
  }).pipe(Effect.provide(TestLayer)),
);
