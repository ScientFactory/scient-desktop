import { NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { codexComputerUsePathArgs } from "./CodexComputerUsePath.ts";

const RELATIVE =
  "./Codex Computer Use.app/Contents/SharedSupport/SkyComputerUseClient.app/Contents/MacOS/SkyComputerUseClient";

const entry = (command: string, extra = "") => `
model = "gpt"

[mcp_servers.computer-use]
command = ${JSON.stringify(command)}
args = ["mcp"]
cwd = "."
${extra}
`;

/** A Codex home holding `config` and, unless `program` is false, the Computer Use program. */
const codexHome = (config: string, program = true) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const home = yield* fs.makeTempDirectoryScoped();
    const codex = path.join(home, ".codex");
    yield* fs.makeDirectory(codex, { recursive: true });
    yield* fs.writeFileString(path.join(codex, "config.toml"), config);
    const installed = path.join(codex, "computer-use", RELATIVE);
    if (program) {
      yield* fs.makeDirectory(path.dirname(installed), { recursive: true });
      yield* fs.writeFileString(installed, "");
    }
    return { home, codex, installed };
  });

const run = (environment: NodeJS.ProcessEnv, platform: NodeJS.Platform = "darwin") =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    return yield* codexComputerUsePathArgs(environment, fs, path).pipe(
      Effect.provideService(HostProcess.Platform, platform),
    );
  });

describe("codexComputerUsePathArgs", () => {
  it.effect("launches the ChatGPT-written Computer Use entry with absolute paths", () =>
    Effect.gen(function* () {
      const { home, codex, installed } = yield* codexHome(entry(RELATIVE, "enabled = true"));
      const path = yield* Path.Path;
      expect(yield* run({ HOME: home })).toEqual([
        "-c",
        `mcp_servers.computer-use.command=${JSON.stringify(installed)}`,
        "-c",
        `mcp_servers.computer-use.cwd=${JSON.stringify(path.join(codex, "computer-use"))}`,
      ]);
      expect(yield* run({ CODEX_HOME: codex })).toHaveLength(4);

      // A shadow home links config.toml from the shared home, where the program lives.
      const fs = yield* FileSystem.FileSystem;
      const shadow = path.join(home, "shadow");
      yield* fs.makeDirectory(shadow);
      yield* fs.symlink(path.join(codex, "config.toml"), path.join(shadow, "config.toml"));
      const shared = path.join(yield* fs.realPath(codex), "computer-use");
      expect(yield* run({ CODEX_HOME: shadow })).toContain(
        `mcp_servers.computer-use.cwd=${JSON.stringify(shared)}`,
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("leaves every other case alone", () =>
    Effect.gen(function* () {
      const disabled = yield* codexHome(entry(RELATIVE, "enabled = false"));
      const absolute = yield* codexHome(entry("/opt/computer-use/client"));
      const missing = yield* codexHome(entry(RELATIVE), false);
      const invalid = yield* codexHome("not = [toml");
      const broken = yield* codexHome(entry(RELATIVE));
      for (const home of [disabled, absolute, missing, invalid]) {
        expect(yield* run({ HOME: home.home })).toEqual([]);
      }
      expect(yield* run({ HOME: broken.home }, "linux")).toEqual([]);
      expect(yield* run({ HOME: broken.home }, "win32")).toEqual([]);
      expect(yield* run({ HOME: `${broken.home}/nowhere` })).toEqual([]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
