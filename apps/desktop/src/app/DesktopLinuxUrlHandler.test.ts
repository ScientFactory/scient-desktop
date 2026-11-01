import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as DesktopEnvironment from "./DesktopEnvironment.ts";
import * as DesktopAssets from "./DesktopAssets.ts";
import * as DesktopLinuxUrlHandler from "./DesktopLinuxUrlHandler.ts";

interface RecordedRegistration {
  readonly directories: string[];
  readonly files: Array<{ readonly path: string; readonly content: string }>;
  readonly commands: Array<{ readonly command: string; readonly args: ReadonlyArray<string> }>;
  readonly copies: Array<{ readonly source: string; readonly destination: string }>;
}

const makeEnvironment = (path: Path.Path, overrides: Record<string, unknown> = {}) =>
  DesktopEnvironment.DesktopEnvironment.of({
    platform: "linux",
    isPackaged: true,
    isDevelopment: false,
    // SCIENT-FORK:START scient-conversation-files
    displayName: "Scient (Alpha)",
    linuxDesktopEntryName: "scient.desktop",
    linuxWmClass: "scient",
    linuxApplicationsDir: "/home/alice/.local/share/applications",
    desktopLauncherPath: Option.none(),
    appImagePath: Option.some("/home/alice/Applications/T3-Code.AppImage"),
    path,
    ...overrides,
  } as unknown as DesktopEnvironment.DesktopEnvironment["Service"]);

const mockProcess = (exitCode: number, stdout = "", stalled = false) =>
  ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(1),
    exitCode: stalled ? Effect.never : Effect.succeed(ChildProcessSpawner.ExitCode(exitCode)),
    isRunning: Effect.succeed(false),
    kill: () => Effect.void,
    unref: Effect.succeed(Effect.void),
    stdin: Sink.drain,
    stdout: stdout ? Stream.make(new TextEncoder().encode(stdout)) : Stream.empty,
    // SCIENT-FORK:END scient-conversation-files
    stderr: Stream.empty,
    all: Stream.empty,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
  });

const layerHandler = (
  recorded: RecordedRegistration,
  input: {
    readonly environment?: Record<string, unknown>;
    readonly processSpawner?: ChildProcessSpawner.ChildProcessSpawner["Service"];
    readonly updateDesktopDatabaseExitCode?: number;
    readonly updateDesktopDatabaseStalled?: boolean;
    readonly updateDesktopDatabaseStarted?: Deferred.Deferred<void>;
    readonly xdgMimeExitCode?: number;
    // SCIENT-FORK:START scient-conversation-files
    readonly fileDefault?: string;
    // SCIENT-FORK:END scient-conversation-files
    readonly writeError?: PlatformError.PlatformError;
    readonly existingEntry?: string;
    readonly iconSource?: string;
    readonly iconCopyError?: PlatformError.PlatformError;
  } = {},
) =>
  DesktopLinuxUrlHandler.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.effect(
          DesktopEnvironment.DesktopEnvironment,
          Path.Path.pipe(
            Effect.map((path) => makeEnvironment(path, input.environment)),
            Effect.provide(Path.layer),
          ),
        ),
        Layer.succeed(DesktopAssets.DesktopAssets, {
          iconPaths: Effect.succeed({
            png: Option.fromUndefinedOr(input.iconSource),
            ico: Option.none(),
            icns: Option.none(),
          }),
          resolveResourcePath: () => Effect.succeedNone,
        }),
        FileSystem.layerNoop({
          copyFile: (source, destination) =>
            input.iconCopyError
              ? Effect.fail(input.iconCopyError)
              : Effect.sync(() => {
                  recorded.copies.push({ source, destination });
                }),
          readFileString: () => Effect.succeed(input.existingEntry ?? ""),
          makeDirectory: (path) =>
            Effect.sync(() => {
              recorded.directories.push(path);
            }),
          writeFileString: (path, content) =>
            input.writeError
              ? Effect.fail(input.writeError)
              : Effect.sync(() => {
                  recorded.files.push({ path, content });
                }),
        }),
        Layer.succeed(
          ChildProcessSpawner.ChildProcessSpawner,
          ChildProcessSpawner.make((command) => {
            if (input.processSpawner) return input.processSpawner.spawn(command);
            const childProcess = command as unknown as {
              readonly command: string;
              readonly args: ReadonlyArray<string>;
            };
            if (childProcess.command === "update-desktop-database") {
              assert.isTrue(
                recorded.files.length > 0 || input.existingEntry !== undefined,
                "the desktop entry must exist before refreshing the MIME cache",
              );
            }
            recorded.commands.push({
              command: childProcess.command,
              args: childProcess.args,
            });
            const exitCode =
              childProcess.command === "update-desktop-database"
                ? (input.updateDesktopDatabaseExitCode ?? 0)
                : (input.xdgMimeExitCode ?? 0);
            const handle = mockProcess(
              exitCode,
              // SCIENT-FORK:START scient-conversation-files
              childProcess.args[0] === "query" ? (input.fileDefault ?? "") : "",
              // SCIENT-FORK:END scient-conversation-files
              childProcess.command === "update-desktop-database" &&
                input.updateDesktopDatabaseStalled === true,
            );
            return childProcess.command === "update-desktop-database" &&
              input.updateDesktopDatabaseStarted
              ? Deferred.succeed(input.updateDesktopDatabaseStarted, undefined).pipe(
                  Effect.as(handle),
                )
              : Effect.succeed(handle);
          }),
        ),
      ),
    ),
  );

