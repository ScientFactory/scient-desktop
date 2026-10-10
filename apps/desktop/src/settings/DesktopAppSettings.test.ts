import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as DesktopConfig from "../app/DesktopConfig.ts";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as DesktopAppSettings from "./DesktopAppSettings.ts";

const DesktopSettingsPatch = Schema.Struct({
  linuxPasswordStore: Schema.optionalKey(
    Schema.Literals(["auto", "gnome-libsecret", "kwallet", "kwallet5", "kwallet6"]),
  ),
  mainWindowBounds: Schema.optionalKey(
    Schema.NullOr(
      Schema.Struct({
        x: Schema.Number,
        y: Schema.Number,
        width: Schema.Number,
        height: Schema.Number,
      }),
    ),
  ),
  mainWindowMaximized: Schema.optionalKey(Schema.Boolean),
  mainWindowSizeIncreaseApplied: Schema.optionalKey(Schema.Boolean),
  mainWindowNearFullSizeApplied: Schema.optionalKey(Schema.Boolean),
  serverExposureMode: Schema.optionalKey(Schema.Literals(["local-only", "network-accessible"])),
  tailscaleServeEnabled: Schema.optionalKey(Schema.Boolean),
  tailscaleServePort: Schema.optionalKey(Schema.Number),
  updateChannel: Schema.optionalKey(Schema.Literals(["latest", "beta", "nightly"])),
  updateChannelConfiguredByUser: Schema.optionalKey(Schema.Boolean),
  wslBackendEnabled: Schema.optionalKey(Schema.Boolean),
  wslMode: Schema.optionalKey(Schema.Literals(["local", "wsl"])),
  wslDistro: Schema.optionalKey(Schema.NullOr(Schema.String)),
  voiceSelectedModelId: Schema.optionalKey(
    Schema.NullOr(
      Schema.Literals([
        "whisper-small-multilingual-q5_1",
        "whisper-medium-multilingual-q5_0",
        "whisper-large-v3-turbo-multilingual-q5_0",
      ]),
    ),
  ),
  wslOnly: Schema.optionalKey(Schema.Boolean),
});

const decodeDesktopSettingsPatch = Schema.decodeEffect(Schema.fromJsonString(DesktopSettingsPatch));
const encodeDesktopSettingsPatch = Schema.encodeEffect(Schema.fromJsonString(DesktopSettingsPatch));

function layerEnvironment(baseDir: string, appVersion = "0.0.17") {
  return DesktopEnvironment.layer({
    dirname: "/repo/apps/desktop/src",
    homeDirectory: baseDir,
    platform: "darwin",
    processArch: "x64",
    appVersion,
    appPath: "/repo",
    isPackaged: true,
    resourcesPath: "/missing/resources",
    runningUnderArm64Translation: false,
  }).pipe(
    Layer.provide(
      Layer.mergeAll(NodeServices.layer, DesktopConfig.layerTest({ SCIENT_NEXT_HOME: baseDir })),
    ),
  );
}

const withSettings = <A, E, R>(
  effect: Effect.Effect<
    A,
    E,
    R | DesktopAppSettings.DesktopAppSettings | DesktopEnvironment.DesktopEnvironment
  >,
  options?: { readonly appVersion?: string },
) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const baseDir = yield* fileSystem.makeTempDirectoryScoped({
      prefix: "t3-desktop-settings-test-",
    });
    return yield* effect.pipe(
      Effect.provide(
        DesktopAppSettings.layer.pipe(
          Layer.provideMerge(layerEnvironment(baseDir, options?.appVersion)),
          Layer.provideMerge(NodeServices.layer),
        ),
      ),
    );
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped);

function writeSettingsPatch(patch: typeof DesktopSettingsPatch.Type) {
  return Effect.gen(function* () {
    const environment = yield* DesktopEnvironment.DesktopEnvironment;
    const fileSystem = yield* FileSystem.FileSystem;
    const encoded = yield* encodeDesktopSettingsPatch(patch);
    yield* fileSystem.makeDirectory(environment.stateDir, { recursive: true });
    yield* fileSystem.writeFileString(environment.desktopSettingsPath, `${encoded}\n`);
  });
}

