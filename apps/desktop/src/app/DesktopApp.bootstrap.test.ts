import * as NodePath from "@effect/platform-node/NodePath";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as NetService from "@t3tools/shared/Net";
import * as Cause from "effect/Cause";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as HttpClient from "effect/http/HttpClient";
import { vi } from "vite-plus/test";

import * as DesktopApp from "./DesktopApp.ts";
import * as DesktopAppActivation from "./DesktopAppActivation.ts";
import * as DesktopAppIdentity from "./DesktopAppIdentity.ts";
import * as DesktopClerk from "./DesktopClerk.ts";
import * as DesktopCliCommand from "./DesktopCliCommand.ts";
import * as DesktopConfig from "./DesktopConfig.ts";
import * as DesktopConnectionCatalogStore from "./DesktopConnectionCatalogStore.ts";
import * as DesktopEnvironment from "./DesktopEnvironment.ts";
import * as DesktopLifecycle from "./DesktopLifecycle.ts";
import * as DesktopLinuxUrlHandler from "./DesktopLinuxUrlHandler.ts";
import * as DesktopPreReadyPlatform from "./DesktopPreReadyPlatform.ts";
import * as DesktopShutdown from "./DesktopShutdown.ts";
import * as DesktopState from "./DesktopState.ts";
import * as DesktopVoice from "./DesktopVoice.ts";
import * as DesktopWebLinks from "./DesktopWebLinks.ts";
import * as DesktopBackendConfiguration from "../backend/DesktopBackendConfiguration.ts";
import * as DesktopBackendPool from "../backend/DesktopBackendPool.ts";
import * as DesktopLocalEnvironmentAuth from "../backend/DesktopLocalEnvironmentAuth.ts";
import * as DesktopServerExposure from "../backend/DesktopServerExposure.ts";
import * as ElectronApp from "../electron/ElectronApp.ts";
import * as ElectronDialog from "../electron/ElectronDialog.ts";
import * as ElectronMenu from "../electron/ElectronMenu.ts";
import * as ElectronProtocol from "../electron/ElectronProtocol.ts";
import * as ElectronSafeStorage from "../electron/ElectronSafeStorage.ts";
import * as ElectronShell from "../electron/ElectronShell.ts";
import * as ElectronTheme from "../electron/ElectronTheme.ts";
import * as ElectronWindow from "../electron/ElectronWindow.ts";
import * as DesktopIpc from "../ipc/DesktopIpc.ts";
import * as MacPermissions from "../permissions/MacPermissions.ts";
import * as BrowserImport from "../preview/BrowserImport/BrowserImport.ts";
import * as PreviewManager from "../preview/Manager.ts";
import * as PreviewPasskeys from "../preview/Passkeys.ts";
import * as DesktopAppSettings from "../settings/DesktopAppSettings.ts";
import * as DesktopClientSettings from "../settings/DesktopClientSettings.ts";
import * as DesktopShellEnvironment from "../shell/DesktopShellEnvironment.ts";
import * as DesktopSnapShot from "../snapShot/DesktopSnapShot.ts";
import * as DesktopSshEnvironment from "../ssh/DesktopSshEnvironment.ts";
import * as DesktopSshPasswordPrompts from "../ssh/DesktopSshPasswordPrompts.ts";
import * as DesktopRendererHistory from "../telemetry/DesktopRendererHistory.ts";
import * as DesktopTelemetryPublisher from "../telemetry/DesktopTelemetryPublisher.ts";
import * as DesktopUpdates from "../updates/DesktopUpdates.ts";
import * as DesktopApplicationMenu from "../window/DesktopApplicationMenu.ts";
import * as DesktopWindow from "../window/DesktopWindow.ts";
import * as DesktopWslBackend from "../wsl/DesktopWslBackend.ts";
import * as DesktopWslEnvironment from "../wsl/DesktopWslEnvironment.ts";

// These registrars own unrelated OS listeners and IPC handlers. The actual
// exported app program, environment, renderer decision, and port scan run below.
vi.mock("../ipc/DesktopIpcHandlers.ts", () => ({ installDesktopIpcHandlers: () => Effect.void }));
vi.mock("../updates/DesktopRemoteUpdates.ts", () => ({ listen: Effect.void }));
vi.mock("../scient/conversationImport/openedConversationFiles.ts", () => ({
  captureConversationFileOpens: () => {},
  installConversationFileOpening: Effect.void,
}));

