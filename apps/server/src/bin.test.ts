// @effect-diagnostics nodeBuiltinImport:off - CLI integration exercises Node HTTP and filesystem boundaries.

import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NetService from "@t3tools/shared/Net";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Layer from "effect/Layer";
import * as TestConsole from "effect/testing/TestConsole";
import { Command } from "effect/cli";

import { cli, makeCli } from "./binCli.ts";

const CliRuntimeLayer = Layer.mergeAll(
  NodeServices.layer,
  NetService.layer,
  ConfigProvider.layer(ConfigProvider.fromEnv({ env: {} })),
);
const noConnectCli = makeCli({ cloudEnabled: false });
const runCli = (args: ReadonlyArray<string>, command = cli) =>
  Command.runWith(command, { version: "0.0.0" })(args);

const captureStdout = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const result = yield* effect;
    const output =
      (yield* TestConsole.logLines).findLast((line): line is string => typeof line === "string") ??
      "";
    return { result, output };
  }).pipe(Effect.provide(Layer.mergeAll(CliRuntimeLayer, TestConsole.layer)));

it.layer(NodeServices.layer)("bin cli parsing", (it) => {
  it.effect("uses scient in root and nested help, version, and parser errors", () =>
    Effect.gen(function* () {
      for (const args of [["--help"], ["app", "--help"], ["browser", "--help"]]) {
        const { output } = yield* captureStdout(runCli(args));
        assert.include(output, "scient ");
        assert.notMatch(output, /\bt3 (?:<subcommand>|app|browser)\b/);
      }
      const { output } = yield* captureStdout(runCli(["--version"]));
      assert.include(output, "scient v0.0.0");
    }),
  );

  it.effect("does not expose the inherited service lifecycle in Scient", () =>
    Effect.gen(function* () {
      const { output } = yield* captureStdout(runCli(["--help"], noConnectCli));

      assert.notInclude(output, "Manage the Scient background service.");
      for (const command of [
        "service",
        "__service-preflight",
        "update",
        "uninstall",
        "__service-launcher",
      ]) {
        assert.isFalse(
          noConnectCli.subcommands
            .flatMap((group) => group.commands)
            .some((candidate) => candidate.name === command),
          command,
        );
        // The root accepts a positional cwd, so an unknown name alone is a
        // directory argument. --help exercises parsing without starting a server.
        const help = yield* captureStdout(runCli([command, "--help"], noConnectCli));
        assert.include(help.output, "Run the Scient server.", command);
      }
    }),
  );
});
