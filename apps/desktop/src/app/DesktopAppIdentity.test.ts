import * as NodePath from "@effect/platform-node/NodePath";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import type * as Electron from "electron";

import * as ElectronApp from "../electron/ElectronApp.ts";
import * as DesktopAppIdentity from "./DesktopAppIdentity.ts";
import * as DesktopAssets from "./DesktopAssets.ts";
import * as DesktopConfig from "./DesktopConfig.ts";
import * as DesktopEnvironment from "./DesktopEnvironment.ts";

const defaultEnvironmentInput = {
  dirname: "/repo/apps/desktop/dist-electron",
  homeDirectory: "/Users/alice",
  platform: "darwin",
  processArch: "arm64",
  appVersion: "1.2.3",
  appPath: "/Applications/T3 Code.app/Contents/Resources/app.asar",
  isPackaged: true,
  resourcesPath: "/Applications/T3 Code.app/Contents/Resources",
  runningUnderArm64Translation: false,
} satisfies DesktopEnvironment.MakeDesktopEnvironmentInput;

type TestEnvironmentInput = Partial<DesktopEnvironment.MakeDesktopEnvironmentInput> & {
  readonly env?: Record<string, string | undefined>;
};

interface ElectronAppCalls {
  readonly setAboutPanelOptions: Array<Electron.AboutPanelOptionsOptions>;
  readonly setDockIcon: string[];
  readonly setName: string[];
}

const layerElectronApp = (calls: ElectronAppCalls) =>
  Layer.succeed(ElectronApp.ElectronApp, {
    metadata: Effect.die("unexpected metadata read"),
    name: Effect.succeed("T3 Code"),
    systemLocale: Effect.succeed("en-US"),
    whenReady: Effect.void,
    requestSingleInstanceLock: Effect.succeed(true),
    quit: Effect.void,
    exit: () => Effect.void,
    relaunch: () => Effect.void,
    setPath: () => Effect.void,
    setName: (name) =>
      Effect.sync(() => {
        calls.setName.push(name);
      }),
    setAboutPanelOptions: (options) =>
      Effect.sync(() => {
        calls.setAboutPanelOptions.push(options);
      }),
    setAppUserModelId: () => Effect.void,
    getAppMetrics: Effect.succeed([]),
    setAsDefaultProtocolClient: () => Effect.succeed(true),
    setDesktopName: () => Effect.void,
    setDockIcon: (iconPath) =>
      Effect.sync(() => {
        calls.setDockIcon.push(iconPath);
      }),
    appendCommandLineSwitch: () => Effect.void,
    onBeforeQuitForUpdate: () => Effect.void,
    removeCommandLineSwitch: () => Effect.void,
    on: () => Effect.void,
  } satisfies ElectronApp.ElectronApp["Service"]);

const layerAssets = (png: Option.Option<string>) =>
  Layer.succeed(DesktopAssets.DesktopAssets, {
    iconPaths: Effect.succeed({
      ico: Option.none(),
      icns: Option.none(),
      png,
    }),
    resolveResourcePath: () => Effect.succeedNone,
  } satisfies DesktopAssets.DesktopAssets["Service"]);

const layerEnvironment = (overrides: TestEnvironmentInput = {}) => {
  const { env, ...environmentOverrides } = overrides;
  return DesktopEnvironment.layer({
    ...defaultEnvironmentInput,
    ...environmentOverrides,
  }).pipe(
    Layer.provide(
      Layer.mergeAll(
        NodeServices.layer,
        NodePath.layerPosix,
        DesktopConfig.layerTest({
          ...env,
        }),
      ),
    ),
  );
};

const withIdentity = <A, E, R>(
  effect: Effect.Effect<
    A,
    E,
    | R
    | DesktopAppIdentity.DesktopAppIdentity
    | DesktopEnvironment.DesktopEnvironment
    | FileSystem.FileSystem
  >,
  input: {
    readonly calls?: ElectronAppCalls;
    readonly environment?: TestEnvironmentInput;
    readonly packageJson?: string;
    readonly pngIconPath?: Option.Option<string>;
    // SCIENT-FORK:START desktop-state-isolation — records probes so tests can prove
    // Scient never inspects legacy userData paths.
    readonly legacyPathExists?: boolean;
    readonly existsCalls?: string[];
    // SCIENT-FORK:END desktop-state-isolation
  } = {},
) => {
  const calls: ElectronAppCalls = input.calls ?? {
    setAboutPanelOptions: [],
    setDockIcon: [],
    setName: [],
  };

  return effect.pipe(
    Effect.provide(
      DesktopAppIdentity.layer.pipe(
        Layer.provideMerge(
          FileSystem.layerNoop({
            // SCIENT-FORK:START desktop-state-isolation
            exists: (path) => {
              input.existsCalls?.push(path);
              return Effect.succeed(
                input.legacyPathExists === true && path.includes("Scient (Alpha)"),
              );
            },
            // SCIENT-FORK:END desktop-state-isolation
            readFileString: () =>
              Effect.succeed(input.packageJson ?? '{"t3codeCommitHash":"abcdef1234567890"}'),
          }),
        ),
        Layer.provideMerge(layerAssets(input.pngIconPath ?? Option.none())),
        Layer.provideMerge(layerElectronApp(calls)),
        Layer.provideMerge(layerEnvironment(input.environment)),
      ),
    ),
  );
};