const runRegister = (
  recorded: RecordedRegistration,
  input: Parameters<typeof layerHandler>[1] = {},
) =>
  Effect.gen(function* () {
    const handler = yield* DesktopLinuxUrlHandler.DesktopLinuxUrlHandler;
    yield* handler.register;
  }).pipe(Effect.provide(layerHandler(recorded, input)));

const emptyRecording = (): RecordedRegistration => ({
  directories: [],
  files: [],
  commands: [],
  copies: [],
});

describe("DesktopLinuxUrlHandler", () => {
  it("renders a scheme-handler desktop entry with freedesktop Exec quoting", () => {
    const entry = DesktopLinuxUrlHandler.renderUrlHandlerDesktopEntry({
      // SCIENT-FORK:START scient-conversation-files
      displayName: "Scient",
      execTarget: '/home/al ice/Apps/T3 "100%" $HOME\\x.AppImage',
      scheme: "scient-next",
      iconPath: "/home/al ice/icons/T3\\x.png",
    });

    assert.include(entry, "[Desktop Entry]");
    assert.include(entry, "Name=Scient");
    assert.include(
      entry,
      'Exec="/home/al ice/Apps/T3 \\\\"100%%\\\\" \\\\$HOME\\\\\\\\x.AppImage" %U',
    );
    assert.include(entry, "NoDisplay=true");
    assert.notInclude(entry, "StartupWMClass=");
    assert.include(
      entry,
      "MimeType=x-scheme-handler/scient-next;application/vnd.scient.conversation+zip;",
    );
    assert.include(entry, "Icon=/home/al ice/icons/T3\\\\x.png");
  });

  // regression: 29d46101f3 Linux URL handler quotes the Exec path only when it must (#16670)
  it.each([
    {
      execTarget: "/opt/t3%20code/t3code.AppImage",
      execLine: "Exec=/opt/t3%%20code/t3code.AppImage %U",
    },
  ])("renders the handler Exec line for $execTarget", ({ execTarget, execLine }) => {
    const entry = DesktopLinuxUrlHandler.renderUrlHandlerDesktopEntry({
      displayName: "T3 Code",
      execTarget,
      scheme: "t3code",
    });

    assert.include(entry.split("\n"), execLine);
  });

  // regression: 69dfb7f09a fix(desktop): claim the t3code:// scheme default on Linux at startup (#5054)
  it("carries structured context on registration errors", () => {
    const writeError = new DesktopLinuxUrlHandler.DesktopLinuxUrlHandlerRegistrationError({
      step: "write-desktop-entry",
      scheme: "scient-next",
      desktopEntryPath: "/home/alice/.local/share/applications/scient.desktop",
      cause: new Error("boom"),
    });
    assert.equal(
      writeError.message,
      "Failed to register the scient-next:// URL handler (step: write-desktop-entry).",
    );
    assert.equal(
      writeError.desktopEntryPath,
      "/home/alice/.local/share/applications/scient.desktop",
    );

    const exitError = new DesktopLinuxUrlHandler.DesktopLinuxUrlHandlerRegistrationError({
      step: "set-default-handler",
      scheme: "scient-next",
      exitCode: 4,
    });
    assert.equal(
      exitError.message,
      "Failed to register the scient-next:// URL handler (step: set-default-handler, xdg-mime exit code 4).",
    );
  });
  // SCIENT-FORK:END scient-conversation-files

  it.effect(
    "writes the handler entry, refreshes the MIME cache, and claims the scheme default",
    () => {
      const recorded = emptyRecording();

      return Effect.gen(function* () {
        yield* runRegister(recorded);

        // SCIENT-FORK:START scient-conversation-files
        assert.deepEqual(recorded.directories, [
          "/home/alice/.local/share/applications",
          "/home/alice/.local/share/applications",
        ]);
        assert.equal(recorded.files.length, 2);
        assert.equal(
          recorded.files[0]?.path,
          "/home/alice/.local/share/applications/scient.desktop",
        );
        assert.include(
          recorded.files[0]?.content,
          "Exec=/home/alice/Applications/T3-Code.AppImage %U",
        );
        assert.include(
          recorded.files[0]?.content,
          "Icon=/home/alice/.local/share/icons/scient.desktop.png",
        );
        assert.include(
          recorded.files[0]?.content,
          "MimeType=x-scheme-handler/scient;application/vnd.scient.conversation+zip;",
        );
        assert.include(recorded.files[1]?.content, '<glob pattern="*.scic" weight="80"/>');
        assert.deepEqual(recorded.commands, [
          {
            command: "update-desktop-database",
            args: ["/home/alice/.local/share/applications"],
          },
          {
            command: "xdg-mime",
            args: ["default", "scient.desktop", "x-scheme-handler/scient"],
          },
          {
            command: "xdg-mime",
            args: [
              "install",
              "--mode",
              "user",
              "/home/alice/.local/share/applications/scient-conversation.xml",
            ],
          },
          {
            command: "xdg-mime",
            args: ["query", "default", "application/vnd.scient.conversation+zip"],
          },
          {
            command: "xdg-mime",
            args: ["default", "scient.desktop", "application/vnd.scient.conversation+zip"],
            // SCIENT-FORK:END scient-conversation-files
          },
        ]);
      });
    },
  );

  it.effect("falls back to the process executable outside an AppImage", () => {
    const recorded = emptyRecording();

    return Effect.gen(function* () {
      yield* runRegister(recorded, { environment: { appImagePath: Option.none() } });

      assert.include(
        recorded.files[0]?.content,
        DesktopLinuxUrlHandler.renderUrlHandlerDesktopEntry({
          // SCIENT-FORK:START scient-conversation-files
          displayName: "Scient (Alpha)",
          execTarget: process.execPath,
          scheme: "scient",
          iconPath: "/home/alice/.local/share/icons/scient.desktop.png",
          // SCIENT-FORK:END scient-conversation-files
        }),
      );
    });
  });

  it.effect("launches a distribution package through its configured launcher", () => {
    const recorded = emptyRecording();

    return Effect.gen(function* () {
      yield* runRegister(recorded, {
        environment: { desktopLauncherPath: Option.some("/opt/T3 Code/t3code") },
      });

      assert.include(recorded.files[0]?.content, 'Exec="/opt/T3 Code/t3code" %U');
    });
  });

  it.effect("does not rewrite the pre-ready entry while the portal can be reading it", () => {
    const recorded = emptyRecording();

    return Effect.gen(function* () {
      yield* runRegister(recorded, {
        existingEntry: DesktopLinuxUrlHandler.renderUrlHandlerDesktopEntry({
          // SCIENT-FORK:START scient-conversation-files
          displayName: "Scient (Alpha)",
          execTarget: "/home/alice/Applications/T3-Code.AppImage",
          scheme: "scient",
          iconPath: "/home/alice/.local/share/icons/scient.desktop.png",
        }),
      });

      assert.isFalse(recorded.files.some(({ path }) => path.endsWith("scient.desktop")));
      assert.equal(recorded.files.length, 1);
      assert.equal(recorded.directories.length, 1);
      assert.include(recorded.files[0]?.content, '<glob pattern="*.scic" weight="80"/>');
      assert.deepEqual(recorded.commands, [
        {
          command: "update-desktop-database",
          args: ["/home/alice/.local/share/applications"],
        },
        {
          command: "xdg-mime",
          args: ["default", "scient.desktop", "x-scheme-handler/scient"],
        },
        {
          command: "xdg-mime",
          args: [
            "install",
            "--mode",
            "user",
            "/home/alice/.local/share/applications/scient-conversation.xml",
          ],
        },
        {
          command: "xdg-mime",
          args: ["query", "default", "application/vnd.scient.conversation+zip"],
        },
        {
          command: "xdg-mime",
          args: ["default", "scient.desktop", "application/vnd.scient.conversation+zip"],
        },
      ]);
    });
  });

  it.effect("installs a persistent icon even when the desktop entry is already current", () => {
    const recorded = emptyRecording();
    const iconPath = "/home/alice/.local/share/icons/scient.desktop.png";
    return Effect.gen(function* () {
      yield* runRegister(recorded, {
        iconSource: "/tmp/.mount_T3/resources/icon.png",
        existingEntry: DesktopLinuxUrlHandler.renderUrlHandlerDesktopEntry({
          displayName: "Scient (Alpha)",
          execTarget: "/home/alice/Applications/T3-Code.AppImage",
          scheme: "scient",
          iconPath,
        }),
      });
      assert.equal(recorded.files.length, 1);
      // SCIENT-FORK:END scient-conversation-files
      assert.deepEqual(recorded.copies, [
        { source: "/tmp/.mount_T3/resources/icon.png", destination: iconPath },
      ]);
      assert.equal(recorded.commands.at(-1)?.command, "xdg-mime");
    });
  });

  it.effect("still registers the handler when copying its icon fails", () => {
    const recorded = emptyRecording();
    return Effect.gen(function* () {
      yield* runRegister(recorded, {
        iconSource: "/tmp/.mount_T3/resources/icon.png",
        iconCopyError: PlatformError.systemError({
          _tag: "PermissionDenied",
          module: "FileSystem",
          method: "copyFile",
          description: "read-only icon directory",
        }),
      });
      // SCIENT-FORK:START scient-conversation-files
      assert.equal(recorded.files.length, 2);
      assert.deepEqual(
        recorded.commands.map(({ command }) => command),
        ["update-desktop-database", "xdg-mime", "xdg-mime", "xdg-mime", "xdg-mime"],
        // SCIENT-FORK:END scient-conversation-files
      );
    });
  });

  it.effect("writes the portal identity without claiming the URL scheme in development", () => {
    const nonLinux = emptyRecording();
    const unpackaged = emptyRecording();

    return Effect.gen(function* () {
      yield* runRegister(nonLinux, { environment: { platform: "darwin" } });
      yield* runRegister(unpackaged, {
        environment: {
          isPackaged: false,
          // SCIENT-FORK:START scient-conversation-files
          linuxDesktopEntryName: "scient-next-dev.desktop",
        },
      });

      assert.deepEqual(nonLinux.files, []);
      assert.equal(
        unpackaged.files[0]?.path,
        "/home/alice/.local/share/applications/scient-next-dev.desktop",
      );
      assert.deepEqual(unpackaged.commands, []);
    });
  });

  it.effect("preserves an existing .scic default", () => {
    const recorded = emptyRecording();
    return Effect.gen(function* () {
      yield* runRegister(recorded, { fileDefault: "another-app.desktop\n" });
      assert.isFalse(
        recorded.commands.some(
          ({ args }) =>
            args[0] === "default" && args[2] === "application/vnd.scient.conversation+zip",
        ),
      );
    });
  });
  // SCIENT-FORK:END scient-conversation-files

  it.effect("never fails startup when registration cannot complete", () => {
    const desktopDatabaseFailed = emptyRecording();
    const xdgMimeFailed = emptyRecording();
    const writeFailed = emptyRecording();

    return Effect.gen(function* () {
      yield* runRegister(desktopDatabaseFailed, { updateDesktopDatabaseExitCode: 1 });
      yield* runRegister(xdgMimeFailed, { xdgMimeExitCode: 1 });
      yield* runRegister(writeFailed, {
        writeError: PlatformError.systemError({
          _tag: "PermissionDenied",
          module: "FileSystem",
          method: "writeFileString",
          description: "read-only filesystem",
          // SCIENT-FORK:START scient-conversation-files
          pathOrDescriptor: "/home/alice/.local/share/applications/scient.desktop",
        }),
      });

      assert.deepEqual(
        desktopDatabaseFailed.commands.map(({ command }) => command),
        ["update-desktop-database", "xdg-mime", "xdg-mime", "xdg-mime", "xdg-mime"],
        // SCIENT-FORK:END scient-conversation-files
      );
      assert.equal(xdgMimeFailed.files.length, 1);
      assert.deepEqual(writeFailed.commands, []);
    });
  });

  it.effect.skipIf(HostProcess.Platform.defaultValue() !== "linux")(
    "continues registration after a timed-out cache helper ignores SIGTERM",
    () =>
      Effect.gen(function* () {
        const realSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        const nodeExecutable = yield* HostProcess.ExecutablePath;
        const recorded = emptyRecording();
        const spawned = yield* Deferred.make<ChildProcessSpawner.ChildProcessHandle>();
        const ready = yield* Deferred.make<void>();
        const processSpawner = ChildProcessSpawner.make((command) =>
          Effect.gen(function* () {
            if (!ChildProcess.isStandardCommand(command)) {
              return yield* Effect.die("expected a single registration command");
            }
            recorded.commands.push({ command: command.command, args: command.args });
            if (command.command !== "update-desktop-database") return mockProcess(0);
            const child = yield* realSpawner.spawn(
              ChildProcess.make(
                nodeExecutable,
                [
                  "-e",
                  // The watchdog makes the unfixed case exit with a distinguishable code.
                  "process.on('SIGTERM', () => setTimeout(() => process.exit(99), 5000));" +
                    "process.stdout.write('ready\\n'); setInterval(() => {}, 2147483647);",
                ],
                { ...command.options, stdout: "pipe" },
              ),
            );
            yield* Deferred.succeed(spawned, child);
            yield* Stream.runHead(child.stdout);
            yield* Deferred.succeed(ready, undefined);
            return child;
          }),
        );
        const registration = yield* runRegister(recorded, { processSpawner }).pipe(
          Effect.forkScoped,
        );
        const child = yield* Deferred.await(spawned);
        yield* Effect.addFinalizer(() =>
          child.isRunning.pipe(
            Effect.flatMap((running) =>
              running ? child.kill({ killSignal: "SIGKILL" }) : Effect.void,
            ),
            Effect.ignore,
          ),
        );
        yield* Deferred.await(ready);
        yield* TestClock.adjust("5 seconds");
        yield* Fiber.join(registration);

        const exit = yield* Effect.exit(child.exitCode);
        if (Exit.isFailure(exit)) {
          assert.include(Cause.pretty(exit.cause), "SIGKILL");
        } else {
          assert.fail(`cache helper exited with ${exit.value} instead of being force-killed`);
        }
        assert.deepEqual(
          recorded.commands.map(({ command }) => command),
          // SCIENT-FORK: conversation files add three xdg-mime steps after the URL scheme.
          ["update-desktop-database", "xdg-mime", "xdg-mime", "xdg-mime", "xdg-mime"],
        );
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});

interface ThemeIconRun {
  readonly root: string;
  readonly commands: Array<{ readonly command: string; readonly args: ReadonlyArray<string> }>;
  readonly iconCacheOptions?: Array<Record<string, unknown>>;
  readonly sourceMissing?: boolean;
  readonly iconCacheExitCode?: number;
  readonly iconCacheSpawnFails?: boolean;
  readonly iconCacheStalled?: boolean;
  readonly iconCacheStarted?: Deferred.Deferred<void>;
  // Stands in for gtk-update-icon-cache rewriting the cache on success.
  readonly onIconCacheRefresh?: Effect.Effect<void>;
}

const registerWithRealFileSystem = (run: ThemeIconRun) =>
  Effect.gen(function* () {
    const handler = yield* DesktopLinuxUrlHandler.DesktopLinuxUrlHandler;
    yield* handler.register;
  }).pipe(
    Effect.provide(
      DesktopLinuxUrlHandler.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.effect(
              DesktopEnvironment.DesktopEnvironment,
              Path.Path.pipe(
                Effect.map((path) =>
                  makeEnvironment(path, {
                    linuxApplicationsDir: path.join(run.root, "applications"),
                    // SCIENT-FORK:START scient-conversation-files
                    // SCIENT-FORK: exercise case-sensitive icon names with the Scient identity.
                    linuxDesktopEntryName: "Scient.desktop",
                    // SCIENT-FORK:END scient-conversation-files
                  }),
                ),
              ),
            ),
            Layer.effect(
              DesktopAssets.DesktopAssets,
              Path.Path.pipe(
                Effect.map((path) => ({
                  iconPaths: Effect.succeed({
                    png: Option.none(),
                    ico: Option.none(),
                    icns: Option.none(),
                  }),
                  resolveResourcePath: (fileName: string) =>
                    Effect.succeed(
                      fileName === "icons/256x256.png"
                        ? Option.some(
                            path.join(
                              run.root,
                              run.sourceMissing ? "missing" : "resources",
                              fileName,
                            ),
                          )
                        : Option.none(),
                    ),
                })),
              ),
            ),
            Layer.succeed(
              ChildProcessSpawner.ChildProcessSpawner,
              ChildProcessSpawner.make((command) => {
                const childProcess = command as unknown as {
                  readonly command: string;
                  readonly args: ReadonlyArray<string>;
                };
                run.commands.push({ command: childProcess.command, args: childProcess.args });
                if (childProcess.command !== "gtk-update-icon-cache") {
                  return Effect.succeed(mockProcess(0));
                }
                run.iconCacheOptions?.push(
                  (command as unknown as { readonly options: Record<string, unknown> }).options,
                );
                if (run.iconCacheSpawnFails) {
                  return Effect.fail(
                    PlatformError.systemError({
                      _tag: "NotFound",
                      module: "ChildProcess",
                      method: "spawn",
                      description: "gtk-update-icon-cache is not installed",
                    }),
                  );
                }
                const exitCode = run.iconCacheExitCode ?? 0;
                // SCIENT-FORK:START scient-conversation-files
                const handle = mockProcess(exitCode, "", run.iconCacheStalled === true);
                // SCIENT-FORK:END scient-conversation-files
                const refreshed =
                  exitCode === 0 && run.onIconCacheRefresh ? run.onIconCacheRefresh : Effect.void;
                return refreshed.pipe(
                  Effect.andThen(
                    run.iconCacheStarted
                      ? Deferred.succeed(run.iconCacheStarted, undefined)
                      : Effect.void,
                  ),
                  Effect.as(handle),
                );
              }),
            ),
          ),
        ),
      ),
    ),
  );

