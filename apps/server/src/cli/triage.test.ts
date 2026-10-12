import * as NodeServices from "@effect/platform-node/NodeServices";
import { afterEach, beforeEach, expect, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { Command } from "effect/cli";

import { triageCommand } from "./triage.ts";

const machinePath = process.env.PATH;
beforeEach(() => {
  process.env.PATH = "";
});
afterEach(() => {
  process.env.PATH = machinePath;
});

it.layer(NodeServices.layer)("triage profile isolation", (it) => {
  it.effect("keeps generated triage files out of ambient T3 and unselected Scient profiles", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped();
      for (const selection of ["environment", "flag", "default"] as const) {
        const home = path.join(root, selection);
        const scient = path.join(home, "scient profile");
        const foreign = path.join(home, "foreign T3 profile");
        const explicit = path.join(home, "explicit profile");
        const defaultHome = path.join(home, ".scient-next");
        const expected =
          selection === "flag" ? explicit : selection === "environment" ? scient : defaultHome;
        const env = {
          PATH: "",
          T3CODE_HOME: foreign,
          ...(selection !== "default" ? { SCIENT_NEXT_HOME: scient } : {}),
        };
        yield* Command.runWith(triageCommand, { version: "0.0.0" })(
          selection === "flag" ? ["--base-dir", explicit] : [],
        ).pipe(
          Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env }))),
          Effect.provideService(HostProcess.HomeDirectory, home),
          Effect.provideService(HostProcess.Environment, env),
          Effect.provideService(HostProcess.Arguments, [
            process.execPath,
            path.join(root, "cli.mjs"),
          ]),
        );
        const generated = yield* fs.readDirectory(path.join(expected, "userdata", "triage"));
        const context = path.join(expected, "userdata", "triage", generated[0]!, "context.md");
        const prompt = path.join(expected, "userdata", "triage", generated[0]!, "prompt.md");
        expect(yield* fs.exists(context)).toBe(true);
        expect(yield* fs.exists(prompt)).toBe(true);
        for (const unselected of [foreign, scient, explicit, defaultHome]) {
          if (unselected !== expected) expect(yield* fs.exists(unselected)).toBe(false);
        }
      }
    }).pipe(Effect.scoped),
  );
});