describe("DesktopSettings", () => {
  it.effect(
    "persists disabling and re-enabling local execution without clearing backend settings",
    () =>
      withSettings(
        Effect.gen(function* () {
          const settings = yield* DesktopAppSettings.DesktopAppSettings;
          yield* settings.setWslBackendEnabled(true);
          yield* settings.setWslDistro("Ubuntu");
          yield* settings.setServerExposureMode("network-accessible");
          const before = yield* settings.get;
          assert.isTrue((yield* settings.setLocalEnvironmentEnabled(false)).changed);
          assert.deepEqual(yield* settings.load, { ...before, localEnvironmentEnabled: false });
          assert.isFalse((yield* settings.setLocalEnvironmentEnabled(false)).changed);
          yield* settings.setLocalEnvironmentEnabled(true);
          assert.deepEqual(yield* settings.load, before);
        }),
      ),
  );
  it.effect("loads defaults when no settings file exists", () =>
    withSettings(
      Effect.gen(function* () {
        const settings = yield* DesktopAppSettings.DesktopAppSettings;
        assert.deepEqual(yield* settings.load, DesktopAppSettings.DEFAULT_DESKTOP_SETTINGS);
        assert.deepEqual(yield* settings.get, DesktopAppSettings.DEFAULT_DESKTOP_SETTINGS);
      }),
    ),
  );

  it("keeps packaged Scient builds on the stable update channel", () => {
    assert.deepEqual(
      DesktopAppSettings.resolveDefaultDesktopSettings("0.0.17-nightly.20260415.1"),
      {
        linuxPasswordStore: "auto",
        localEnvironmentEnabled: true,
        mainWindowBounds: null,
        mainWindowMaximized: false,
        mainWindowSizeIncreaseApplied: true,
        mainWindowNearFullSizeApplied: true,
        serverExposureMode: "local-only",
        tailscaleServeEnabled: false,
        tailscaleServePort: 443,
        updateChannel: "latest",
        updateChannelConfiguredByUser: false,
        wslBackendEnabled: false,
        wslOnly: false,
        wslDistro: null,
        voiceSelectedModelId: null,
      } satisfies DesktopAppSettings.DesktopSettings,
    );
  });

  it.effect("persists Beta enrollment and a return to Stable across reloads", () =>
    withSettings(
      Effect.gen(function* () {
        const settings = yield* DesktopAppSettings.DesktopAppSettings;
        assert.equal((yield* settings.load).updateChannel, "latest");
        assert.isTrue((yield* settings.setUpdateChannel("beta")).changed);
        assert.equal((yield* settings.load).updateChannel, "beta");
        assert.equal((yield* settings.get).updateChannelConfiguredByUser, true);
        yield* settings.setUpdateChannel("latest");
        assert.equal((yield* settings.load).updateChannel, "latest");
        assert.equal((yield* settings.get).updateChannelConfiguredByUser, true);
      }),
    ),
  );

  it.effect(
    "defaults a direct Beta installation to Beta without overriding an explicit Stable preference",
    () =>
      withSettings(
        Effect.gen(function* () {
          const settings = yield* DesktopAppSettings.DesktopAppSettings;
          assert.equal((yield* settings.load).updateChannel, "beta");
          yield* settings.setUpdateChannel("latest");
          assert.equal((yield* settings.load).updateChannel, "latest");
        }),
        { appVersion: "0.6.23-beta.20261010.1" },
      ),
  );

  it.effect("keeps a migrated Nightly preference on Stable when a Beta installation reloads", () =>
    withSettings(
      Effect.gen(function* () {
        const settings = yield* DesktopAppSettings.DesktopAppSettings;
        yield* writeSettingsPatch({ updateChannel: "nightly", tailscaleServePort: 8443 });
        assert.equal((yield* settings.load).updateChannel, "latest");
        const reloaded = yield* settings.load;
        assert.equal(reloaded.updateChannel, "latest");
        assert.isTrue(reloaded.updateChannelConfiguredByUser);
        assert.equal(reloaded.tailscaleServePort, 8443);
      }),
      { appVersion: "0.6.23-beta.20261010.1" },
    ),
  );

  it.effect("persists and reloads the selected voice model", () =>
    withSettings(
      Effect.gen(function* () {
        const environment = yield* DesktopEnvironment.DesktopEnvironment;
        const fileSystem = yield* FileSystem.FileSystem;
        const settings = yield* DesktopAppSettings.DesktopAppSettings;

        yield* settings.setVoiceSelectedModelId("whisper-large-v3-turbo-multilingual-q5_0");
        assert.equal(
          (yield* settings.get).voiceSelectedModelId,
          "whisper-large-v3-turbo-multilingual-q5_0",
        );
        assert.include(
          yield* fileSystem.readFileString(environment.desktopSettingsPath),
          "whisper-large-v3-turbo-multilingual-q5_0",
        );

        assert.equal(
          (yield* settings.load).voiceSelectedModelId,
          "whisper-large-v3-turbo-multilingual-q5_0",
        );
      }),
    ),
  );

  it.effect("loads persisted settings and applies semantic updates", () =>
    withSettings(
      Effect.gen(function* () {
        const settings = yield* DesktopAppSettings.DesktopAppSettings;
        yield* writeSettingsPatch({
          linuxPasswordStore: "gnome-libsecret",
          serverExposureMode: "network-accessible",
          tailscaleServeEnabled: true,
          tailscaleServePort: 8443,
          updateChannel: "latest",
          updateChannelConfiguredByUser: true,
        });

        assert.deepEqual(yield* settings.load, {
          linuxPasswordStore: "gnome-libsecret",
          localEnvironmentEnabled: true,
          mainWindowBounds: null,
          mainWindowMaximized: false,
          mainWindowSizeIncreaseApplied: false,
          mainWindowNearFullSizeApplied: false,
          serverExposureMode: "network-accessible",
          tailscaleServeEnabled: true,
          tailscaleServePort: 8443,
          updateChannel: "latest",
          updateChannelConfiguredByUser: true,
          wslBackendEnabled: false,
          wslOnly: false,
          wslDistro: null,
          voiceSelectedModelId: null,
        } satisfies DesktopAppSettings.DesktopSettings);

        const exposure = yield* settings.setServerExposureMode("local-only");
        assert.isTrue(exposure.changed);
        assert.equal(exposure.settings.serverExposureMode, "local-only");

        const tailscale = yield* settings.setTailscaleServe({
          enabled: true,
          port: Option.some(9443),
        });
        assert.isTrue(tailscale.changed);
        assert.equal(tailscale.settings.tailscaleServePort, 9443);

        const updateChannel = yield* settings.setUpdateChannel("nightly");
        assert.isFalse(updateChannel.changed);
        assert.equal(updateChannel.settings.updateChannel, "latest");
        assert.equal(updateChannel.settings.updateChannelConfiguredByUser, true);
      }),
    ),
  );

  it.effect("reports the failed desktop settings write operation and path", () =>
    withSettings(
      Effect.gen(function* () {
        const environment = yield* DesktopEnvironment.DesktopEnvironment;
        const fileSystem = yield* FileSystem.FileSystem;
        const settings = yield* DesktopAppSettings.DesktopAppSettings;
        yield* fileSystem.makeDirectory(environment.desktopSettingsPath, { recursive: true });

        const error = yield* settings.setServerExposureMode("network-accessible").pipe(Effect.flip);
        assert.instanceOf(error, DesktopAppSettings.DesktopSettingsWriteError);
        assert.equal(error.operation, "replace-settings-file");
        assert.equal(error.path, environment.desktopSettingsPath);
        assert.exists(error.cause);
        assert.equal(
          error.message,
          `Desktop settings write failed during replace-settings-file at ${environment.desktopSettingsPath}.`,
        );
      }),
    ),
  );

  it.effect("does not persist no-op semantic updates", () =>
    withSettings(
      Effect.gen(function* () {
        const settings = yield* DesktopAppSettings.DesktopAppSettings;

        const exposure = yield* settings.setServerExposureMode("local-only");
        assert.isFalse(exposure.changed);

        const tailscale = yield* settings.setTailscaleServe({
          enabled: false,
          port: Option.none(),
        });
        assert.isFalse(tailscale.changed);

        const updateChannel = yield* settings.setUpdateChannel("latest");
        assert.isFalse(updateChannel.changed);
        assert.equal(updateChannel.settings.updateChannelConfiguredByUser, false);

        const nightly = yield* settings.setUpdateChannel("nightly");
        assert.isFalse(nightly.changed);
        assert.equal(nightly.settings.updateChannel, "latest");
        assert.equal(nightly.settings.updateChannelConfiguredByUser, false);
      }),
    ),
  );

  it.effect("falls back to defaults when the settings file is malformed", () =>
    withSettings(
      Effect.gen(function* () {
        const environment = yield* DesktopEnvironment.DesktopEnvironment;
        const fileSystem = yield* FileSystem.FileSystem;
        const settings = yield* DesktopAppSettings.DesktopAppSettings;
        yield* fileSystem.makeDirectory(environment.stateDir, { recursive: true });
        yield* fileSystem.writeFileString(environment.desktopSettingsPath, "{not-json");

        assert.deepEqual(yield* settings.load, DesktopAppSettings.DEFAULT_DESKTOP_SETTINGS);
      }),
    ),
  );

  it.effect("loads lenient persisted desktop settings JSON", () =>
    withSettings(
      Effect.gen(function* () {
        const environment = yield* DesktopEnvironment.DesktopEnvironment;
        const fileSystem = yield* FileSystem.FileSystem;
        const settings = yield* DesktopAppSettings.DesktopAppSettings;
        yield* fileSystem.makeDirectory(environment.stateDir, { recursive: true });
        yield* fileSystem.writeFileString(
          environment.desktopSettingsPath,
          `{
            // JSONC-style comments and trailing commas match server settings parsing.
            "serverExposureMode": "network-accessible",
            "tailscaleServeEnabled": true,
            "tailscaleServePort": 8443,
            "mainWindowBounds": { "x": 120, "y": 80, "width": 1280, "height": 900 },
          }\n`,
        );

        assert.deepEqual(yield* settings.load, {
          linuxPasswordStore: "auto",
          localEnvironmentEnabled: true,
          mainWindowBounds: { x: 120, y: 80, width: 1280, height: 900 },
          mainWindowMaximized: false,
          mainWindowSizeIncreaseApplied: false,
          mainWindowNearFullSizeApplied: false,
          serverExposureMode: "network-accessible",
          tailscaleServeEnabled: true,
          tailscaleServePort: 8443,
          updateChannel: "latest",
          updateChannelConfiguredByUser: false,
          wslBackendEnabled: false,
          wslOnly: false,
          wslDistro: null,
          voiceSelectedModelId: null,
        } satisfies DesktopAppSettings.DesktopSettings);
      }),
    ),
  );

  it.effect("rejects window bounds that do not satisfy the domain schema", () =>
    withSettings(
      Effect.gen(function* () {
        const settings = yield* DesktopAppSettings.DesktopAppSettings;
        yield* writeSettingsPatch({
          mainWindowBounds: { x: 10.5, y: 20, width: 839, height: 620 },
          mainWindowMaximized: true,
          serverExposureMode: "network-accessible",
        });

        const loaded = yield* settings.load;
        assert.isNull(loaded.mainWindowBounds);
        assert.isFalse(loaded.mainWindowMaximized);
        assert.equal(loaded.serverExposureMode, "network-accessible");
      }),
    ),
  );

  it.effect(
    "normalizes unsupported linux password-store values without dropping other settings",
    () =>
      withSettings(
        Effect.gen(function* () {
          const environment = yield* DesktopEnvironment.DesktopEnvironment;
          const fileSystem = yield* FileSystem.FileSystem;
          const settings = yield* DesktopAppSettings.DesktopAppSettings;
          yield* fileSystem.makeDirectory(environment.stateDir, { recursive: true });
          yield* fileSystem.writeFileString(
            environment.desktopSettingsPath,
            `{
            "linuxPasswordStore": "unsupported-store",
            "serverExposureMode": "network-accessible",
            "tailscaleServeEnabled": true,
            "tailscaleServePort": 8443,
            "updateChannel": "nightly",
            "updateChannelConfiguredByUser": true
          }\n`,
          );

          assert.deepEqual(yield* settings.load, {
            linuxPasswordStore: "auto",
            localEnvironmentEnabled: true,
            mainWindowBounds: null,
            mainWindowMaximized: false,
            mainWindowSizeIncreaseApplied: false,
            mainWindowNearFullSizeApplied: false,
            serverExposureMode: "network-accessible",
            tailscaleServeEnabled: true,
            tailscaleServePort: 8443,
            updateChannel: "latest",
            updateChannelConfiguredByUser: false,
            wslBackendEnabled: false,
            wslOnly: false,
            wslDistro: null,
            voiceSelectedModelId: null,
          } satisfies DesktopAppSettings.DesktopSettings);

          const persisted = yield* decodeDesktopSettingsPatch(
            yield* fileSystem.readFileString(environment.desktopSettingsPath),
          );
          assert.deepEqual(persisted, {
            serverExposureMode: "network-accessible",
            tailscaleServeEnabled: true,
            tailscaleServePort: 8443,
          } satisfies typeof DesktopSettingsPatch.Type);
        }),
      ),
  );

  it.effect("persists sparse desktop settings documents", () =>
    withSettings(
      Effect.gen(function* () {
        const environment = yield* DesktopEnvironment.DesktopEnvironment;
        const fileSystem = yield* FileSystem.FileSystem;
        const settings = yield* DesktopAppSettings.DesktopAppSettings;

        yield* settings.setMainWindowBounds({ x: -1200, y: 40, width: 1440, height: 960 }, true);
        yield* settings.setServerExposureMode("network-accessible");

        const persisted = yield* decodeDesktopSettingsPatch(
          yield* fileSystem.readFileString(environment.desktopSettingsPath),
        );
        assert.deepEqual(persisted, {
          mainWindowBounds: { x: -1200, y: 40, width: 1440, height: 960 },
          mainWindowMaximized: true,
          mainWindowSizeIncreaseApplied: true,
          mainWindowNearFullSizeApplied: true,
          serverExposureMode: "network-accessible",
        } satisfies typeof DesktopSettingsPatch.Type);
      }),
    ),
  );

  it.effect("applies legacy window sizing once, then remembers later user resizing", () =>
    withSettings(
      Effect.gen(function* () {
        const environment = yield* DesktopEnvironment.DesktopEnvironment;
        const fileSystem = yield* FileSystem.FileSystem;
        const settings = yield* DesktopAppSettings.DesktopAppSettings;
        yield* writeSettingsPatch({
          mainWindowBounds: { x: 300, y: 150, width: 1000, height: 700 },
          mainWindowMaximized: true,
          serverExposureMode: "network-accessible",
        });

        assert.isFalse((yield* settings.load).mainWindowSizeIncreaseApplied);
        const increased = yield* settings.applyMainWindowSizeIncrease({
          x: 300,
          y: 150,
          width: 1280,
          height: 840,
        });
        assert.isTrue(increased.changed);
        assert.isTrue(increased.settings.mainWindowMaximized);
        assert.isTrue((yield* settings.load).mainWindowSizeIncreaseApplied);
        assert.isFalse(
          (yield* settings.applyMainWindowSizeIncrease({ x: 0, y: 0, width: 1600, height: 900 }))
            .changed,
        );

        yield* settings.setMainWindowBounds({ x: 80, y: 40, width: 900, height: 650 }, false);
        const reloaded = yield* settings.load;
        assert.deepEqual(reloaded.mainWindowBounds, { x: 80, y: 40, width: 900, height: 650 });
        assert.isFalse(reloaded.mainWindowMaximized);
        assert.isTrue(reloaded.mainWindowSizeIncreaseApplied);
        assert.equal(reloaded.serverExposureMode, "network-accessible");
        assert.isTrue(
          (yield* decodeDesktopSettingsPatch(
            yield* fileSystem.readFileString(environment.desktopSettingsPath),
          )).mainWindowSizeIncreaseApplied,
        );
      }),
    ),
  );

  it.effect("marks a legacy profile without saved bounds so a later resize stays chosen", () =>
    withSettings(
      Effect.gen(function* () {
        const settings = yield* DesktopAppSettings.DesktopAppSettings;
        yield* writeSettingsPatch({ serverExposureMode: "network-accessible" });
        assert.isFalse((yield* settings.load).mainWindowSizeIncreaseApplied);
        assert.isTrue((yield* settings.applyMainWindowSizeIncrease(null)).changed);
        yield* settings.setMainWindowBounds({ x: 40, y: 50, width: 900, height: 650 }, false);
        assert.deepEqual((yield* settings.load).mainWindowBounds, {
          x: 40,
          y: 50,
          width: 900,
          height: 650,
        });
        assert.isTrue((yield* settings.get).mainWindowSizeIncreaseApplied);
      }),
    ),
  );

  it.effect("applies the near-full size once and persists its marker", () =>
    withSettings(
      Effect.gen(function* () {
        const environment = yield* DesktopEnvironment.DesktopEnvironment;
        const fileSystem = yield* FileSystem.FileSystem;
        const settings = yield* DesktopAppSettings.DesktopAppSettings;
        yield* writeSettingsPatch({
          mainWindowBounds: { x: 15, y: 39, width: 1698, height: 977 },
          mainWindowSizeIncreaseApplied: true,
        });
        assert.isFalse((yield* settings.load).mainWindowNearFullSizeApplied);

        const target = { x: 8, y: 33, width: 1712, height: 989 };
        assert.isTrue((yield* settings.applyMainWindowNearFullSize(target)).changed);
        assert.deepEqual((yield* settings.load).mainWindowBounds, target);
        assert.isTrue((yield* settings.get).mainWindowNearFullSizeApplied);
        assert.isFalse((yield* settings.applyMainWindowNearFullSize(null)).changed);
        assert.isTrue(
          (yield* decodeDesktopSettingsPatch(
            yield* fileSystem.readFileString(environment.desktopSettingsPath),
          )).mainWindowNearFullSizeApplied,
        );
      }),
    ),
  );

  it.effect("keeps legacy bounds and retries later when the one-time write fails", () =>
    withSettings(
      Effect.gen(function* () {
        const environment = yield* DesktopEnvironment.DesktopEnvironment;
        const fileSystem = yield* FileSystem.FileSystem;
        const settings = yield* DesktopAppSettings.DesktopAppSettings;
        const legacyBounds = { x: 70, y: 60, width: 1000, height: 700 };
        yield* writeSettingsPatch({ mainWindowBounds: legacyBounds });
        yield* settings.load;

        yield* fileSystem.remove(environment.desktopSettingsPath);
        yield* fileSystem.makeDirectory(environment.desktopSettingsPath);
        const failure = yield* settings
          .applyMainWindowSizeIncrease({ x: 70, y: 60, width: 1280, height: 840 })
          .pipe(Effect.flip);
        assert.instanceOf(failure, DesktopAppSettings.DesktopSettingsWriteError);
        assert.deepEqual((yield* settings.get).mainWindowBounds, legacyBounds);
        assert.isFalse((yield* settings.get).mainWindowSizeIncreaseApplied);
      }),
    ),
  );

  it.effect("removes legacy update channel overrides while preserving other settings", () =>
    withSettings(
      Effect.gen(function* () {
        const environment = yield* DesktopEnvironment.DesktopEnvironment;
        const fileSystem = yield* FileSystem.FileSystem;
        const settings = yield* DesktopAppSettings.DesktopAppSettings;
        yield* writeSettingsPatch({
          serverExposureMode: "network-accessible",
          updateChannel: "nightly",
        });

        assert.deepEqual(yield* settings.load, {
          linuxPasswordStore: "auto",
          localEnvironmentEnabled: true,
          mainWindowBounds: null,
          mainWindowMaximized: false,
          mainWindowSizeIncreaseApplied: false,
          mainWindowNearFullSizeApplied: false,
          serverExposureMode: "network-accessible",
          tailscaleServeEnabled: false,
          tailscaleServePort: 443,
          updateChannel: "latest",
          updateChannelConfiguredByUser: false,
          wslBackendEnabled: false,
          wslOnly: false,
          wslDistro: null,
          voiceSelectedModelId: null,
        } satisfies DesktopAppSettings.DesktopSettings);

        assert.deepEqual(
          yield* decodeDesktopSettingsPatch(
            yield* fileSystem.readFileString(environment.desktopSettingsPath),
          ),
          { serverExposureMode: "network-accessible" } satisfies typeof DesktopSettingsPatch.Type,
        );
      }),
      { appVersion: "0.0.17-nightly.20260415.1" },
    ),
  );

  it.effect("preserves explicit Stable preferences across reloads", () =>
    withSettings(
      Effect.gen(function* () {
        const environment = yield* DesktopEnvironment.DesktopEnvironment;
        const fileSystem = yield* FileSystem.FileSystem;
        const settings = yield* DesktopAppSettings.DesktopAppSettings;
        yield* writeSettingsPatch({
          serverExposureMode: "local-only",
          updateChannel: "latest",
          updateChannelConfiguredByUser: true,
        });

        assert.deepEqual(yield* settings.load, {
          linuxPasswordStore: "auto",
          localEnvironmentEnabled: true,
          mainWindowBounds: null,
          mainWindowMaximized: false,
          mainWindowSizeIncreaseApplied: false,
          mainWindowNearFullSizeApplied: false,
          serverExposureMode: "local-only",
          tailscaleServeEnabled: false,
          tailscaleServePort: 443,
          updateChannel: "latest",
          updateChannelConfiguredByUser: true,
          wslBackendEnabled: false,
          wslOnly: false,
          wslDistro: null,
          voiceSelectedModelId: null,
        } satisfies DesktopAppSettings.DesktopSettings);

        assert.deepEqual(
          yield* decodeDesktopSettingsPatch(
            yield* fileSystem.readFileString(environment.desktopSettingsPath),
          ),
          {
            serverExposureMode: "local-only",
            updateChannel: "latest",
            updateChannelConfiguredByUser: true,
          } satisfies typeof DesktopSettingsPatch.Type,
        );
      }),
      { appVersion: "0.0.17-nightly.20260415.1" },
    ),
  );

  it.effect("normalizes invalid persisted Tailscale Serve ports", () =>
    withSettings(
      Effect.gen(function* () {
        const settings = yield* DesktopAppSettings.DesktopAppSettings;
        yield* writeSettingsPatch({
          tailscaleServeEnabled: true,
          tailscaleServePort: 0,
        });

        assert.deepEqual(yield* settings.load, {
          linuxPasswordStore: "auto",
          localEnvironmentEnabled: true,
          mainWindowBounds: null,
          mainWindowMaximized: false,
          mainWindowSizeIncreaseApplied: false,
          mainWindowNearFullSizeApplied: false,
          serverExposureMode: "local-only",
          tailscaleServeEnabled: true,
          tailscaleServePort: 443,
          updateChannel: "latest",
          updateChannelConfiguredByUser: false,
          wslBackendEnabled: false,
          wslOnly: false,
          wslDistro: null,
          voiceSelectedModelId: null,
        } satisfies DesktopAppSettings.DesktopSettings);
      }),
    ),
  );

  it.effect("persists wsl backend toggle and normalizes invalid distro names", () =>
    withSettings(
      Effect.gen(function* () {
        const settings = yield* DesktopAppSettings.DesktopAppSettings;
        const enable = yield* settings.setWslBackendEnabled(true);
        assert.isTrue(enable.changed);
        assert.equal(enable.settings.wslBackendEnabled, true);

        const distro = yield* settings.setWslDistro("Ubuntu-22.04");
        assert.isTrue(distro.changed);
        assert.equal(distro.settings.wslDistro, "Ubuntu-22.04");

        const reloaded = yield* settings.load;
        assert.equal(reloaded.wslBackendEnabled, true);
        assert.equal(reloaded.wslDistro, "Ubuntu-22.04");

        const reject = yield* settings.setWslDistro("bad name!");
        assert.equal(reject.settings.wslDistro, null);

        const noop = yield* settings.setWslDistro(null);
        assert.isFalse(noop.changed);
      }),
    ),
  );

  it.effect("applies WSL Windows fallback with persisted and volatile updates", () =>
    withSettings(
      Effect.gen(function* () {
        const settings = yield* DesktopAppSettings.DesktopAppSettings;
        yield* settings.setWslBackendEnabled(true);
        yield* settings.setWslOnly(true);

        const persistedFallback = yield* settings.applyWslWindowsFallback;
        assert.isTrue(persistedFallback.changed);
        assert.equal(persistedFallback.settings.wslBackendEnabled, false);
        assert.equal(persistedFallback.settings.wslOnly, false);

        const persistedReload = yield* settings.load;
        assert.equal(persistedReload.wslBackendEnabled, false);
        assert.equal(persistedReload.wslOnly, false);

        yield* settings.setWslBackendEnabled(true);
        yield* settings.setWslOnly(true);

        const volatileFallback = yield* settings.applyWslWindowsFallbackInMemory;
        assert.isTrue(volatileFallback.changed);
        assert.equal(volatileFallback.settings.wslBackendEnabled, false);
        assert.equal(volatileFallback.settings.wslOnly, false);

        const current = yield* settings.get;
        assert.equal(current.wslBackendEnabled, false);
        assert.equal(current.wslOnly, false);

        const diskReload = yield* settings.load;
        assert.equal(diskReload.wslBackendEnabled, true);
        assert.equal(diskReload.wslOnly, true);
      }),
    ),
  );

  it.effect("migrates legacy wslMode=wsl to wslBackendEnabled on load", () =>
    withSettings(
      Effect.gen(function* () {
        const settings = yield* DesktopAppSettings.DesktopAppSettings;
        yield* writeSettingsPatch({
          wslMode: "wsl",
          wslDistro: "Ubuntu-22.04",
        });
        const loaded = yield* settings.load;
        assert.equal(loaded.wslBackendEnabled, true);
        assert.equal(loaded.wslDistro, "Ubuntu-22.04");
      }),
    ),
  );

  it.effect("drops invalid persisted wsl distro values on load", () =>
    withSettings(
      Effect.gen(function* () {
        const settings = yield* DesktopAppSettings.DesktopAppSettings;
        yield* writeSettingsPatch({
          wslBackendEnabled: true,
          wslDistro: "bad/name",
        });
        const loaded = yield* settings.load;
        assert.equal(loaded.wslBackendEnabled, true);
        assert.equal(loaded.wslDistro, null);
      }),
    ),
  );
  it.effect("saves through a symlinked settings file without replacing the link", () =>
    withSettings(
      Effect.gen(function* () {
        const environment = yield* DesktopEnvironment.DesktopEnvironment;
        const fileSystem = yield* FileSystem.FileSystem;
        const settings = yield* DesktopAppSettings.DesktopAppSettings;
        const dotfiles = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3-desktop-settings-dotfiles-",
        });
        const linkedSettingsPath = `${dotfiles}/desktop-settings.json`;
        yield* fileSystem.writeFileString(linkedSettingsPath, "{}\n");
        yield* fileSystem.makeDirectory(environment.stateDir, { recursive: true });
        yield* fileSystem.symlink(linkedSettingsPath, environment.desktopSettingsPath);

        yield* settings.setServerExposureMode("network-accessible");

        assert.equal(
          yield* fileSystem.readLink(environment.desktopSettingsPath),
          linkedSettingsPath,
        );
        const persisted = yield* decodeDesktopSettingsPatch(
          yield* fileSystem.readFileString(linkedSettingsPath),
        );
        assert.equal(persisted.serverExposureMode, "network-accessible");
      }),
    ),
  );

  it.effect("keeps Scient stable update policy when migrating implicit legacy channels", () =>
    withSettings(
      Effect.gen(function* () {
        const settings = yield* DesktopAppSettings.DesktopAppSettings;
        yield* writeSettingsPatch({
          serverExposureMode: "local-only",
          updateChannel: "latest",
        });

        assert.deepEqual(yield* settings.load, {
          linuxPasswordStore: "auto",
          localEnvironmentEnabled: true,
          mainWindowBounds: null,
          mainWindowMaximized: false,
          mainWindowSizeIncreaseApplied: false,
          mainWindowNearFullSizeApplied: false,
          voiceSelectedModelId: null,
          serverExposureMode: "local-only",
          tailscaleServeEnabled: false,
          tailscaleServePort: 443,
          updateChannel: "latest",
          updateChannelConfiguredByUser: false,
          wslBackendEnabled: false,
          wslOnly: false,
          wslDistro: null,
        } satisfies DesktopAppSettings.DesktopSettings);
      }),
      { appVersion: "0.0.17-nightly.20260415.1" },
    ),
  );
});