const themeIconFixture = (source: Uint8Array) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-theme-icons-" });
    yield* fileSystem.makeDirectory(path.join(root, "resources", "icons"), { recursive: true });
    yield* fileSystem.writeFile(path.join(root, "resources", "icons", "256x256.png"), source);
    // SCIENT-FORK:START scient-conversation-files
    const caseSensitive = !(yield* fileSystem.exists(
      path.join(root, "resources", "ICONS", "256x256.png"),
    ));
    // SCIENT-FORK:END scient-conversation-files
    const hicolorDir = path.join(root, "icons", "hicolor");
    const appsDir = path.join(hicolorDir, "256x256", "apps");
    const cachePath = path.join(hicolorDir, "icon-theme.cache");
    const pastSeconds = 1_600_000_000;
    const seedCache = Effect.gen(function* () {
      yield* fileSystem.makeDirectory(appsDir, { recursive: true });
      yield* fileSystem.writeFile(cachePath, new Uint8Array([0]));
      yield* fileSystem.utimes(cachePath, pastSeconds, pastSeconds);
    });
    const rewriteCache = fileSystem
      .writeFile(cachePath, new Uint8Array([1]))
      .pipe(Effect.orDie, Effect.provideService(FileSystem.FileSystem, fileSystem));
    // SCIENT-FORK:START scient-conversation-files
    return {
      root,
      hicolorDir,
      appsDir,
      cachePath,
      pastSeconds,
      seedCache,
      rewriteCache,
      caseSensitive,
    };
    // SCIENT-FORK:END scient-conversation-files
  });

