// @effect-diagnostics nodeBuiltinImport:off -- The integration fixture binds the same platform socket or named pipe as the CLI.
import * as NodeChildProcess from "node:child_process";
import * as NodeEvents from "node:events";
import * as NodeFSP from "node:fs/promises";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import type { DesktopAppActivationRequest } from "@t3tools/contracts";
import { resolveDesktopAppControlAddress } from "@t3tools/shared/desktopAppControl";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { SCIENT_DESKTOP_IDENTITY } from "@t3tools/shared/scientDesktopIdentity";
import * as NetService from "@t3tools/shared/Net";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { Command } from "effect/cli";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import * as ThreadCommandExecutor from "../orchestration-v2/ThreadCommandExecutor.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProjectCloneTracker from "../project/ProjectCloneTracker.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as BuiltInDrivers from "../sourceControl/builtInDrivers.ts";
import * as SourceControlProviderRegistry from "../sourceControl/SourceControlProviderRegistry.ts";
import * as SourceControlRepositoryService from "../sourceControl/SourceControlRepositoryService.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as VcsProjectConfig from "../vcs/VcsProjectConfig.ts";
import { describe, expect } from "vite-plus/test";

import { makeCli } from "../binCli.ts";
import { PersistedServerRuntimeState } from "../serverRuntimeState.ts";

const liveProcess = Effect.acquireRelease(
  Effect.promise(async () => {
    const child = NodeChildProcess.spawn(process.execPath, ["-e", "process.stdin.resume()"], {
      stdio: ["pipe", "ignore", "ignore"],
    });
    await NodeEvents.EventEmitter.once(child, "spawn");
    return child;
  }),
  (child) =>
    Effect.promise(async () => {
      const exited = NodeEvents.EventEmitter.once(child, "exit");
      child.kill();
      await exited;
    }),
);

const encodeRuntimeState = Schema.encodeEffect(Schema.fromJsonString(PersistedServerRuntimeState));

// The full command tree requires these execution authorities even when a
// fixture invokes another subcommand. Their state belongs to a scoped test profile.
const layerCliAuthority = Layer.mergeAll(
  ThreadCommandExecutor.layer,
  ProjectCloneTracker.layer.pipe(
    Layer.provide(
      SourceControlRepositoryService.layer.pipe(
        Layer.provide(GitVcsDriver.layer),
        Layer.provide(
          SourceControlProviderRegistry.layer.pipe(
            Layer.provide(BuiltInDrivers.layer),
            Layer.provide(VcsDriverRegistry.layer.pipe(Layer.provide(VcsProjectConfig.layer))),
          ),
        ),
      ),
    ),
    Layer.provide(GitVcsDriver.layer),
    Layer.provide(ServerSettings.layer.pipe(Layer.provide(ServerSecretStore.layer))),
    Layer.provide(VcsProcess.layer),
    Layer.provide(FetchHttpClient.layer),
    Layer.provide(SqlitePersistence.layerMemory),
    Layer.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env: {} }))),
    Layer.provide(
      ServerConfig.layerTest("/", { prefix: "scient-cli-authority-test-" }).pipe(
        Layer.provideMerge(NodeServices.layer),
      ),
    ),
  ),
);

const runCli = (args: ReadonlyArray<string>, env: Record<string, string> = {}) =>
  Command.runWith(makeCli(), { version: "0.0.0" })(args).pipe(
    Effect.provide(
      Layer.mergeAll(
        NodeServices.layer,
        NetService.layer,
        layerCliAuthority,
        ConfigProvider.layer(ConfigProvider.fromEnv({ env })),
      ),
    ),
  );

const pathExists = (path: string) =>
  Effect.promise(() =>
    NodeFSP.stat(path).then(
      () => true,
      () => false,
    ),
  );

