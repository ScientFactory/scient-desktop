import type { ServerProviderMcpServer } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { readPluginJson } from "./LocalPluginFiles.ts";

const Config = Schema.Struct({
  mcpServers: Schema.Record(
    Schema.String,
    Schema.Struct({
      disabled: Schema.optional(Schema.Boolean),
      enabled: Schema.optional(Schema.Boolean),
    }),
  ),
});
const decodeConfig = Schema.decodeUnknownEffect(Config);
export const readScientAgentMcpServers = Effect.fn("readScientAgentMcpServers")(
  function* (root: string) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const file = path.join(root, "agent", "mcp.json");
    if (!(yield* fs.exists(file))) return [];
    const config = yield* readPluginJson(file).pipe(Effect.flatMap(decodeConfig));
    return Object.entries(config.mcpServers)
      .slice(0, 1000)
      .filter(([name]) => name.trim().length > 0)
      .map(([name, server]): ServerProviderMcpServer => ({
        name,
        scope: "user",
        status: server.disabled || server.enabled === false ? "disabled" : "unknown",
      }));
  },
  Effect.mapError(() => ({ message: "Could not read Scient Agent's MCP configuration." })),
);