const iconCacheRuns = (run: ThemeIconRun) =>
  run.commands.filter(({ command }) => command === "gtk-update-icon-cache").length;

it.layer(NodeServices.layer)("DesktopLinuxUrlHandler theme icons", (it) => {
  it.effect("installs both app id spellings without creating an icon cache", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const icon = new Uint8Array([137, 80, 78, 71, 1, 2, 3]);
      const fixture = yield* themeIconFixture(icon);
      const run: ThemeIconRun = { root: fixture.root, commands: [] };

      yield* registerWithRealFileSystem(run);
      // SCIENT-FORK:START scient-conversation-files
      assert.deepEqual(
        [...(yield* fileSystem.readDirectory(fixture.appsDir))].sort(),
        fixture.caseSensitive ? ["Scient.png", "scient.png"] : ["scient.png"],
      );
      for (const name of ["scient", "Scient"]) {
        const target = path.join(fixture.appsDir, `${name}.png`);
        assert.deepEqual([...(yield* fileSystem.readFile(target))], [...icon]);
        yield* fileSystem.utimes(target, fixture.pastSeconds, fixture.pastSeconds);
      }

      yield* registerWithRealFileSystem(run);
      for (const name of ["scient", "Scient"]) {
        // SCIENT-FORK:END scient-conversation-files
        const info = yield* fileSystem.stat(path.join(fixture.appsDir, `${name}.png`));
        assert.equal(Option.getOrThrow(info.mtime).getTime(), fixture.pastSeconds * 1000);
      }
      assert.isFalse(yield* fileSystem.exists(fixture.cachePath));
      assert.equal(iconCacheRuns(run), 0);
    }).pipe(Effect.scoped),
  );

  it.effect("replaces same-length stale icons and refreshes an existing cache once", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const fixture = yield* themeIconFixture(new Uint8Array([1, 2, 3]));
      yield* fixture.seedCache;
      // SCIENT-FORK:START scient-conversation-files
      const lower = path.join(fixture.appsDir, "scient.png");
      const upper = path.join(fixture.appsDir, "Scient.png");
      yield* fileSystem.writeFile(lower, new Uint8Array([3, 2, 1]));
      // Case-folding hosts cannot seed a stale icon and its fresh alias separately.
      if (fixture.caseSensitive) {
        yield* fileSystem.writeFile(upper, new Uint8Array([1, 2, 3]));
      }
      // SCIENT-FORK:END scient-conversation-files
      for (const target of [lower, upper]) {
        yield* fileSystem.utimes(target, fixture.pastSeconds, fixture.pastSeconds);
      }
      const run: ThemeIconRun = {
        root: fixture.root,
        commands: [],
        onIconCacheRefresh: fixture.rewriteCache,
      };

      yield* registerWithRealFileSystem(run);
      yield* registerWithRealFileSystem(run);

      assert.deepEqual([...(yield* fileSystem.readFile(lower))], [1, 2, 3]);
      const upperInfo = yield* fileSystem.stat(upper);
      // SCIENT-FORK:START scient-conversation-files
      if (fixture.caseSensitive) {
        assert.equal(Option.getOrThrow(upperInfo.mtime).getTime(), fixture.pastSeconds * 1000);
      } else {
        assert.isAbove(Option.getOrThrow(upperInfo.mtime).getTime(), fixture.pastSeconds * 1000);
      }
      // SCIENT-FORK:END scient-conversation-files
      assert.deepEqual(
        run.commands.filter(({ command }) => command === "gtk-update-icon-cache"),
        [{ command: "gtk-update-icon-cache", args: ["-f", "-t", fixture.hicolorDir] }],
      );
    }).pipe(Effect.scoped),
  );

  it.effect("refreshes when this launch changed an icon even if the cache looks newer", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const fixture = yield* themeIconFixture(new Uint8Array([1, 2, 3]));
      yield* fixture.seedCache;
      const run: ThemeIconRun = {
        root: fixture.root,
        commands: [],
        onIconCacheRefresh: fixture.rewriteCache,
      };
      const future = fixture.pastSeconds + 10 * 365 * 24 * 60 * 60;
      yield* fileSystem.utimes(fixture.cachePath, future, future);

      yield* registerWithRealFileSystem(run);

      // SCIENT-FORK:START scient-conversation-files
      assert.isTrue(yield* fileSystem.exists(path.join(fixture.appsDir, "Scient.png")));
      // SCIENT-FORK:END scient-conversation-files
      assert.equal(iconCacheRuns(run), 1);
    }).pipe(Effect.scoped),
  );

  it.effect("retries a failed icon cache refresh on the next launch", () =>
    Effect.gen(function* () {
      const fixture = yield* themeIconFixture(new Uint8Array([1, 2, 3]));
      yield* fixture.seedCache;
      const failing: ThemeIconRun = { root: fixture.root, commands: [], iconCacheExitCode: 1 };
      yield* registerWithRealFileSystem(failing);
      assert.equal(iconCacheRuns(failing), 1);
      assert.deepEqual(failing.commands.map(({ command }) => command).slice(1), [
        "update-desktop-database",
        "xdg-mime",
        // SCIENT-FORK:START scient-conversation-files
        "xdg-mime",
        "xdg-mime",
        "xdg-mime",
        // SCIENT-FORK:END scient-conversation-files
      ]);

      const recovering: ThemeIconRun = {
        root: fixture.root,
        commands: [],
        onIconCacheRefresh: fixture.rewriteCache,
      };
      yield* registerWithRealFileSystem(recovering);
      yield* registerWithRealFileSystem(recovering);
      assert.equal(iconCacheRuns(recovering), 1);
    }).pipe(Effect.scoped),
  );

  it.effect("still registers the handler when the theme icon install fails", () =>
    Effect.gen(function* () {
      const fixture = yield* themeIconFixture(new Uint8Array([1, 2, 3]));
      const missingSource: ThemeIconRun = { root: fixture.root, commands: [], sourceMissing: true };
      yield* registerWithRealFileSystem(missingSource);
      assert.deepEqual(
        missingSource.commands.map(({ command }) => command),
        // SCIENT-FORK:START scient-conversation-files
        ["update-desktop-database", "xdg-mime", "xdg-mime", "xdg-mime", "xdg-mime"],
        // SCIENT-FORK:END scient-conversation-files
      );

      yield* fixture.seedCache;
      const missingTool: ThemeIconRun = {
        root: fixture.root,
        commands: [],
        iconCacheSpawnFails: true,
      };
      yield* registerWithRealFileSystem(missingTool);
      assert.deepEqual(
        missingTool.commands.map(({ command }) => command),
        // SCIENT-FORK:START scient-conversation-files
        [
          "gtk-update-icon-cache",
          "update-desktop-database",
          "xdg-mime",
          "xdg-mime",
          "xdg-mime",
          "xdg-mime",
        ],
        // SCIENT-FORK:END scient-conversation-files
      );
    }).pipe(Effect.scoped),
  );
  // SCIENT-FORK:START scient-retained-stall-guards - upstream dropped these fix guards; no other test covers the stalled-helper timeout.

  // regression: 7733bc839e fix(desktop): make Linux URL handlers discoverable with the app icon (#8673)
  it.effect("continues to xdg-mime when the desktop MIME cache refresh stalls", () =>
    Effect.gen(function* () {
      const recorded = emptyRecording();
      const started = yield* Deferred.make<void>();
      const registration = yield* runRegister(recorded, {
        updateDesktopDatabaseStalled: true,
        updateDesktopDatabaseStarted: started,
      }).pipe(Effect.forkChild);

      yield* Deferred.await(started);
      yield* TestClock.adjust("5 seconds");
      yield* Fiber.join(registration);

      assert.deepEqual(
        recorded.commands.map(({ command }) => command),
        ["update-desktop-database", "xdg-mime", "xdg-mime", "xdg-mime", "xdg-mime"],
      );
    }),
  );

  // regression: f98118d033 fix(desktop): Install Linux theme icons named after the app id (#14471)
  it.effect("continues to xdg-mime when the icon cache refresh stalls", () =>
    Effect.gen(function* () {
      const fixture = yield* themeIconFixture(new Uint8Array([1, 2, 3]));
      yield* fixture.seedCache;
      const started = yield* Deferred.make<void>();
      const iconCacheOptions: Array<Record<string, unknown>> = [];
      const run: ThemeIconRun = {
        root: fixture.root,
        commands: [],
        iconCacheOptions,
        iconCacheStalled: true,
        iconCacheStarted: started,
      };

      const registration = yield* registerWithRealFileSystem(run).pipe(Effect.forkChild);
      yield* Deferred.await(started);
      yield* TestClock.adjust("5 seconds");
      yield* Fiber.join(registration);

      assert.deepEqual(
        run.commands.map(({ command }) => command),
        [
          "gtk-update-icon-cache",
          "update-desktop-database",
          "xdg-mime",
          "xdg-mime",
          "xdg-mime",
          "xdg-mime",
        ],
      );
      // Without a forced kill, releasing a helper that ignores SIGTERM after
      // the timeout would still wait for it to exit.
      assert.equal(iconCacheOptions[0]?.forceKillAfter, "1 second");
    }).pipe(Effect.scoped),
  );
  // SCIENT-FORK:END scient-retained-stall-guards
});