async function startFakeDesktop(input: {
  readonly baseDir: string;
  readonly stateSubdirectory?: string;
  readonly platform: NodeJS.Platform;
  readonly userId: number | undefined;
  readonly reply?: (request: DesktopAppActivationRequest) => unknown;
}) {
  const target = resolveDesktopAppControlAddress({
    stateDir: NodePath.join(input.baseDir, input.stateSubdirectory ?? "userdata"),
    platform: input.platform,
    tempDir: NodeOS.tmpdir(),
    userId: input.userId,
    joinPath: NodePath.join,
  });
  if (target.directory !== null) {
    await NodeFSP.mkdir(target.directory, { recursive: true, mode: 0o700 });
    await NodeFSP.unlink(target.address).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
  }

  const received: DesktopAppActivationRequest[] = [];
  const server = NodeNet.createServer((socket) => {
    socket.setEncoding("utf8");
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline === -1) return;
      const request = JSON.parse(buffer.slice(0, newline)) as DesktopAppActivationRequest;
      received.push(request);
      const response = input.reply
        ? input.reply(request)
        : {
            version: 1,
            requestId: request.requestId,
            ok: true,
            projectId: "project-1",
            threadId: `thread-${received.length}`,
          };
      socket.end(`${JSON.stringify(response)}\n`);
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(target.address, resolve);
  });

  return {
    directory: target.directory,
    received,
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      if (target.directory !== null) {
        await NodeFSP.unlink(target.address).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== "ENOENT") throw error;
        });
      }
    },
  };
}

const fakeDesktop = Effect.fn(function* (
  input: Omit<Parameters<typeof startFakeDesktop>[0], "platform" | "userId">,
) {
  const platform = yield* HostProcess.Platform;
  const userId = yield* HostProcess.UserId;
  return yield* Effect.acquireRelease(
    Effect.promise(() => startFakeDesktop({ ...input, platform, userId })),
    (server) => Effect.promise(() => server.close()),
  );
});

const withTempDirectory = <A, E, R>(
  prefix: string,
  use: (root: string) => Effect.Effect<A, E, R>,
  tempDir = NodeOS.tmpdir(),
) =>
  Effect.acquireUseRelease(
    Effect.promise(() => NodeFSP.mkdtemp(NodePath.join(tempDir, prefix))),
    use,
    (root) => Effect.promise(() => NodeFSP.rm(root, { recursive: true, force: true })),
  );