const runStartup = (env: Record<string, string> = {}, isPackaged = false) =>
  Effect.gen(function* () {
    const environment = yield* DesktopEnvironment.DesktopEnvironment.pipe(
      Effect.provide(
        DesktopEnvironment.layer({
          dirname: "/repo/apps/desktop/dist-electron",
          homeDirectory: "/Users/alice",
          platform: "darwin",
          processArch: "arm64",
          appVersion: "0.0.45",
          appPath: "/Applications/Scient.app/Contents/Resources/app.asar",
          isPackaged,
          resourcesPath: "/Applications/Scient.app/Contents/Resources",
          runningUnderArm64Translation: false,
        }).pipe(
          Layer.provide(
            Layer.mergeAll(
              NodePath.layerPosix,
              DesktopConfig.layerTest({
                SCIENT_NEXT_HOME: "/tmp/scient-bootstrap-fixture",
                ...env,
              }),
            ),
          ),
        ),
      ),
    );
    const userDataPath = yield* DesktopAppIdentity.resolveUserDataPath.pipe(
      Effect.provideService(DesktopEnvironment.DesktopEnvironment, environment),
    );
    const registrations: ElectronProtocol.DesktopProtocolRegistrationInput[] = [];
    const probes: Array<{ port: number; host: string }> = [];
    const configuredPorts: number[] = [];
    const userDataPaths: string[] = [];
    const fatalErrors: string[] = [];
    let backendStarts = 0;
    let quitCalls = 0;
    let port = 0;
    const primary: DesktopBackendPool.DesktopBackendInstance = {
      id: DesktopBackendPool.PRIMARY_INSTANCE_ID,
      label: Effect.succeed("Primary"),
      start: Effect.sync(() => {
        backendStarts += 1;
      }),
      stop: () => Effect.void,
      currentConfig: Effect.succeedNone,
      snapshot: Effect.succeed({
        desiredRunning: false,
        ready: false,
        activePid: Option.none(),
        restartAttempt: 0,
        restartScheduled: false,
      }),
      waitForReady: () => Effect.succeed(false),
    };
    const services = Layer.mergeAll(
      NodeServices.layer,
      Layer.succeed(DesktopEnvironment.DesktopEnvironment, environment),
      DesktopState.layer,
      Layer.effect(
        Crypto.Crypto,
        Effect.map(Crypto.Crypto, (crypto) => ({
          ...crypto,
          randomUUIDv4: Effect.succeed("00000000-0000-4000-8000-000000000000"),
        })),
      ).pipe(Layer.provide(NodeServices.layer)),
      DesktopAppSettings.layerTest(environment.defaultDesktopSettings),
      Layer.mock(DesktopAppIdentity.DesktopAppIdentity, {
        resolveUserDataPath: Effect.succeed(userDataPath),
        configure: Effect.void,
      }),
      Layer.mock(ElectronApp.ElectronApp, {
        whenReady: Effect.void,
        setPath: (name, value) =>
          Effect.sync(() => {
            assert.equal(name, "userData");
            userDataPaths.push(value);
          }),
        quit: Effect.sync(() => {
          quitCalls += 1;
        }),
      }),
      Layer.mock(ElectronDialog.ElectronDialog, {
        showErrorBox: (_title, content) =>
          Effect.sync(() => {
            fatalErrors.push(content);
          }),
      }),
      Layer.mock(ElectronProtocol.ElectronProtocol, {
        registerDesktopProtocol: (input) =>
          Effect.sync(() => {
            registrations.push(input);
          }),
      }),
      Layer.mock(NetService.NetService, {
        canListenOnHost: (candidate, host) =>
          Effect.sync(() => {
            probes.push({ port: candidate, host });
            return candidate !== 3773;
          }),
      }),
      Layer.mock(DesktopBackendPool.DesktopBackendPool, {
        primary: Effect.succeed(primary),
        list: Effect.succeed([primary]),
      }),
      Layer.mock(DesktopServerExposure.DesktopServerExposure, {
        configureFromSettings: (input) =>
          Effect.sync(() => {
            port = input.port;
            configuredPorts.push(port);
            return {
              mode: "local-only" as const,
              endpointUrl: null,
              advertisedHost: null,
              tailscaleServeEnabled: false,
              tailscaleServePort: 443,
            };
          }),
        backendConfig: Effect.sync(() => ({
          port,
          bindHost: "127.0.0.1",
          httpBaseUrl: new URL(`http://127.0.0.1:${port}`),
          tailscaleServeEnabled: false,
          tailscaleServePort: 443,
        })),
      }),
      Layer.mock(DesktopShutdown.DesktopShutdown, {
        // Complete after bootstrap; fatal startup still records its own quit.
        awaitRequest: Effect.void,
        request: Effect.void,
        markComplete: Effect.void,
      }),
      Layer.mock(DesktopRendererHistory.DesktopRendererHistory, { shutdown: Effect.void }),
      Layer.mock(DesktopAppActivation.DesktopAppActivation, { start: Effect.void }),
      Layer.mock(DesktopSnapShot.DesktopSnapShot, { initialize: Effect.void }),
      Layer.mock(DesktopWslBackend.DesktopWslBackend, { reconcile: Effect.void }),
      Layer.mock(DesktopShellEnvironment.DesktopShellEnvironment, {
        installIntoProcess: Effect.void,
      }),
      Layer.mock(DesktopLifecycle.DesktopLifecycle, { register: Effect.void }),
      Layer.mock(DesktopClerk.DesktopClerk, {
        isPrimaryInstance: true,
        configure: Effect.void,
      }),
      Layer.mock(DesktopApplicationMenu.DesktopApplicationMenu, { configure: Effect.void }),
      Layer.mock(DesktopUpdates.DesktopUpdates, { configure: Effect.void }),
      Layer.mock(DesktopLinuxUrlHandler.DesktopLinuxUrlHandler, { register: Effect.void }),
      Layer.mock(PreviewPasskeys.PreviewPasskeys, {
        bridgeEnabled: false,
        configure: Effect.void,
        installSessionHandlers: () => {
          throw new Error("Unexpected passkey session setup in bootstrap fixture");
        },
        attachGuest: () => {
          throw new Error("Unexpected passkey guest attachment in bootstrap fixture");
        },
      }),
      Layer.succeed(DesktopPreReadyPlatform.DesktopPreReadyElectronOptions, {
        linux: null,
        linuxPasswordStoreCommandLine: null,
      }),
      // Keep the app's complete typed context. An unexpected use of any service
      // captured by a mocked registrar fails loudly rather than being a no-op.
      Layer.mock(DesktopWindow.DesktopWindow, {}),
      Layer.mock(ElectronSafeStorage.ElectronSafeStorage, {}),
      Layer.mock(DesktopIpc.DesktopIpc, {}),
      Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make(() => Effect.die("Unexpected HTTP request in bootstrap fixture")),
      ),
      Layer.mock(ElectronWindow.ElectronWindow, {}),
      Layer.mock(ElectronMenu.ElectronMenu, {}),
      Layer.mock(ElectronTheme.ElectronTheme, {}),
      Layer.mock(ElectronShell.ElectronShell, {}),
      Layer.mock(DesktopCliCommand.DesktopCliCommand, {}),
      Layer.mock(DesktopVoice.DesktopVoice, {}),
      Layer.mock(DesktopConnectionCatalogStore.DesktopConnectionCatalogStore, {}),
      Layer.mock(DesktopClientSettings.DesktopClientSettings, {}),
      Layer.mock(DesktopLocalEnvironmentAuth.DesktopLocalEnvironmentAuth, {}),
      Layer.mock(DesktopBackendConfiguration.DesktopBackendConfiguration, {}),
      Layer.mock(DesktopWslEnvironment.DesktopWslEnvironment, {}),
      Layer.mock(DesktopSshEnvironment.DesktopSshEnvironment, {}),
      Layer.mock(DesktopSshPasswordPrompts.DesktopSshPasswordPrompts, {}),
      Layer.mock(DesktopTelemetryPublisher.DesktopTelemetryPublisher, {}),
      Layer.mock(PreviewManager.PreviewManager, {
        isBrowserPartition: () => {
          throw new Error("Unexpected browser-partition lookup in bootstrap fixture");
        },
      }),
      Layer.mock(BrowserImport.BrowserImport, {}),
      Layer.mock(MacPermissions.MacPermissions, {}),
      Layer.mock(DesktopWebLinks.DesktopWebLinks, {}),
    );
    const exit = yield* DesktopApp.program.pipe(Effect.provide(services), Effect.exit);
    return {
      environment,
      exit,
      registrations,
      probes,
      configuredPorts,
      userDataPaths,
      fatalErrors,
      backendStarts,
      quitCalls,
    };
  });

