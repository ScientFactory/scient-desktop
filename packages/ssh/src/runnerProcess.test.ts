import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  SCIENT_SERVER_PACKAGE_NAME,
  scientServerAllowedScriptsValue,
  scientServerPackageSpec,
} from "@t3tools/shared/scientRelease";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import * as NodeNet from "node:net";

import { buildRemoteT3RunnerScript } from "./tunnel.ts";

const Started = Schema.Struct({
  pid: Schema.Number,
  port: Schema.Number,
  args: Schema.Array(Schema.String),
});
const decodeStarted = Schema.decodeUnknownSync(Schema.fromJsonString(Started));

// npm's npx cache layout: the package bin links into the package, and the
// hidden lockfile records the spec npm fetched it from.
const writePinnedInstall = Effect.fn("test.writePinnedInstall")(function* (
  fixture: string,
  packageSpec: string,
  cliSource: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const modules = path.join(fixture, "npx cache", "node_modules");
  const cliTarget = path.join(modules, SCIENT_SERVER_PACKAGE_NAME, "cli.mjs");
  const cliPath = path.join(modules, ".bin", "scient");
  yield* fs.makeDirectory(path.join(modules, ".bin"), { recursive: true });
  yield* fs.makeDirectory(path.dirname(cliTarget));
  yield* fs.writeFileString(cliTarget, cliSource);
  yield* fs.chmod(cliTarget, 0o700);
  yield* fs.symlink(path.join("..", SCIENT_SERVER_PACKAGE_NAME, "cli.mjs"), cliPath);
  yield* fs.writeFileString(
    path.join(modules, ".package-lock.json"),
    JSON.stringify({
      packages: { [`node_modules/${SCIENT_SERVER_PACKAGE_NAME}`]: { resolved: packageSpec } },
    }),
  );
  return cliPath;
});