describe("t3 server command safety", () => {
  it.effect("rejects unknown command words without creating a home or project", () =>
    withTempDirectory("t3-cli-unknown-", (root) =>
      Effect.gen(function* () {
        const baseDir = NodePath.join(root, "home");
        for (const word of [
          "account",
          "login",
          "clients",
          "conenct",
          "package.json",
          "C:new-project",
        ]) {
          const error = yield* runCli([word, "--base-dir", baseDir]).pipe(
            Effect.provideService(HostProcess.Platform, "linux"),
            Effect.flip,
          );
          expect(String(error)).toContain(`Unknown command "${word}"`);
          expect(yield* pathExists(word)).toBe(word === "package.json");
          expect(yield* pathExists(baseDir)).toBe(false);
        }
      }),
    ),
  );

  it.effect.skipIf(HostProcess.Platform.defaultValue() === "win32")(
    "prints runnable recovery commands for script, packaged, and standalone installations",
    () =>
      withTempDirectory("Scient CLI's recovery-", (root) =>
        Effect.gen(function* () {
          const runtime = NodePath.join(root, "private Node's location", "node");
          const entry = NodePath.join(root, "entry's cache", "bin.mjs");
          const launcher = NodePath.join(root, "Scient's launcher");
          const baseDir = NodePath.join(root, "profile");
          yield* Effect.promise(async () => {
            await NodeFSP.mkdir(NodePath.dirname(runtime), { recursive: true });
            await NodeFSP.mkdir(NodePath.dirname(entry), { recursive: true });
            await NodeFSP.symlink(process.execPath, runtime);
            await NodeFSP.writeFile(entry, "console.log(JSON.stringify(process.argv.slice(2)));\n");
            await NodeFSP.writeFile(launcher, '#!/bin/sh\nprintf \'["%s"]\\n\' "$1"\n', {
              mode: 0o755,
            });
          });
          const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
          for (const installation of ["script", "packaged", "standalone"] as const) {
            const error = yield* runCli(["conenct", "--base-dir", baseDir]).pipe(
              Effect.provideService(HostProcess.WorkingDirectory, root),
              Effect.provideService(HostProcess.Platform, "linux"),
              Effect.provideService(
                HostProcess.ExecutablePath,
                installation === "standalone" ? launcher : runtime,
              ),
              Effect.provideService(HostProcess.Arguments, [runtime, entry]),
              Effect.provideService(HostProcess.IsExecutable, installation === "standalone"),
              Effect.provideService(
                HostProcess.Environment,
                installation === "packaged" ? { T3CODE_CLI_PATH: launcher } : {},
              ),
              Effect.flip,
            );
            const advice =
              /Use "(.*)" for commands or an explicit path such as "(.*)" for a new directory\./.exec(
                String(error),
              );
            expect(advice).not.toBeNull();
            for (const [command, args] of [
              [advice![1]!, ["--help"]],
              [advice![2]!, ["./my-project"]],
            ] as const) {
              const output = yield* spawner.string(
                ChildProcess.make("/bin/sh", ["-c", command], {
                  cwd: root,
                  env: { PATH: "", HOME: root },
                  extendEnv: false,
                  stdin: "ignore",
                }),
              );
              expect(JSON.parse(output)).toEqual(args);
            }
            expect(yield* pathExists(baseDir)).toBe(false);
          }
        }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
      ),
  );

  it.effect("shows help without creating state", () =>
    withTempDirectory("t3-cli-help-", (root) =>
      Effect.gen(function* () {
        const baseDir = NodePath.join(root, "home");
        const help = yield* runCli(["help"], { SCIENT_NEXT_HOME: baseDir }).pipe(Effect.flip);
        expect(help).toMatchObject({ _tag: "ShowHelp", commandPath: ["scient"], errors: [] });
        expect(yield* pathExists(baseDir)).toBe(false);
      }),
    ),
  );

  it.effect("refuses manual startup over a live server before creating directories", () =>
    withTempDirectory("t3-cli-running-", (root) =>
      Effect.gen(function* () {
        const baseDir = NodePath.join(root, "home");
        const stateDir = NodePath.join(baseDir, "userdata");
        const statePath = NodePath.join(stateDir, "server-runtime.json");
        const child = yield* liveProcess;
        assert(child.pid !== undefined);
        const record = yield* encodeRuntimeState({
          version: 1,
          pid: child.pid,
          port: 3773,
          origin: "http://127.0.0.1:3773",
          startedAt: "2026-10-01T00:00:00.000Z",
          serviceManaged: true,
        });
        yield* Effect.promise(() => NodeFSP.mkdir(stateDir, { recursive: true }));
        yield* Effect.promise(() => NodeFSP.writeFile(statePath, record));
        const newDirectory = NodePath.join(root, "new-project");
        const platform = yield* HostProcess.Platform;
        for (const args of [
          [],
          ["start"],
          ["."],
          ["node_modules"],
          ["C:new-project"],
          [newDirectory],
          ["start", newDirectory],
        ]) {
          const error = yield* runCli(args, { SCIENT_NEXT_HOME: baseDir }).pipe(
            Effect.provideService(
              HostProcess.Platform,
              args[0] === "C:new-project" ? "win32" : platform,
            ),
            Effect.flip,
          );
          expect(String(error)).toContain(
            `A Scient server is already running for ${baseDir} (pid ${child.pid}, http://127.0.0.1:3773). Connect to that server, stop it before starting another, or use a different --base-dir.`,
          );
          expect(yield* Effect.promise(() => NodeFSP.readFile(statePath, "utf8"))).toBe(record);
          expect(yield* pathExists(newDirectory)).toBe(false);
          expect(yield* Effect.promise(() => NodeFSP.readdir(stateDir))).toEqual([
            "server-runtime.json",
          ]);
        }
      }),
    ),
  );
});

describe("t3 app", () => {
  it.effect("rejects SSH before it tries to reach a desktop app", () =>
    withTempDirectory("t3-app-ssh-test-", (root) =>
      Effect.gen(function* () {
        const baseDir = NodePath.join(root, "missing-t3-home");
        const error = yield* runCli(["app", "--base-dir", baseDir], {
          SSH_CONNECTION: "client server",
        }).pipe(Effect.flip);

        expect(error).toMatchObject({
          _tag: "DesktopAppSshUnsupportedError",
          message:
            "`scient app` only controls the Scient desktop app on the same machine. It cannot run over SSH.",
        });
        expect(yield* pathExists(baseDir)).toBe(false);
      }),
    ),
  );

  it.effect("rejects unsupported platforms without creating state", () =>
    withTempDirectory("t3-app-platform-test-", (root) =>
      Effect.gen(function* () {
        const baseDir = NodePath.join(root, "missing-t3-home");
        const error = yield* runCli(["app", "--base-dir", baseDir]).pipe(
          Effect.provideService(HostProcess.Platform, "freebsd"),
          Effect.flip,
        );

        expect(error).toMatchObject({
          _tag: "DesktopAppPlatformUnsupportedError",
          platform: "freebsd",
          message: "`scient app` is not supported on freebsd.",
        });
        expect(yield* pathExists(baseDir)).toBe(false);
      }),
    ),
  );

  it.effect("does not create state when only a server or no desktop app is running", () =>
    withTempDirectory("t3-app-missing-test-", (root) =>
      Effect.gen(function* () {
        const baseDir = NodePath.join(root, "missing-t3-home");
        const error = yield* runCli(["app", "--base-dir", baseDir]).pipe(Effect.flip);

        expect(error).toMatchObject({
          _tag: "DesktopAppUnreachableError",
          candidateAddresses: [expect.any(String)],
          workspaceRoot: yield* HostProcess.WorkingDirectory,
          message: expect.stringContaining("Could not reach the Scient desktop app."),
          cause: { code: "ENOENT" },
        });
        expect(yield* pathExists(baseDir)).toBe(false);
      }),
    ),
  );

  it.live.each(["permissions", "owner", "symlink", "missing owner"] as const)(
    "rejects unsafe %s on the socket directory before sending",
    (unsafe) =>
      Effect.gen(function* () {
        const platform = yield* HostProcess.Platform;
        if (platform === "win32") return;
        yield* withTempDirectory(
          "t3-app-unsafe-",
          (root) =>
            Effect.gen(function* () {
              const previousTmpdir = process.env.TMPDIR;
              yield* Effect.acquireRelease(
                Effect.sync(() => {
                  process.env.TMPDIR = root;
                }),
                () =>
                  Effect.sync(() => {
                    if (previousTmpdir === undefined) delete process.env.TMPDIR;
                    else process.env.TMPDIR = previousTmpdir;
                  }),
              );
              const baseDir = NodePath.join(root, ".t3");
              const userId = yield* HostProcess.UserId;
              assert(userId !== undefined);
              const expectedUserId =
                unsafe === "missing owner" ? undefined : unsafe === "owner" ? userId + 1 : userId;
              const desktop = yield* fakeDesktop({ baseDir }).pipe(
                Effect.provideService(HostProcess.UserId, expectedUserId),
              );
              const directory = desktop.directory;
              assert(directory !== null);
              if (unsafe === "permissions") {
                yield* Effect.promise(() => NodeFSP.chmod(directory, 0o755));
              } else if (unsafe === "symlink") {
                const moved = NodePath.join(root, "moved");
                yield* Effect.promise(() => NodeFSP.rename(directory, moved));
                yield* Effect.promise(() => NodeFSP.symlink(moved, directory));
              }
              const result = yield* runCli(["app", "--base-dir", baseDir]).pipe(
                Effect.provideService(HostProcess.UserId, expectedUserId),
                Effect.result,
              );
              expect(desktop.received).toEqual([]);
              expect(result).toMatchObject({
                _tag: "Failure",
                failure: { _tag: "DesktopAppUnreachableError" },
              });
            }).pipe(Effect.scoped),
          "/tmp",
        );
      }),
  );

  it.effect("uses SCIENT_NEXT_HOME or --base-dir and sends the default or explicit path", () =>
    withTempDirectory("t3-app-command-test-", (root) =>
      Effect.gen(function* () {
        const baseDir = NodePath.join(root, "t3-home");
        const explicitPath = NodePath.join(root, "project");
        const platform = yield* HostProcess.Platform;
        const workingDirectory = yield* HostProcess.WorkingDirectory;
        const desktop = yield* fakeDesktop({ baseDir });

        yield* runCli(["app"], { SCIENT_NEXT_HOME: baseDir });
        yield* runCli(["app", explicitPath, "--base-dir", baseDir]);

        expect(desktop.received.map((request) => request.workspaceRoot)).toEqual([
          workingDirectory,
          explicitPath,
        ]);
        expect(desktop.received.every((request) => request.platform === platform)).toBe(true);
      }).pipe(Effect.scoped),
    ),
  );

  it.effect("prefers the installed desktop app when a dev desktop is also running", () =>
    withTempDirectory("t3-app-preferred-test-", (root) =>
      Effect.gen(function* () {
        const baseDir = NodePath.join(root, SCIENT_DESKTOP_IDENTITY.baseDirName);
        const desktop = yield* fakeDesktop({ baseDir });
        const development = yield* fakeDesktop({
          baseDir,
          stateSubdirectory: SCIENT_DESKTOP_IDENTITY.developmentUserDataDirName,
        });

        yield* runCli(["app"]);

        expect(desktop.received).toHaveLength(1);
        expect(development.received).toHaveLength(0);
      }).pipe(Effect.provideService(HostProcess.HomeDirectory, root), Effect.scoped),
    ),
  );

  it.effect("finds the dev desktop when the default desktop socket is absent", () =>
    withTempDirectory("t3-app-dev-test-", (root) =>
      Effect.gen(function* () {
        const baseDir = NodePath.join(root, SCIENT_DESKTOP_IDENTITY.baseDirName);
        const development = yield* fakeDesktop({
          baseDir,
          stateSubdirectory: SCIENT_DESKTOP_IDENTITY.developmentUserDataDirName,
        });

        yield* runCli(["app"]);
        yield* runCli(["app"], { SCIENT_NEXT_HOME: "   " });

        expect(development.received).toHaveLength(2);
        expect(yield* pathExists(baseDir)).toBe(false);
      }).pipe(Effect.provideService(HostProcess.HomeDirectory, root), Effect.scoped),
    ),
  );

  it.effect("ignores ambient T3 state inside the Scient safety envelope", () =>
    withTempDirectory("t3-app-safety-envelope-test-", (root) =>
      Effect.gen(function* () {
        const scientBaseDir = NodePath.join(root, SCIENT_DESKTOP_IDENTITY.baseDirName);
        const legacyBaseDir = NodePath.join(root, ".t3");
        const development = yield* fakeDesktop({
          baseDir: scientBaseDir,
          stateSubdirectory: SCIENT_DESKTOP_IDENTITY.developmentUserDataDirName,
        });
        const legacy = yield* fakeDesktop({ baseDir: legacyBaseDir });

        yield* runCli(["app"], { T3CODE_HOME: legacyBaseDir });

        expect(development.received).toHaveLength(1);
        expect(legacy.received).toHaveLength(0);
      }).pipe(Effect.provideService(HostProcess.HomeDirectory, root), Effect.scoped),
    ),
  );

  it.effect("never searches a dev state directory for an explicit Scient home", () =>
    withTempDirectory("t3-app-explicit-test-", (root) =>
      Effect.gen(function* () {
        const baseDir = NodePath.join(root, SCIENT_DESKTOP_IDENTITY.baseDirName);
        const development = yield* fakeDesktop({
          baseDir,
          stateSubdirectory: SCIENT_DESKTOP_IDENTITY.developmentUserDataDirName,
        });

        const flagError = yield* runCli(["app", "--base-dir", baseDir]).pipe(Effect.flip);
        const envError = yield* runCli(["app"], { SCIENT_NEXT_HOME: baseDir }).pipe(Effect.flip);

        expect(flagError).toMatchObject({ _tag: "DesktopAppUnreachableError" });
        expect(envError).toMatchObject({ _tag: "DesktopAppUnreachableError" });
        expect(development.received).toHaveLength(0);
      }).pipe(Effect.provideService(HostProcess.HomeDirectory, root), Effect.scoped),
    ),
  );

  it.effect.each(["failure", "invalid"] as const)(
    "never falls back after the default desktop sends a %s response",
    (responseKind) =>
      withTempDirectory("t3-app-response-test-", (root) =>
        Effect.gen(function* () {
          const baseDir = NodePath.join(root, SCIENT_DESKTOP_IDENTITY.baseDirName);
          const desktop = yield* fakeDesktop({
            baseDir,
            reply: (request) =>
              responseKind === "failure"
                ? {
                    version: 1,
                    requestId: request.requestId,
                    ok: false,
                    code: "project-create-failed",
                    message: "The project path is not available.",
                  }
                : { invalid: true },
          });
          const development = yield* fakeDesktop({
            baseDir,
            stateSubdirectory: SCIENT_DESKTOP_IDENTITY.developmentUserDataDirName,
          });

          const error = yield* runCli(["app"]).pipe(Effect.flip);

          expect(desktop.received).toHaveLength(1);
          expect(development.received).toHaveLength(0);
          if (responseKind === "failure") {
            expect(error).toMatchObject({
              _tag: "DesktopAppRequestFailedError",
              code: "project-create-failed",
              requestId: desktop.received[0]?.requestId,
              workspaceRoot: yield* HostProcess.WorkingDirectory,
              message: expect.stringContaining("project-create-failed"),
              cause: {
                ok: false,
                code: "project-create-failed",
                message: "The project path is not available.",
              },
            });
          } else {
            expect(error).toMatchObject({
              _tag: "DesktopAppUnreachableError",
              cause: { message: "The desktop app response is invalid." },
            });
          }
        }).pipe(Effect.provideService(HostProcess.HomeDirectory, root), Effect.scoped),
      ),
  );
});