const assertSuccessfulStartup = (result: Effect.Success<ReturnType<typeof runStartup>>) => {
  assert.isTrue(Exit.isSuccess(result.exit));
  assert.deepEqual(result.fatalErrors, []);
  assert.equal(result.quitCalls, 0);
  assert.equal(result.backendStarts, 1);
};

const assertBuiltAssets = (result: Effect.Success<ReturnType<typeof runStartup>>) => {
  assert.deepEqual(result.registrations, [
    {
      scheme: ElectronProtocol.getDesktopScheme(result.environment.isDevelopment),
      assetDirectory: result.environment.clientAssetsDir,
      clerkFrontendApiHostname: DesktopClerk.desktopClerkFrontendApiHostname,
    },
  ]);
};

describe("DesktopApp bootstrap renderer and backend selection", () => {
  it.effect("starts an unpackaged built client with development state and a scanned port", () =>
    Effect.gen(function* () {
      const result = yield* runStartup();
      assertSuccessfulStartup(result);
      assertBuiltAssets(result);
      assert.isTrue(result.environment.isDevelopment);
      assert.equal(result.environment.stateDir, "/tmp/scient-bootstrap-fixture/scient-next-dev");
      assert.deepEqual(result.userDataPaths, [
        "/tmp/scient-bootstrap-fixture/scient-next-dev/electron-userdata",
      ]);
      assert.deepEqual(result.probes, [
        { port: 3773, host: "127.0.0.1" },
        { port: 3774, host: "127.0.0.1" },
        { port: 3774, host: "0.0.0.0" },
        { port: 3774, host: "::" },
      ]);
      assert.deepEqual(result.configuredPorts, [3774]);
    }),
  );

  it.effect("uses a configured port for an unpackaged built client without scanning", () =>
    Effect.gen(function* () {
      const result = yield* runStartup({ T3CODE_PORT: "4949" });
      assertSuccessfulStartup(result);
      assertBuiltAssets(result);
      assert.isTrue(result.environment.isDevelopment);
      assert.deepEqual(result.probes, []);
      assert.deepEqual(result.configuredPorts, [4949]);
    }),
  );

  it.effect("keeps Vite forwarding and its matching explicit backend port", () =>
    Effect.gen(function* () {
      const result = yield* runStartup({
        VITE_DEV_SERVER_URL: "http://localhost:5173",
        T3CODE_PORT: "4949",
      });
      assertSuccessfulStartup(result);
      assert.deepEqual(result.registrations, [
        {
          scheme: ElectronProtocol.getDesktopScheme(true),
          targetOrigin: new URL("http://localhost:5173"),
          clerkFrontendApiHostname: DesktopClerk.desktopClerkFrontendApiHostname,
        },
      ]);
      assert.deepEqual(result.probes, []);
      assert.deepEqual(result.configuredPorts, [4949]);
    }),
  );

  it.effect("rejects a Vite launch without an explicit port before starting the backend", () =>
    Effect.gen(function* () {
      const result = yield* runStartup({ VITE_DEV_SERVER_URL: "http://localhost:5173" });
      assert.isTrue(Exit.isFailure(result.exit));
      if (Exit.isFailure(result.exit)) {
        assert.include(
          Cause.pretty(result.exit.cause),
          "DesktopDevelopmentBackendPortRequiredError",
        );
      }
      assert.equal(result.registrations.length, 1);
      assert.deepEqual(result.probes, []);
      assert.deepEqual(result.configuredPorts, []);
      assert.equal(result.backendStarts, 0);
      assert.equal(result.quitCalls, 1);
      assert.equal(result.fatalErrors.length, 1);
      assert.include(result.fatalErrors[0]!, "T3CODE_PORT is required");
    }),
  );

  it.effect("keeps a packaged built client on its packaged identity and native port scan", () =>
    Effect.gen(function* () {
      const result = yield* runStartup({}, true);
      assertSuccessfulStartup(result);
      assertBuiltAssets(result);
      assert.isFalse(result.environment.isDevelopment);
      assert.deepEqual(result.configuredPorts, [3774]);
    }),
  );
});
