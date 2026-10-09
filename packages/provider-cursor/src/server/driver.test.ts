// @effect-diagnostics nodeBuiltinImport:off
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import {
  ProviderDriverKind,
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
import { HttpClient } from "effect/http";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import { HttpClientResponse } from "effect/http";

import * as ProviderEventLoggers from "@t3tools/provider-core/server/ProviderEventLoggers";
import { layerTestProviderHost } from "@t3tools/provider-testing/host";
import { CursorDriver, makeCursorDriver } from "./driver.ts";
import * as CursorAgentSdk from "./CursorAgentSdk.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import { makeProviderMaintenanceCapabilities } from "@t3tools/provider-core/server/maintenanceResolver";
import { Cursor } from "./sdk.ts";
import { CursorSettings } from "../settings.ts";

const decodeCursorSettings = Schema.decodeEffect(CursorSettings);

const testLayer = layerTestProviderHost({ runBackgroundWork: false }).pipe(
  Layer.provideMerge(NodeServices.layer),
  Layer.provideMerge(IdAllocator.layer),
  Layer.provideMerge(
    Layer.mock(CursorAgentSdk.CursorAgentSdkRunner)({
      open: () => Effect.die("Maintenance resolution must not open a Cursor session"),
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
        expect(instance).not.toHaveProperty("managedRuntimeActions");
        expect(instance).not.toHaveProperty("connectionActions");
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
        const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
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

  it.effect.each(
    [false, true].map((enabled) => ({
      caseTitle: `keeps SDK maintenance manual-only with a discoverable CLI (enabled=${enabled})`,
      enabled,
    })),
  )("$caseTitle", ({ enabled }) =>
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

  it.effect("uses the app-supplied resolver for an explicitly configured external CLI", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "scient-cursor-explicit-cli-" });
      const binary = path.join(root, "cursor-agent");
      yield* fs.writeFileString(binary, "#!/bin/sh\nexit 0\n");
      yield* fs.chmod(binary, 0o755);
      const driver = makeCursorDriver({
        resolveRuntime: (input) =>
          Effect.succeed({
            effectiveConfig: input.config,
            effectiveEnvironment: input.processEnv,
            maintenanceResolver: {
              resolve: (context) =>
                Effect.succeed(
                  makeProviderMaintenanceCapabilities({
                    provider: ProviderDriverKind.make("cursor"),
                    packageName: null,
                    updateExecutable: context?.resolvedCommandPath ?? null,
                    updateArgs: ["update"],
                    updateLockKey: context === null ? null : "cursor-agent",
                    ...(context ? { platform: context.platform, env: context.env } : {}),
                  }),
                ),
            },
            composeInstance: (instance) => Effect.succeed(instance),
          }),
      });
      const instance = yield* driver.create({
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

  it.effect("keeps managed install, update, and sign-in actions in host composition", () =>
    Effect.gen(function* () {
      const hostLifecycle = {
        managedRuntimeActions: {
          install: "managed-runtime-catalog.install",
          update: "managed-runtime-catalog.update",
          remove: "managed-runtime-catalog.remove",
        },
        connectionActions: {
          signIn: "provider-lifecycle.sign-in",
        },
      } as const;
      let observedRuntimeInput:
        | {
            readonly instanceId: string;
            readonly processPath: string | undefined;
            readonly baseDir: string;
          }
        | undefined;
      const driver = makeCursorDriver<never, typeof hostLifecycle>({
        resolveRuntime: (input) => {
          observedRuntimeInput = {
            instanceId: input.instanceId,
            processPath: input.processEnv.PATH,
            baseDir: input.baseDir,
          };
          return Effect.succeed({
            effectiveConfig: { ...input.config, binaryPath: "/managed/cursor-agent" },
            effectiveEnvironment: {
              ...input.processEnv,
              SCIENT_MANAGED_CURSOR_RUNTIME: "1",
            },
            composeInstance: (instance) => Effect.succeed({ ...instance, ...hostLifecycle }),
          });
        },
      });
      const instance = yield* driver.create({
        instanceId: ProviderInstanceId.make("cursor-host-managed-lifecycle"),
        displayName: "Managed Cursor",
        enabled: false,
        environment: [{ name: "PATH", value: "/instance/bin", sensitive: false }],
        config: CursorDriver.defaultConfig(),
      });

      expect(observedRuntimeInput).toMatchObject({
        instanceId: "cursor-host-managed-lifecycle",
        processPath: "/instance/bin",
      });
      expect(observedRuntimeInput?.baseDir).toBeTruthy();
      expect(instance.managedRuntimeActions).toBe(hostLifecycle.managedRuntimeActions);
      expect(instance.connectionActions).toBe(hostLifecycle.connectionActions);
      expect((yield* instance.snapshot.getSnapshot).setup?.canInstall).toBe(false);
    }).pipe(Effect.scoped),
  );
});