describe.skipIf(HostProcess.Platform.defaultValue() === "win32")(
  "remote runner process ownership",
  () => {
    it.live.each(["npx", "npm"] as const)(
      "keeps the server PID and graceful shutdown through the %s fallback",
      (packageManager) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
          const fixture = yield* fs.makeTempDirectoryScoped({ prefix: "t3-runner-" });
          const bin = path.join(fixture, "bin");
          const callsPath = path.join(fixture, "package-manager-calls.jsonl");
          const packageSpec = scientServerPackageSpec("0.0.35");
          yield* fs.makeDirectory(bin);
          yield* fs.symlink(process.execPath, path.join(bin, "node"));
          const cliPath = yield* writePinnedInstall(
            fixture,
            packageSpec,
            `#!/usr/bin/env node
import * as net from "node:net";
const server = net.createServer((socket) => {
  socket.end();
  server.close();
});
process.on("SIGTERM", () => server.close(() => {
  process.stdout.write("graceful shutdown\\n");
}));
server.listen(Number(process.env.T3_TEST_PORT ?? 0), "127.0.0.1", () => {
  process.stdout.write(JSON.stringify({
    pid: process.pid,
    port: server.address().port,
    args: process.argv.slice(2),
  }) + "\\n");
});
`,
          );
          yield* fs.writeFileString(
            path.join(bin, packageManager),
            `#!/usr/bin/env node
const fs = require("node:fs");
const childProcess = require("node:child_process");
const args = process.argv.slice(2);
fs.appendFileSync(process.env.T3_TEST_CALLS, JSON.stringify(args) + "\\n");
if (args.includes("--package")) {
  process.stdout.write(process.env.T3_TEST_CLI + "\\n");
} else {
  const child = childProcess.spawn(process.execPath, [process.env.T3_TEST_CLI, ...args], { stdio: "inherit" });
  child.once("exit", (code) => { process.exitCode = code ?? 1; });
}
`,
          );
          yield* fs.chmod(path.join(bin, packageManager), 0o700);

          const runServer = (port = 0) =>
            Effect.gen(function* () {
              const child = yield* spawner.spawn(
                ChildProcess.make("/bin/sh", ["-s", "--", "serve", "a path with spaces"], {
                  cwd: fixture,
                  env: {
                    PATH: bin,
                    T3_TEST_CLI: cliPath,
                    T3_TEST_CALLS: callsPath,
                    T3_TEST_PORT: String(port),
                  },
                  detached: false,
                  stdin: Stream.make(
                    new TextEncoder().encode(buildRemoteT3RunnerScript({ packageSpec })),
                  ),
                }),
              );
              const ready = yield* Deferred.make<typeof Started.Type>();
              const stdout: string[] = [];
              const output = yield* child.stdout.pipe(
                Stream.decodeText(),
                Stream.splitLines,
                Stream.runForEach((line) =>
                  Effect.gen(function* () {
                    stdout.push(line);
                    if (stdout.length === 1) {
                      yield* Deferred.succeed(ready, decodeStarted(line));
                    }
                  }),
                ),
                Effect.forkScoped,
              );
              const stderr = yield* child.stderr.pipe(
                Stream.decodeText(),
                Stream.mkString,
                Effect.forkScoped,
              );
              const receipt = yield* Effect.raceFirst(
                Deferred.await(ready),
                Fiber.join(output).pipe(
                  Effect.flatMap(() => Fiber.join(stderr)),
                  Effect.flatMap((message) =>
                    Effect.die(new Error(`Runner exited before listening: ${message}`)),
                  ),
                ),
              );
              // A failed PID assertion must still close the owned fixture server, including an npm child.
              yield* Effect.addFinalizer(() =>
                Effect.gen(function* () {
                  if (yield* child.isRunning) {
                    yield* Effect.callback<void>((resume) => {
                      const connection = NodeNet.connect(receipt.port, "127.0.0.1");
                      connection.on("error", () => undefined);
                      connection.once("close", () => resume(Effect.void));
                      return Effect.sync(() => connection.destroy());
                    });
                    yield* child.exitCode;
                  }
                }).pipe(Effect.orDie),
              );
              assert.equal(receipt.pid, child.pid);
              assert.deepEqual(receipt.args, ["serve", "a path with spaces"]);
              yield* child.kill({ killSignal: "SIGTERM" });
              assert.equal(yield* child.exitCode, 0);
              yield* Fiber.join(output);
              assert.include(stdout, "graceful shutdown");
              return receipt.port;
            }).pipe(Effect.scoped);

          const port = yield* runServer();
          assert.equal(yield* runServer(port), port);
          const calls = (yield* fs.readFileString(callsPath))
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line));
          const expectedCall = [
            ...(packageManager === "npm" ? ["exec"] : []),
            "--yes",
            "--allow-scripts=node-pty@1.1.0,msgpackr-extract@3.0.4",
            "--package",
            packageSpec,
            "--",
            "sh",
            "-c",
            "command -v scient",
          ];
          assert.deepEqual(calls, [expectedCall, expectedCall]);
        }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
    );
  },
);

