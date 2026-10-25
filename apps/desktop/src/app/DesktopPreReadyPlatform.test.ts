import { assert, describe, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { beforeEach, vi } from "vite-plus/test";

const {
  appendSwitchMock,
  getSwitchValueMock,
  hasSwitchMock,
  registerSchemesMock,
  setDesktopNameMock,
  mkdirSyncMock,
  writeFileSyncMock,
  copyFileSyncMock,
  execFileSyncMock,
  readFileSyncMock,
} = vi.hoisted(() => ({
  appendSwitchMock: vi.fn(),
  getSwitchValueMock: vi.fn(),
  hasSwitchMock: vi.fn(),
  registerSchemesMock: vi.fn(),
  setDesktopNameMock: vi.fn(),
  mkdirSyncMock: vi.fn(),
  writeFileSyncMock: vi.fn(),
  copyFileSyncMock: vi.fn(),
  execFileSyncMock: vi.fn(),
  readFileSyncMock: vi.fn(),
}));

vi.mock("electron", () => ({
  app: {
    setDesktopName: setDesktopNameMock,
    getVersion: () => "0.0.37",
    isPackaged: true,
    getAppPath: () => "/tmp/.mount_T3/resources/app.asar",
    commandLine: {
      appendSwitch: appendSwitchMock,
      getSwitchValue: getSwitchValueMock,
      hasSwitch: hasSwitchMock,
    },
  },
  protocol: {
    registerSchemesAsPrivileged: registerSchemesMock,
  },
}));

vi.mock("node:fs", () => ({
  readFileSync: readFileSyncMock,
  mkdirSync: mkdirSyncMock,
  writeFileSync: writeFileSyncMock,
  copyFileSync: copyFileSyncMock,
}));

vi.mock("node:child_process", () => ({
  execFileSync: execFileSyncMock,
}));

import * as DesktopPreReadyPlatform from "./DesktopPreReadyPlatform.ts";

describe("DesktopPreReadyPlatform", () => {
  beforeEach(() => {
    appendSwitchMock.mockReset();
    getSwitchValueMock.mockReset();
    hasSwitchMock.mockReset();
    registerSchemesMock.mockReset();
    setDesktopNameMock.mockReset();
    mkdirSyncMock.mockReset();
    writeFileSyncMock.mockReset();
    copyFileSyncMock.mockReset();
    execFileSyncMock.mockReset();
    readFileSyncMock.mockReset().mockReturnValue("{}");
  });

  it.effect("persists Linux scaling synchronously across relaunches and settings rewrites", () => {
    // SCIENT-FORK:START desktop-state-isolation
    vi.stubEnv("SCIENT_NEXT_HOME", "/isolated");
    vi.stubEnv("T3CODE_HOME", "/foreign-profile");
    // SCIENT-FORK:END desktop-state-isolation
    vi.stubEnv("VITE_DEV_SERVER_URL", "");
    const settingsPath = "/isolated/userdata/desktop-settings.json";
    const files = new Map([[settingsPath, "{}"]]);
    const commandLine = new Map<string, string>();
    readFileSyncMock.mockImplementation((path: string) => {
      const contents = files.get(path);
      if (contents === undefined) throw new Error("ENOENT");
      return contents;
    });
    writeFileSyncMock.mockImplementation((path: string, contents: string) => {
      files.set(path, contents);
    });
    hasSwitchMock.mockImplementation((name: string) => commandLine.has(name));
    getSwitchValueMock.mockImplementation((name: string) => commandLine.get(name) ?? "");
    appendSwitchMock.mockImplementation((name: string, value: string) => {
      commandLine.set(name, value);
    });
    const launch = Effect.gen(function* () {
      const startup = Promise.resolve().then(() => commandLine.get("force-device-scale-factor"));
      yield* DesktopPreReadyPlatform.make;
      return yield* Effect.promise(() => startup);
    });

    return Effect.gen(function* () {
      for (const explicitScale of ["1.75", "1"]) {
        commandLine.clear();
        commandLine.set("force-device-scale-factor", explicitScale);
        appendSwitchMock.mockClear();
        assert.equal(yield* launch, explicitScale);
        assert.isFalse(
          appendSwitchMock.mock.calls.some(([name]) => name === "force-device-scale-factor"),
        );

        // The settings service discards fields it does not own when rewriting its document.
        files.set(settingsPath, JSON.stringify({ linuxPasswordStore: "basic" }));
        commandLine.clear();
        assert.equal(yield* launch, explicitScale);
      }
    }).pipe(
      Effect.provideService(HostProcess.Platform, "linux"),
      // SCIENT-FORK:START desktop-state-isolation
      Effect.provideService(HostProcess.HomeDirectory, "/home/me"),
      // SCIENT-FORK:END desktop-state-isolation
      Effect.ensuring(Effect.sync(() => vi.unstubAllEnvs())),
    );
  });

  it.effect.each([
    { previousEntry: undefined, label: "missing" },
    { previousEntry: 'Exec="/Applications/deleted-previous.AppImage" %U', label: "stale" },
  ])("prepares a $label Linux desktop entry before startup yields", ({ previousEntry }) => {
    vi.stubEnv("VITE_DEV_SERVER_URL", "");
    vi.stubEnv("XDG_DATA_HOME", "/xdg");
    vi.stubEnv("APPIMAGE", "/Applications/current.AppImage");
    getSwitchValueMock.mockReturnValue("");
    let desktopName = "t3code.desktop";
    let desktopEntry = previousEntry;
    let iconInstalled = false;
    copyFileSyncMock.mockImplementation((_source: string, destination: string) => {
      // SCIENT-FORK:START desktop-state-isolation
      iconInstalled = destination === "/xdg/icons/scient.desktop.png";
    });
    setDesktopNameMock.mockImplementation((name: string) => {
      desktopName = name;
    });
    writeFileSyncMock.mockImplementation((path: string, contents: string) => {
      if (path === "/xdg/applications/scient.desktop") desktopEntry = contents;
      // SCIENT-FORK:END desktop-state-isolation
    });

    return Effect.scoped(
      Effect.gen(function* () {
        const portalIdentity = Promise.resolve().then(() => ({
          desktopName,
          desktopEntry,
          iconInstalled,
        }));
        yield* Layer.build(
          DesktopPreReadyPlatform.layer.pipe(
            Layer.provide(Layer.succeed(HostProcess.Platform, "linux")),
            // SCIENT-FORK:START desktop-state-isolation
            Layer.provide(Layer.succeed(HostProcess.HomeDirectory, "/home/me")),
          ),
        );
        const identity = yield* Effect.promise(() => portalIdentity);
        assert.equal(identity.desktopName, "scient.desktop");
        assert.include(identity.desktopEntry ?? "", "Exec=/Applications/current.AppImage %U");
        assert.include(identity.desktopEntry ?? "", "Name=Scient");
        assert.include(
          identity.desktopEntry ?? "",
          "MimeType=x-scheme-handler/scient;application/vnd.scient.conversation+zip;",
        );
        assert.include(identity.desktopEntry ?? "", "Icon=/xdg/icons/scient.desktop.png");
        // SCIENT-FORK:END desktop-state-isolation
        assert.isTrue(identity.iconInstalled);
      }),
    ).pipe(Effect.ensuring(Effect.sync(() => vi.unstubAllEnvs())));
  });

  // SCIENT-FORK:START desktop-state-isolation
  // regression: 7733bc839e fix(desktop): make Linux URL handlers discoverable with the app icon (#8673)
  it.effect("still prepares the portal entry when the bundled icon cannot be copied", () => {
    vi.stubEnv("VITE_DEV_SERVER_URL", "");
    vi.stubEnv("XDG_DATA_HOME", "/xdg");
    vi.stubEnv("APPIMAGE", "/Applications/current.AppImage");
    getSwitchValueMock.mockReturnValue("");
    copyFileSyncMock.mockImplementation(() => {
      throw new Error("missing bundled icon");
    });
    return Effect.gen(function* () {
      yield* DesktopPreReadyPlatform.make;
      const contents = writeFileSyncMock.mock.calls[0]?.[1];
      assert.include(contents, "MimeType=x-scheme-handler/scient;");
      assert.include(contents, "Icon=");
      assert.equal(setDesktopNameMock.mock.calls.length, 1);
    }).pipe(
      Effect.provideService(HostProcess.Platform, "linux"),
      Effect.provideService(HostProcess.HomeDirectory, "/home/me"),
      Effect.ensuring(Effect.sync(() => vi.unstubAllEnvs())),
    );
  });
  // SCIENT-FORK:END desktop-state-isolation

  it.effect("points the early portal entry at a configured distribution launcher", () => {
    vi.stubEnv("VITE_DEV_SERVER_URL", "");
    vi.stubEnv("XDG_DATA_HOME", "/xdg");
    vi.stubEnv("APPIMAGE", "/Applications/current.AppImage");
    vi.stubEnv("T3CODE_DESKTOP_LAUNCHER_PATH", " /opt/T3 Code/t3code ");
    getSwitchValueMock.mockReturnValue("");

    return Effect.scoped(
      Effect.gen(function* () {
        yield* Layer.build(
          DesktopPreReadyPlatform.layer.pipe(
            Layer.provide(Layer.succeed(HostProcess.Platform, "linux")),
            // SCIENT-FORK:START desktop-state-isolation
            Layer.provide(Layer.succeed(HostProcess.HomeDirectory, "/home/me")),
          ),
        );
        const entry = writeFileSyncMock.mock.calls.find(
          ([path]) => path === "/xdg/applications/scient.desktop",
        )?.[1];
        // SCIENT-FORK:END desktop-state-isolation
        assert.include(entry, 'Exec="/opt/T3 Code/t3code" %U');
      }),
    ).pipe(Effect.ensuring(Effect.sync(() => vi.unstubAllEnvs())));
  });

  it.effect(
    "acquires a synchronous pre-ready layer before an asynchronous Clerk-shaped layer",
    () =>
      Effect.gen(function* () {
        class ClerkShaped extends Context.Service<ClerkShaped, { readonly ready: true }>()(
          "@t3tools/desktop/app/DesktopPreReadyPlatform.test/ClerkShaped",
        ) {}

        const events: Array<string> = [];
        registerSchemesMock.mockImplementation(() => {
          events.push("pre-ready");
        });

        const layerPreReady = DesktopPreReadyPlatform.layer.pipe(
          Layer.provide(Layer.succeed(HostProcess.Platform, "darwin")),
          // SCIENT-FORK:START desktop-state-isolation
          Layer.provide(Layer.succeed(HostProcess.HomeDirectory, "/home/me")),
          // SCIENT-FORK:END desktop-state-isolation
        );

        const layerClerkShaped = Layer.effect(
          ClerkShaped,
          Effect.promise(() => Promise.resolve()).pipe(
            Effect.map(() => {
              events.push("clerk");
              return { ready: true as const };
            }),
          ),
        );

        const layerRuntime = layerClerkShaped.pipe(
          Layer.flatMap((clerkContext) => Layer.succeedContext(clerkContext)),
          Layer.provideMerge(layerPreReady),
        );

        const result = yield* Effect.all({
          clerk: ClerkShaped,
          preReady: DesktopPreReadyPlatform.DesktopPreReadyElectronOptions,
        }).pipe(Effect.provide(layerRuntime));

        assert.deepEqual(result, {
          clerk: { ready: true },
          preReady: {
            linux: null,
            linuxPasswordStoreCommandLine: null,
          },
        });
        assert.deepEqual(events, ["pre-ready", "clerk"]);
        assert.equal(registerSchemesMock.mock.calls.length, 1);
        assert.equal(appendSwitchMock.mock.calls.length, 0);
        assert.equal(setDesktopNameMock.mock.calls.length, 0);
      }),
  );
  // SCIENT-FORK:START restored-sole-guards - upstream's snap dropped this; the mutation it guards passed every other desktop test.
  // regression: 299404a754 feat(desktop): add cross-platform window capture (#8103) - sole guard: letting a desktop-entry write failure escape passed every other desktop test
  it.effect("keeps startup available when the early desktop entry cannot be written", () => {
    getSwitchValueMock.mockReturnValue("");
    mkdirSyncMock.mockImplementation(() => {
      throw new Error("read-only filesystem");
    });

    return DesktopPreReadyPlatform.make.pipe(
      Effect.provideService(HostProcess.Platform, "linux"),
      Effect.provideService(HostProcess.HomeDirectory, "/home/me"),
      Effect.asVoid,
    );
  });
  // SCIENT-FORK:END restored-sole-guards

  // SCIENT-FORK:START restored-sole-guards - upstream's snap dropped this; the mutation it guards passed every other desktop test.
  // regression: 181e45110f test(desktop): cover password store through startup (#10287) - sole guard: overriding an explicit --password-store switch passed every other desktop test
  it.effect("preserves an explicit Linux password-store switch", () => {
    hasSwitchMock.mockImplementation((switchName) => switchName === "password-store");
    getSwitchValueMock.mockReturnValue(" basic ");

    return Effect.gen(function* () {
      const options = yield* DesktopPreReadyPlatform.DesktopPreReadyElectronOptions;

      assert.equal(options.linuxPasswordStoreCommandLine, "basic");
      assert.isFalse(appendSwitchMock.mock.calls.some(([name]) => name === "password-store"));
    }).pipe(
      Effect.provide(
        DesktopPreReadyPlatform.layer.pipe(
          Layer.provide(Layer.succeed(HostProcess.Platform, "linux")),
          Layer.provide(Layer.succeed(HostProcess.HomeDirectory, "/home/me")),
        ),
      ),
    );
  });
  // SCIENT-FORK:END restored-sole-guards
});
