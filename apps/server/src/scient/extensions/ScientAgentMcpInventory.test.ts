import { NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import * as Schema from "effect/Schema";
import { makeScientAgentPluginInventory } from "./ScientAgentPluginInventory.ts";
import { readScientAgentMcpServers } from "./ScientAgentMcpInventory.ts";
const encode = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

describe("Scient Agent standalone MCP inventory", () => {
  it.effect(
    "publishes configured servers without leaking their credentials or claiming they connected",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const root = yield* fs.makeTempDirectoryScoped();
          yield* fs.makeDirectory(path.join(root, "agent"));
          const file = path.join(root, "agent", "mcp.json");
          yield* fs.writeFileString(
            file,
            encode({
              mcpServers: {
                lab: { command: "lab", env: { API_KEY: "synthetic-private-key" } },
                off: { url: "https://example.com", disabled: true },
              },
            }),
          );
          const servers = yield* readScientAgentMcpServers(root);
          expect(servers).toEqual([
            { name: "lab", scope: "user", status: "unknown" },
            { name: "off", scope: "user", status: "disabled" },
          ]);
          expect(encode(servers)).not.toContain("synthetic-private-key");
          const native = yield* makeScientAgentPluginInventory(
            () => Effect.succeed(encode({ npm: [], marketplace: [] })),
            () => Effect.succeed([]),
            () =>
              readScientAgentMcpServers(root).pipe(
                Effect.provideService(FileSystem.FileSystem, fs),
                Effect.provideService(Path.Path, path),
              ),
          );
          yield* native.actions.refreshInventory!({ force: true });
          const report = yield* native.reports.pipe(Stream.runHead);
          expect(report._tag === "Some" && report.value.mcpServers).toEqual(servers);
          yield* fs.writeFileString(file, "broken JSON");
          expect(
            (yield* native.actions.refreshInventory!({ force: true }).pipe(Effect.result))._tag,
          ).toBe("Failure");
        }),
      ).pipe(Effect.provide(NodeServices.layer)),
  );
});
