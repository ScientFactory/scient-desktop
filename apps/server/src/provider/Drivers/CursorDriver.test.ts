// @effect-diagnostics nodeBuiltinImport:off
import * as ServerSecretStore from "../../auth/ServerSecretStore.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import {
  CursorSettings,
  ProviderInstanceId,
  ProviderSessionId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as Schema from "effect/Schema";
import { vi } from "vite-plus/test";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

import * as BackgroundPolicy from "../../background/BackgroundPolicy.ts";
import * as ServerConfig from "../../config.ts";
import * as ServerSettings from "../../serverSettings.ts";
import * as ProviderEventLoggers from "../Layers/ProviderEventLoggers.ts";
import { CursorDriver, assistedCursorConnectionMethods } from "./CursorDriver.ts";
import * as CursorAgentSdk from "../../orchestration-v2/Adapters/CursorAgentSdk.ts";
import { ProviderAdapterV2RuntimePolicy } from "../../orchestration-v2/ProviderAdapter.ts";
import * as IdAllocator from "../../orchestration-v2/IdAllocator.ts";
import { Cursor } from "../cursorSdk.ts";

const decodeCursorSettings = Schema.decodeEffect(CursorSettings);

const testLayer = ServerSecretStore.layer.pipe(
  Layer.provideMerge(
    ServerConfig.layerTest(process.cwd(), {
      prefix: "t3-cursor-driver-copy-command-",
    }),
  ),
  Layer.provideMerge(NodeServices.layer),
  Layer.provideMerge(IdAllocator.layer),
  Layer.provideMerge(
    Layer.mock(CursorAgentSdk.CursorAgentSdkRunner)({
      open: () => Effect.die("Maintenance resolution must not open a Cursor session"),
    }),
  ),
  Layer.provideMerge(ServerSettings.layerTest()),
  Layer.provideMerge(
    Layer.mock(BackgroundPolicy.BackgroundPolicy)({
      shouldRunScopeWork: () => Effect.succeed(false),
    }),
  ),
  Layer.provideMerge(
    Layer.succeed(
      ProviderEventLoggers.ProviderEventLoggers,
      ProviderEventLoggers.NoOpProviderEventLoggers,
    ),
  ),
  Layer.provideMerge(
    Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make(() => Effect.die("Disabled Cursor must not make an HTTP request")),
    ),
  ),
);

