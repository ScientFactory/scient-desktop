import { NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { makeOmpExecutableGate, OmpExecutableGate } from "../../provider/omp/OmpExecutableGate.ts";
import { runScientAgentPluginCommand } from "./ProviderPluginCommand.ts";

const encode = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
describe("Scient Agent plugin process source gate", () => {
  it.effect("overrides inherited sources only after identifying a supported runtime", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped();
        const gate = yield* makeOmpExecutableGate();
        for (const [version, enabled, expected] of [
          ["0.1.2", true, ""],
          ["0.1.3", true, "claude-plugins"],
          ["0.1.3", false, ""],
        ] as const) {
          const executable = path.join(root, `agent-${version}-${enabled}`);
          const info = {
            product: "scient-agent",
            version,
            upstream: { name: "oh-my-pi", version: "18.3.1" },
            rpcProtocolVersions: [2],
          };
          yield* fs.writeFileString(
            executable,
            `#!${process.execPath}\nif(process.argv.includes('--runtime-info')) console.log(${encode(encode(info))}); else console.log(process.env.SCIENT_AGENT_ENABLE_SOURCES || '');\n`,
          );
          yield* fs.chmod(executable, 0o700);
          const output = yield* runScientAgentPluginCommand(
            executable,
            { PATH: process.env.PATH, SCIENT_AGENT_ENABLE_SOURCES: "untrusted" },
            root,
            ["plugin", "list", "--json"],
            enabled,
          ).pipe(Effect.provideService(OmpExecutableGate, gate));
          expect(output.trim()).toBe(expected);
        }
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );
});