describe("DesktopAppIdentity", () => {
  // SCIENT-FORK:START desktop-state-isolation — Scient replaces the V1/V2 profile adoption
  // rows: it never probes or adopts a legacy userData path, and development state stays
  // under the candidate state directory.
  it.effect("does not inspect legacy userData paths", () => {
    const existsCalls: string[] = [];
    return withIdentity(
      Effect.gen(function* () {
        const identity = yield* DesktopAppIdentity.DesktopAppIdentity;
        const userDataPath = yield* identity.resolveUserDataPath;
        assert.equal(userDataPath, "/Users/alice/Library/Application Support/scient-next");
        assert.deepEqual(existsCalls, []);
      }),
      { existsCalls },
    );
  });

  it.effect("isolates development Electron state under the candidate state directory", () =>
    withIdentity(
      Effect.gen(function* () {
        const identity = yield* DesktopAppIdentity.DesktopAppIdentity;
        const userDataPath = yield* identity.resolveUserDataPath;
        assert.equal(userDataPath, "/Users/alice/.scient-next/scient-next-dev/electron-userdata");
      }),
      {
        environment: {
          isPackaged: false,
          env: { VITE_DEV_SERVER_URL: "http://127.0.0.1:5173" },
        },
      },
    ),
  );
  // SCIENT-FORK:END desktop-state-isolation

  it.effect.each([
    { stage: "Beta", environment: {} },
    {
      stage: "Nightly",
      environment: { appVersion: "0.0.43-nightly.20260929.2428" },
    },
    {
      stage: "Dev",
      environment: { env: { VITE_DEV_SERVER_URL: "http://localhost:5173" } },
    },
  ])("uses a valid native User-Agent product name for $stage", ({ stage, environment }) => {
    const calls: ElectronAppCalls = {
      setAboutPanelOptions: [],
      setDockIcon: [],
      setName: [],
    };

    return withIdentity(
      Effect.gen(function* () {
        const identity = yield* DesktopAppIdentity.DesktopAppIdentity;
        yield* identity.configure;

        const runtimeName = calls.setName[0];
        assert.isDefined(runtimeName);
        // SCIENT-FORK:START desktop-release-channels — only development builds carry a stage.
        assert.equal(runtimeName, stage === "Dev" ? "Scient Dev" : "Scient");
        // SCIENT-FORK:END desktop-release-channels
        assert.match(runtimeName.replaceAll(" ", ""), /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/);
        // SCIENT-FORK:START desktop-release-channels
        assert.equal(
          calls.setAboutPanelOptions[0]?.applicationName,
          stage === "Dev" ? "Scient (Dev)" : "Scient",
        );
        // SCIENT-FORK:END desktop-release-channels
      }),
      { calls, environment },
    );
  });
  // SCIENT-FORK:START restored-sole-guards - upstream's snap dropped this; the mutation it guards passed every other desktop test.

  // regression: aa219be713 port desktop app to Effect (#2546) - sole guard: ignoring the commit-hash override or its 12-character trim passed every other desktop test
  it.effect("configures app identity from the environment commit override", () => {
    const calls: ElectronAppCalls = {
      setAboutPanelOptions: [],
      setDockIcon: [],
      setName: [],
    };

    return withIdentity(
      Effect.gen(function* () {
        const identity = yield* DesktopAppIdentity.DesktopAppIdentity;
        yield* identity.configure;

        assert.deepEqual(calls.setName, ["Scient"]);
        assert.equal(calls.setAboutPanelOptions[0]?.applicationName, "Scient");
        assert.equal(calls.setAboutPanelOptions[0]?.applicationVersion, "1.2.3");
        assert.equal(calls.setAboutPanelOptions[0]?.version, "0123456789ab");
        assert.deepEqual(calls.setDockIcon, []);
      }),
      {
        calls,
        environment: {
          env: {
            T3CODE_COMMIT_HASH: "0123456789abcdef",
          },
        },
        pngIconPath: Option.some("/icon.png"),
      },
    );
  });
  // SCIENT-FORK:END restored-sole-guards

  // SCIENT-FORK:START restored-behavior-guards
  // regression: 3e8f7bc0e1 chore: bootstrap Scient Next D4 candidate
  it.effect("never adopts a legacy userData path during D4", () =>
    withIdentity(
      Effect.gen(function* () {
        const identity = yield* DesktopAppIdentity.DesktopAppIdentity;
        const userDataPath = yield* identity.resolveUserDataPath;

        assert.equal(userDataPath, "/Users/alice/Library/Application Support/scient-next");
      }),
      { legacyPathExists: true },
    ),
  );
  // SCIENT-FORK:END restored-behavior-guards
});