describe.skipIf(HostProcess.Platform.defaultValue() === "win32")(
  "remote runner install diagnostics",
  () => {
    const decodeArguments = Schema.decodeUnknownSync(
      Schema.fromJsonString(Schema.Array(Schema.String)),
    );
    const cases = (["npx", "npm"] as const).flatMap((packageManager) =>
      (
        [
          "etarget",
          "network",
          "empty-success",
          "success",
          "failed-with-path",
          "existing-cli",
          "path-shadow",
          "node-override",
          "unpinned",
        ] as const
      ).map((mode) => ({ packageManager, mode })),
    );

    it.live.each(cases)("handles $packageManager/$mode", ({ packageManager, mode }) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        const fixture = yield* fs.makeTempDirectoryScoped({ prefix: "t3-runner-install-" });
        const bin = path.join(fixture, "bin");
        const callsPath = path.join(fixture, "installer-calls.jsonl");
        const packageSpec = scientServerPackageSpec("0.0.39-beta.20260905.1");
        const args = ["serve", "a path with spaces"];
        yield* fs.makeDirectory(bin);
        yield* fs.symlink(process.execPath, path.join(bin, "node"));
        const cliPath = yield* writePinnedInstall(
          fixture,
          packageSpec,
          `#!/usr/bin/env node
process.stdout.write(JSON.stringify(process.argv.slice(2)) + "\\n");
`,
        );
        yield* fs.writeFileString(callsPath, "");
        // "path-shadow" is npm without a package executable: `command -v` then
        // falls through to whatever scient is on the inherited PATH.
        yield* fs.writeFileString(
          path.join(bin, packageManager),
          `#!/usr/bin/env node
const fs = require("node:fs");
fs.appendFileSync(process.env.T3_TEST_CALLS, JSON.stringify(process.argv.slice(2)) + "\\n");
const mode = process.env.T3_TEST_MODE;
if (mode === "success" || mode === "failed-with-path" || mode === "existing-cli") {
  process.stdout.write(process.env.T3_TEST_CLI + "\\n");
} else if (mode === "path-shadow") {
  process.stdout.write(process.env.PATH + "/scient\\n");
}
if (mode === "etarget" || mode === "failed-with-path") {
  process.stderr.write("npm error code ETARGET\\nnpm error notarget No matching version found.\\n");
  process.exitCode = 42;
} else if (mode === "network") {
  process.stderr.write("npm error code ENETUNREACH\\n");
  process.exitCode = 43;
}
`,
        );
        yield* fs.chmod(path.join(bin, packageManager), 0o700);
        // A CLI already on the remote PATH is never trusted in place of the pinned package.
        if (mode === "existing-cli" || mode === "path-shadow") {
          const pathCli = path.join(fixture, "path cli.mjs");
          yield* fs.writeFileString(
            pathCli,
            `#!/usr/bin/env node
process.stderr.write("path cli ran\\n");
process.exitCode = 99;
`,
          );
          yield* fs.chmod(pathCli, 0o700);
          yield* fs.symlink(pathCli, path.join(bin, "t3"));
          yield* fs.symlink(pathCli, path.join(bin, "scient"));
        }

        const child = yield* spawner.spawn(
          ChildProcess.make("/bin/sh", ["-s", "--", ...args], {
            cwd: fixture,
            extendEnv: false,
            env: {
              PATH: bin,
              T3_TEST_MODE: mode,
              T3_TEST_CLI: cliPath,
              T3_TEST_CALLS: callsPath,
            },
            stdin: Stream.make(
              new TextEncoder().encode(
                buildRemoteT3RunnerScript({
                  ...(mode === "unpinned" ? {} : { packageSpec }),
                  ...(mode === "node-override" ? { nodeScriptPath: cliPath } : {}),
                }),
              ),
            ),
          }),
        );
        const { stdout, stderr, exitCode } = yield* Effect.all(
          {
            stdout: child.stdout.pipe(Stream.decodeText(), Stream.mkString),
            stderr: child.stderr.pipe(Stream.decodeText(), Stream.mkString),
            exitCode: child.exitCode,
          },
          { concurrency: "unbounded" },
        );
        const installFailed =
          mode === "etarget" || mode === "network" || mode === "failed-with-path";
        const missingExecutable = mode === "empty-success" || mode === "path-shadow";
        const unpinned = mode === "unpinned";
        assert.equal(exitCode, installFailed || missingExecutable || unpinned ? 1 : 0);
        if (installFailed || missingExecutable || unpinned) {
          assert.equal(stdout, "");
        } else {
          assert.deepEqual(decodeArguments(stdout), args);
        }
        if (installFailed) {
          const npmError = mode === "network" ? "ENETUNREACH" : "ETARGET";
          assert.include(stderr, `npm error code ${npmError}\n`);
          assert.include(
            stderr,
            `Remote host could not install the Scient server from ${packageSpec}.`,
          );
          assert.notInclude(stderr, "Remote host installed");
          assert.notInclude(stderr, "Install a C toolchain");
        } else if (missingExecutable) {
          assert.include(stderr, `Remote host installed ${packageSpec}`);
          assert.include(stderr, "npm produced no scient executable");
          assert.include(stderr, "Install a C toolchain");
          assert.notInclude(stderr, "path cli ran");
        } else if (unpinned) {
          assert.include(stderr, "This Scient build has no published Scient server release");
        } else {
          assert.equal(stderr, "");
        }
        const expectedCall = [
          ...(packageManager === "npm" ? ["exec"] : []),
          "--yes",
          `--allow-scripts=${scientServerAllowedScriptsValue()}`,
          "--package",
          packageSpec,
          "--",
          "sh",
          "-c",
          "command -v scient",
        ];
        const usesInstaller = mode !== "node-override" && mode !== "unpinned";
        const calls = yield* fs.readFileString(callsPath);
        if (usesInstaller) {
          assert.deepEqual(
            calls
              .trim()
              .split("\n")
              .map((line) => decodeArguments(line)),
            [expectedCall],
          );
        } else {
          assert.equal(calls, "");
        }
      }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
    );
  },
);
