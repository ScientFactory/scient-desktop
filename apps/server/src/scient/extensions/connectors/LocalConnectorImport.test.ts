// @effect-diagnostics nodeBuiltinImport:off -- Writes other apps' settings files into a scratch home folder.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { readImportableServers } from "./LocalConnectorImport.ts";

const CODEX_CONFIG = `
[mcp_servers.helper]
command = "./Helper.app/Contents/MacOS/helper"
args = ["mcp"]
cwd = "."

[mcp_servers.repl]
command = "/opt/tools/repl"
env_vars = ["APP_PIPE", "NOTES_API_KEY"]

[mcp_servers.off]
command = "/opt/tools/off"
enabled = false
`;

describe("readImportableServers", () => {
  it.live(
    "reads relative paths against the settings folder, skips servers turned off, and keeps passed-through variables",
    () =>
      Effect.gen(function* () {
        const home = yield* Effect.promise(() =>
          NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "scient-import-")),
        );
        yield* Effect.addFinalizer(() =>
          Effect.promise(() => NodeFSP.rm(home, { recursive: true, force: true })),
        );
        yield* Effect.promise(async () => {
          await NodeFSP.mkdir(NodePath.join(home, ".codex"));
          await NodeFSP.writeFile(NodePath.join(home, ".codex", "config.toml"), CODEX_CONFIG);
          await NodeFSP.writeFile(
            NodePath.join(home, ".claude.json"),
            JSON.stringify({
              mcpServers: {
                quiet: { command: "/opt/tools/quiet", disabled: true },
                tools: { command: "bin/tools", cwd: "work" },
              },
            }),
          );
        });

        const servers = yield* readImportableServers({
          home,
          platform: "darwin",
          appData: undefined,
          projectFolders: [],
        });
        const codex = NodePath.join(home, ".codex");
        expect(servers.map((server) => server.name).toSorted()).toEqual([
          "helper",
          "repl",
          "tools",
        ]);
        expect(servers.find((server) => server.name === "helper")).toMatchObject({
          command: NodePath.join(codex, "Helper.app/Contents/MacOS/helper"),
          cwd: codex,
          passEnv: [],
        });
        expect(servers.find((server) => server.name === "repl")).toMatchObject({
          command: "/opt/tools/repl",
          cwd: undefined,
          passEnv: ["APP_PIPE", "NOTES_API_KEY"],
        });
        expect(servers.find((server) => server.name === "tools")).toMatchObject({
          command: NodePath.join(home, "work", "bin/tools"),
          cwd: NodePath.join(home, "work"),
        });
      }).pipe(Effect.scoped),
  );
});