it.layer(testLayer)("CursorDriver", (it) => {
  it.effect(
    "preserves SDK browser auth with legacy CLI settings and closes the session on logout",
    () =>
      Effect.gen(function* () {
        const login = vi.spyOn(Cursor.auth, "login").mockImplementation(async (options) => {
          options?.onLoginUrl?.("https://cursor.com/loginDeepControl?challenge=test-only");
          await options?.store?.save({
            version: 1,
            backendUrl: "https://api2.cursor.sh",
            apiKey: "instance-browser-key",
            createdAtMs: 0,
            apiKeyExpiresAtMs: 4_000_000_000_000,
            email: "cursor@example.com",
          });
          return { apiKey: "instance-browser-key", apiKeyExpiresAtMs: 4_000_000_000_000 };
        });
        const me = vi.spyOn(Cursor, "me").mockResolvedValue({
          apiKeyName: "T3 Code",
          createdAt: "2026-01-01T00:00:00.000Z",
          userEmail: "cursor@example.com",
        });
        const models = vi
          .spyOn(Cursor.models, "list")
          .mockResolvedValue([{ id: "auto", displayName: "Auto" }]);
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            login.mockRestore();
            me.mockRestore();
            models.mockRestore();
          }),
        );
        const fs = yield* FileSystem.FileSystem;
        const home = yield* fs.makeTempDirectoryScoped({ prefix: "scient-cursor-browser-" });
        const input = {
          instanceId: ProviderInstanceId.make("cursor-browser-persisted"),
          displayName: "Personal Cursor",
          enabled: true,
          environment: [
            { name: "CURSOR_API_KEY", value: "", sensitive: true },
            { name: "CURSOR_AUTH_TOKEN", value: "synthetic-legacy-cli-token", sensitive: true },
            { name: "PATH", value: "", sensitive: false },
            { name: "HOME", value: home, sensitive: false },
          ],
          config: { ...CursorDriver.defaultConfig(), apiEndpoint: "https://cli.example.test" },
        };
        const openedKeys: Array<string | undefined> = [];
        let closed = 0;
        const create = CursorDriver.create(input).pipe(
          Effect.provideService(CursorAgentSdk.CursorAgentSdkRunner, {
            assertComplete: Effect.void,
            open: (request) =>
              Effect.sync(() => {
                openedKeys.push(request.options.apiKey);
                return {
                  agentId: "browser-auth-agent",
                  listMessages: Effect.succeed([]),
                  send: () => Effect.die("This test only opens a session"),
                  close: Effect.sync(() => {
                    closed += 1;
                  }),
                };
              }),
          }),
          Effect.provideService(
            HttpClient.HttpClient,
            HttpClient.make((request) => {
              expect(request.url).toBe(
                "https://cli.example.test/aiserver.v1.DashboardService/GetCurrentPeriodUsage",
              );
              expect(request.headers.authorization).toBe("Bearer synthetic-legacy-cli-token");
              return Effect.succeed(
                HttpClientResponse.fromWeb(
                  request,
                  Response.json({ planUsage: { totalPercentUsed: 10 } }),
                ),
              );
            }),
          ),
        );
        const instance = yield* create;
        expect((yield* instance.snapshot.refresh).auth.status).toBe("unauthenticated");
        yield* instance.auth!.start("client");
        const terminal = yield* instance.auth!.subscribe("client").pipe(
          Stream.filter((state) => state.phase === "succeeded" || state.phase === "failed"),
          Stream.runHead,
          Effect.map(Option.getOrThrow),
        );
        expect(terminal.phase).toBe("succeeded");
        expect(me).toHaveBeenCalledWith({ apiKey: "instance-browser-key" });
        expect(yield* instance.snapshot.getSnapshot).toMatchObject({
          status: "ready",
          auth: {
            status: "authenticated",
            type: "browser",
            canLogout: true,
            email: "cursor@example.com",
          },
          setup: { canAuthenticate: true, canInstall: false },
        });
        const threadId = ThreadId.make("cursor-browser-thread");
        const modelSelection = { instanceId: input.instanceId, model: "auto" };
        const runtimePolicy = ProviderAdapterV2RuntimePolicy.make({
          runtimeMode: "full-access",
          interactionMode: "default",
          cwd: process.cwd(),
        });
        const runtime = yield* instance.orchestrationAdapter.openSession({
          threadId,
          providerSessionId: ProviderSessionId.make("cursor-browser-session"),
          modelSelection,
          runtimePolicy,
        });
        yield* runtime.ensureThread({ threadId, modelSelection, runtimePolicy });
        expect(openedKeys).toEqual(["instance-browser-key"]);
        expect(closed).toBe(0);
        const recreated = yield* create;
        expect((yield* recreated.snapshot.refresh).auth.status).toBe("authenticated");
        yield* instance.auth!.logout(Effect.void);
        expect(closed).toBe(1);
        expect((yield* instance.snapshot.getSnapshot).auth.status).toBe("unauthenticated");
        expect((yield* recreated.snapshot.refresh).auth.status).toBe("unauthenticated");
        expect(
          (yield* Effect.exit(runtime.ensureThread({ threadId, modelSelection, runtimePolicy })))
            ._tag,
        ).toBe("Failure");
        expect(openedKeys).toEqual(["instance-browser-key"]);
        expect(closed).toBe(1);
      }).pipe(Effect.scoped),
  );

  for (const enabled of [false, true]) {
    it.effect(
      `keeps SDK maintenance manual-only with a discoverable CLI (enabled=${enabled})`,
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const root = yield* fs.makeTempDirectoryScoped({
            prefix: "scient-cursor-sdk-maintenance-",
          });
          const binary = path.join(root, "cursor-agent");
          yield* fs.writeFileString(binary, "#!/bin/sh\nprintf 'Cursor Agent 2026.10.01\\n'\n");
          yield* fs.chmod(binary, 0o755);
          const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
          let resolvingMaintenance = false;
          const guardedSpawner = ChildProcessSpawner.make((command) =>
            Effect.suspend(() =>
              resolvingMaintenance
                ? Effect.die("SDK maintenance must not spawn a process")
                : spawner.spawn(command),
            ),
          );
          const instance = yield* CursorDriver.create({
            instanceId: ProviderInstanceId.make(`cursor-sdk-${enabled}`),
            displayName: "Cursor test",
            enabled,
            environment: [
              { name: "PATH", value: root, sensitive: false },
              { name: "HOME", value: root, sensitive: false },
            ],
            config: CursorDriver.defaultConfig(),
          }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, guardedSpawner));
          resolvingMaintenance = true;
          const maintenance = yield* instance.snapshot.resolveMaintenance();
          expect(maintenance.update).toBeNull();
          if (!enabled) expect((yield* instance.snapshot.refresh).status).toBe("disabled");
        }).pipe(Effect.scoped),
    );
  }

  it.effect("retains maintenance for an explicitly configured external CLI", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "scient-cursor-explicit-cli-" });
      const binary = path.join(root, "cursor-agent");
      yield* fs.writeFileString(binary, "#!/bin/sh\nexit 0\n");
      yield* fs.chmod(binary, 0o755);
      const instance = yield* CursorDriver.create({
        instanceId: ProviderInstanceId.make("cursor-explicit-cli"),
        displayName: "External Cursor CLI",
        enabled: false,
        environment: [{ name: "PATH", value: root, sensitive: false }],
        config: yield* decodeCursorSettings({ binaryPath: binary }),
      });
      expect((yield* instance.snapshot.resolveMaintenance()).update).toMatchObject({
        executable: binary,
        args: ["update"],
        lockKey: "cursor-agent",
      });
    }).pipe(Effect.scoped),
  );
});

describe("CursorDriver assisted account boundary", () => {
  it("offers the official browser subscription flow without an SDK API key", () => {
    expect(assistedCursorConnectionMethods({})).toEqual(["cursor_browser"]);
    expect(assistedCursorConnectionMethods({ CURSOR_API_KEY: " " })).toEqual(["cursor_browser"]);
    expect(assistedCursorConnectionMethods({ CURSOR_AUTH_TOKEN: "legacy-cli-token" })).toEqual([
      "cursor_browser",
    ]);
  });

  it("preserves explicit SDK API-key ownership", () => {
    expect(assistedCursorConnectionMethods({ CURSOR_API_KEY: "configured" })).toEqual([]);
  });
});
