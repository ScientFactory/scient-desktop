import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { McpServer } from "effect/ai";

import { ScientOverleafToolkitRegistrationLive } from "../../McpHttpServer.ts";
import { scientOperationCatalog } from "../../ScientOperationCatalog.ts";
import { OverleafEditorSave } from "../../../scient/overleaf/OverleafEditorSave.ts";
import { OverleafSync } from "../../../scient/overleaf/OverleafSync.ts";
import { WorkspaceBindingResolver } from "../../../scient/projectScope/WorkspaceBindingResolver.ts";
import { workspaceResolverForTest } from "../../../scient/projectScope/WorkspaceBindingTestUtils.ts";
import { SecretRequests } from "../../../secrets/SecretRequests.ts";

const TestLayer = ScientOverleafToolkitRegistrationLive.pipe(
  Layer.provide(Layer.mock(OverleafSync)({})),
  Layer.provide(Layer.mock(OverleafEditorSave)({})),
  Layer.provide(Layer.mock(SecretRequests)({})),
  Layer.provide(Layer.succeed(WorkspaceBindingResolver, workspaceResolverForTest(new Map()))),
  Layer.provideMerge(McpServer.McpServer.layer),
);

it.effect(
  "registers the Overleaf tools with honest effects and no Overleaf grant of their own",
  () =>
    Effect.gen(function* () {
      const server = yield* McpServer.McpServer;
      const tools = server.tools.filter(({ tool }) => tool.name.startsWith("scient_overleaf_"));
      expect(tools.map(({ tool }) => tool.name).sort()).toEqual([
        "scient_overleaf_connect",
        "scient_overleaf_kept_copies",
        "scient_overleaf_manage",
        "scient_overleaf_preview",
        "scient_overleaf_status",
        "scient_overleaf_sync",
        "scient_overleaf_token",
      ]);
      for (const { tool } of tools) {
        expect(tool.inputSchema.type).toBe("object");
        // A token never travels as tool input; only a secretRef does.
        expect(Object.keys(tool.inputSchema.properties ?? {})).not.toContain("token");
        expect(tool.annotations).toMatchObject({
          readOnlyHint: tool.name === "scient_overleaf_status",
          destructiveHint: [
            "scient_overleaf_sync",
            "scient_overleaf_kept_copies",
            "scient_overleaf_manage",
            "scient_overleaf_token",
          ].includes(tool.name),
        });
        // The composer's access setting is the only control: the tools need only the
        // document grant every session already has, and describe no approval step.
        const operation = scientOperationCatalog.forTool(tool.name)!;
        expect(operation).toMatchObject({
          family: "overleaf",
          scope: "workspace",
          requiredCapabilities: ["documents:build"],
          approval: "session-grant",
        });
        expect(tool.description).not.toMatch(/confirm with the user|ask the user to approve/iu);
      }
      const description = (name: string) =>
        tools.find(({ tool }) => tool.name === name)!.tool.description ?? "";
      expect(description("scient_overleaf_sync")).toContain("Only a conflict stops it");
      expect(description("scient_overleaf_sync")).toContain("save the folder's open editors");
      expect(description("scient_overleaf_token")).toContain("request_secret");
      expect(description("scient_overleaf_token")).toContain("Never ask for the token in chat");
      expect(description("scient_overleaf_connect")).toContain("mode new-folder");
    }).pipe(Effect.provide(TestLayer)),
);
