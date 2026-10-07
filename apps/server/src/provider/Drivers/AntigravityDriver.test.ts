import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  ANTIGRAVITY_DEFAULT_MODEL,
  EnvironmentId,
  MessageId,
  NodeId,
  ProjectId,
  ProviderSessionId,
  RunAttemptId,
  RunId,
  ThreadId,
  ProviderDriverKind,
  ProviderInstanceId,
  type AntigravitySettings,
} from "@t3tools/contracts";
import {
  HostProcessEnvironment,
  HostProcessExecutablePath,
  HostProcessIsExecutable,
  HostProcessPlatform,
} from "@t3tools/shared/hostProcess";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import { HttpClient, HttpClientResponse } from "effect/http";

import * as BackgroundPolicy from "../../background/BackgroundPolicy.ts";
import * as ServerConfig from "../../config.ts";
import * as ServerSettings from "../../serverSettings.ts";
import * as AntigravityInstallation from "../AntigravityInstallation.ts";
import {
  ANTIGRAVITY_AUTH_STDOUT_PREFIX,
  resolveAntigravityInstanceDirectories,
} from "../antigravityAuthSupport.ts";
import * as ProviderEventLoggers from "../ProviderEventLoggers.ts";
import * as ModelManifest from "../ModelManifest.ts";
import * as PtyAdapter from "../../terminal/PtyAdapter.ts";
import * as IdAllocator from "../../orchestration-v2/IdAllocator.ts";
import * as McpProviderSession from "../../mcp/McpProviderSession.ts";
import { AntigravityDriver, usesLegacyAntigravityBackend } from "./AntigravityDriver.ts";
import { bundledAntigravityAcpAsset } from "../../scient/providerLifecycle/antigravityAcpCatalog.ts";

const hostPlatform = HostProcessPlatform.defaultValue();
const windowsHost = hostPlatform === "win32";
const decodeRequest = Schema.decodeEffect(
  Schema.fromJsonString(
    Schema.Struct({
      method: Schema.optional(Schema.String),
      params: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
    }),
  ),
);
const blockedCredentialKeys = new Set([
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
  "GOOGLE_APPLICATION_CREDENTIALS",
  "GOOGLE_GENAI_USE_VERTEXAI",
]);

it("selects legacy agy only when explicitly configured or no official ACP asset exists", () => {
  expect(
    usesLegacyAntigravityBackend({
      binaryPath: "/opt/legacy/agy",
      platform: "darwin",
      arch: "arm64",
    }),
  ).toBe(true);
  expect(
    usesLegacyAntigravityBackend({
      binaryPath: "/opt/scient/provider-runtimes/antigravity/1.1.22/antigravity",
      platform: "darwin",
      arch: "arm64",
    }),
  ).toBe(true);
  expect(
    usesLegacyAntigravityBackend({
      binaryPath: "/opt/antigravity/agy_acp_server.par",
      platform: "darwin",
      arch: "arm64",
    }),
  ).toBe(false);
  expect(usesLegacyAntigravityBackend({ binaryPath: "", platform: "darwin", arch: "x64" })).toBe(
    true,
  );
  expect(usesLegacyAntigravityBackend({ binaryPath: "", platform: "linux", arch: "x64" })).toBe(
    false,
  );
});

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

const makeHarness = Effect.fn("makeAntigravityDriverHarness")(function* (
  options: { readonly config?: Partial<AntigravitySettings>; readonly enabled?: boolean } = {},
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig.ServerConfig;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const nodePath = yield* HostProcessExecutablePath;
  const baseEnv = yield* HostProcessEnvironment;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-antigravity-driver-" });
  const instanceId = ProviderInstanceId.make(path.basename(root));
  const mockAgentPath = yield* path.fromFileUrl(
    new URL("../../../scripts/acp-mock-agent.ts", import.meta.url),
  );
  const requestLog = path.join(root, "requests.jsonl");
  const directories = yield* resolveAntigravityInstanceDirectories(config.stateDir, instanceId);
  const profileDirectory = directories.profile;
  const instancePath = `${path.join(root, "instance-bin")}:${baseEnv.PATH ?? ""}`;

  const makeExecutable = Effect.fn("AntigravityDriverTest.makeExecutable")(function* (
    name: string,
    loginRequired = false,
    stalled = false,
  ) {
    const directory = path.join(root, name);
    const executablePath = path.join(directory, "agy_acp_server.par");
    const harnessPath = path.join(directory, "localharness_external");
    yield* fs.makeDirectory(directory, { recursive: true });
    const authorizationUrl =
      "https://accounts.google.com/o/oauth2/v2/auth?response_type=code&redirect_uri=http%3A%2F%2F127.0.0.1%3A51234%2F&state=fixture-state";
    yield* fs.writeFileString(
      executablePath,
      [
        "#!/bin/sh",
        ...(loginRequired
          ? [`printf '%s\\n' ${shellQuote(ANTIGRAVITY_AUTH_STDOUT_PREFIX + authorizationUrl)}`]
          : []),
        stalled
          ? `exec ${shellQuote(nodePath)} -e 'process.stdin.resume()'`
          : `exec ${shellQuote(nodePath)} ${shellQuote(mockAgentPath)} "$@"`,
        "",
      ].join("\n"),
    );
    yield* fs.writeFileString(harnessPath, "#!/bin/sh\nexit 99\n");
    yield* fs.chmod(executablePath, 0o755);
    yield* fs.chmod(harnessPath, 0o755);
    return {
      executablePath,
      harnessPath,
      source: "managed",
      version: name,
      managedVersionDirectory: directory,
    } satisfies AntigravityInstallation.AntigravityExecutable;
  });

  const first = yield* makeExecutable("runtime 'one");
  const second = yield* makeExecutable("runtime two");
  const signedOut = yield* makeExecutable("runtime signed-out", true);
  const waiting = yield* makeExecutable("runtime waiting", true, true);
  const stalled = yield* makeExecutable("runtime stalled", false, true);
  const controls = {
    selected: first,
    failResolution: false,
    beforeAcquire: Effect.void,
    beforeSpawn: Effect.void,
    afterSpawn: Effect.void,
    beforeRelease: Effect.void,
  };
  const acquisitions: Array<{ binaryPath: string | undefined; path: string | undefined }> = [];
  const releases: Array<string | null> = [];
  const launches: Array<{
    command: string;
    args: ReadonlyArray<string>;
    cwd: string | undefined;
    extendEnv: boolean | undefined;
    profileDirectory: string | undefined;
    harnessPath: string | undefined;
    forceFileStorage: string | undefined;
    credentialKeys: ReadonlyArray<string>;
    geminiApiKey: string | undefined;
    tempDirectory: string | undefined;
    handle: ChildProcessSpawner.ChildProcessHandle;
  }> = [];

  const resolveSelected = Effect.fn("AntigravityDriverTest.resolveSelected")(function* () {
    if (controls.failResolution) {
      return yield* new AntigravityInstallation.AntigravityInstallationError({
        operation: "resolve",
        detail: "Fixture resolution failed.",
      });
    }
    return controls.selected;
  });
  const installation = Layer.succeed(
    AntigravityInstallation.AntigravityInstallation,
    AntigravityInstallation.AntigravityInstallation.of({
      managedDirectory: root,
      latestRelease: Effect.succeed(bundledAntigravityAcpAsset("linux", "x64")),
      refreshLatestRelease: Effect.succeed(bundledAntigravityAcpAsset("linux", "x64")),
      resolve: () => resolveSelected(),
      acquire: (binaryPath, environment) =>
        Effect.gen(function* () {
          acquisitions.push({ binaryPath, path: environment?.PATH });
          yield* controls.beforeAcquire;
          const selected = yield* resolveSelected();
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => {
              releases.push(selected.version);
            }).pipe(Effect.andThen(Effect.suspend(() => controls.beforeRelease))),
          );
          return selected;
        }),
      state: Effect.sync(() => ({
        driver: ProviderDriverKind.make("antigravity"),
        operationId: null,
        phase: "idle" as const,
        downloadedBytes: 0,
        totalBytes: null,
        version: controls.selected.version,
        installedVersion: controls.selected.version,
        canRemove: true,
        message: null,
      })),
      changes: Stream.empty,
      start: Effect.die("Installation must not start in driver tests"),
      startRelease: () => Effect.die("Installation must not start in driver tests"),
      cancel: () => Effect.die("Installation must not cancel in driver tests"),
      remove: () => Effect.die("Installation must not remove in driver tests"),
    }),
  );
  const observedSpawner = ChildProcessSpawner.make((command) =>
    Effect.gen(function* () {
      if (command._tag !== "StandardCommand")
        return yield* Effect.die("Unexpected process pipeline.");
      yield* controls.beforeSpawn;
      const handle = yield* spawner.spawn(command);
      const environment = command.options.env ?? {};
      launches.push({
        command: command.command,
        args: command.args,
        cwd: command.options.cwd,
        extendEnv: command.options.extendEnv,
        profileDirectory: environment.GEMINI_HOME,
        harnessPath: environment.ANTIGRAVITY_HARNESS_PATH,
        forceFileStorage: environment.AGY_ACP_FORCE_FILE_STORAGE,
        credentialKeys: Object.keys(environment).filter((key) =>
          blockedCredentialKeys.has(key.toUpperCase()),
        ),
        geminiApiKey: environment.GEMINI_API_KEY,
        // Only the agent gets a per-process temp directory. Other launches
        // inherit the host TMPDIR.
        tempDirectory:
          environment.ANTIGRAVITY_HARNESS_PATH === undefined ? undefined : environment.TMPDIR,
        handle,
      });
      if (environment.ANTIGRAVITY_HARNESS_PATH !== undefined) yield* controls.afterSpawn;
      return handle;
    }),
  );
  const instance = yield* AntigravityDriver.create({
    instanceId,
    displayName: "Google test account",
    enabled: options.enabled ?? false,
    config: { ...AntigravityDriver.defaultConfig(), ...options.config },
    environment: [
      { name: "PATH", value: instancePath },
      { name: "T3_ACP_ANTIGRAVITY", value: "1" },
      { name: "T3_ACP_REQUEST_LOG_PATH", value: requestLog },
      { name: "GEMINI_API_KEY", value: "must-not-be-used" },
      { name: "google_api_key", value: "must-not-be-used" },
      { name: "GOOGLE_APPLICATION_CREDENTIALS", value: "/must-not-be-used.json" },
      { name: "GOOGLE_GENAI_USE_VERTEXAI", value: "true" },
      { name: "GEMINI_HOME", value: "/must-not-be-used" },
      { name: "ANTIGRAVITY_HARNESS_PATH", value: "/must-not-be-used" },
      { name: "BROWSER", value: "must-not-run" },
    ].map((variable) => ({ ...variable, sensitive: false })),
  }).pipe(
    Effect.provide(installation),
    Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, observedSpawner),
  );
  const refresh = instance.refreshModels;
  if (!refresh) return yield* Effect.die("Antigravity does not expose model refresh.");
  const readRequests = Effect.gen(function* () {
    if (!(yield* fs.exists(requestLog))) return [];
    const text = yield* fs.readFileString(requestLog);
    return yield* Effect.forEach(text.split(/\r?\n/u).filter(Boolean), (line) =>
      decodeRequest(line),
    );
  });
  const assertClosed = Effect.gen(function* () {
    for (const launch of launches) {
      // Cancelled startup can report a signal instead of a numeric exit code.
      yield* launch.handle.exitCode.pipe(Effect.ignore);
      expect(yield* launch.handle.isRunning).toBe(false);
      if (launch.cwd) expect(yield* fs.exists(launch.cwd)).toBe(false);
      if (launch.tempDirectory) expect(yield* fs.exists(launch.tempDirectory)).toBe(false);
    }
  });
  return {
    instance,
    refresh,
    fs,
    path,
    profileDirectory,
    directories,
    instancePath,
    first,
    second,
    signedOut,
    waiting,
    stalled,
    controls,
    acquisitions,
    releases,
    launches,
    readRequests,
    assertClosed,
  };
});

type DriverHarness = Effect.Success<ReturnType<typeof makeHarness>>;

const nativeLaunches = (h: DriverHarness) =>
  h.launches.filter((launch) => launch.harnessPath !== undefined);

const actionsFor = (h: DriverHarness) => {
  if (!h.instance.connectionActions || !h.instance.auth) {
    throw new Error(
      "The actual Antigravity factory must expose native auth and lifecycle actions.",
    );
  }
  return { actions: h.instance.connectionActions, auth: h.instance.auth };
};

// Only child-owned extraction files close here. Workspace and manager/MCP
// lifetimes stay owned by their caller; a native turn can respawn after sign-in.
const assertProcessesClosed = Effect.fn("assertAntigravityProcessesClosed")(function* (
  h: DriverHarness,
  launches: ReadonlyArray<DriverHarness["launches"][number]> = h.launches,
) {
  for (const launch of launches) {
    yield* launch.handle.exitCode.pipe(Effect.ignore);
    expect(yield* launch.handle.isRunning).toBe(false);
    if (launch.tempDirectory) expect(yield* h.fs.exists(launch.tempDirectory)).toBe(false);
  }
}, Effect.orDie);

const openNative = Effect.fn("openFactoryAntigravityNative")(function* (
  h: DriverHarness,
  suffix = "initial",
) {
  const cwd = yield* h.fs.makeTempDirectoryScoped({ prefix: "t3-antigravity-native-" });
  const threadId = ThreadId.make(`${h.instance.instanceId}:${suffix}`);
  const modelSelection = { instanceId: h.instance.instanceId, model: "gemini-test-low" };
  const runtimePolicy = { runtimeMode: "full-access", interactionMode: "default", cwd } as const;
  const mcp = {
    environmentId: EnvironmentId.make("antigravity-callback-fixture"),
    threadId,
    providerSessionId: `${threadId}:mcp`,
    providerInstanceId: h.instance.instanceId,
    endpoint: "http://127.0.0.1:43123/mcp",
    authorizationHeader: `Bearer synthetic:${threadId}`,
    capabilities: new Set(["threads:read"] as const),
  };
  yield* Effect.acquireRelease(
    Effect.sync(() => McpProviderSession.setMcpProviderSession(mcp)),
    () => Effect.sync(() => McpProviderSession.clearMcpProviderSession(threadId)),
  );
  const session = yield* h.instance.orchestrationAdapter.openSession({
    threadId,
    providerSessionId: ProviderSessionId.make(`${threadId}:native`),
    modelSelection,
    runtimePolicy,
  });
  const providerThread = yield* session.ensureThread({ threadId, modelSelection, runtimePolicy });
  const turn = Effect.fn("turnFactoryAntigravityNative")(function* (ordinal: number) {
    const now = yield* DateTime.now;
    yield* session.startTurn({
      appThread: {
        createdBy: "user",
        creationSource: "web",
        id: threadId,
        projectId: ProjectId.make("antigravity-callback-fixture"),
        title: "Native auth callback fixture",
        providerInstanceId: h.instance.instanceId,
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: cwd,
        activeProviderThreadId: providerThread.id,
        lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
        forkedFrom: null,
        createdAt: now,
        updatedAt: now,
        archivedAt: null,
        settledOverride: null,
        settledAt: null,
        lastVisitedAt: null,
        deletedAt: null,
      },
      threadId,
      runId: RunId.make(`${threadId}:run:${ordinal}`),
      runOrdinal: ordinal,
      providerTurnOrdinal: ordinal,
      attemptId: RunAttemptId.make(`${threadId}:attempt:${ordinal}`),
      rootNodeId: NodeId.make(`${threadId}:node:${ordinal}`),
      providerThread,
      message: {
        createdBy: "user",
        creationSource: "web",
        messageId: MessageId.make(`${threadId}:message:${ordinal}`),
        text: "Prove the current native process can answer.",
        attachments: [],
      },
      modelSelection,
      runtimePolicy,
    });
    const terminal = yield* session.events.pipe(
      Stream.filter(
        (event) =>
          event.type === "provider_turn.updated" &&
          event.providerTurn.ordinal === ordinal &&
          event.providerTurn.status !== "running" &&
          event.providerTurn.status !== "pending",
      ),
      Stream.runHead,
      Effect.map(Option.getOrThrow),
    );
    if (terminal.type !== "provider_turn.updated")
      return yield* Effect.die("Missing native terminal");
    expect(terminal.providerTurn.status).toBe("completed");
  });
  return { session, threadId, mcp, turn };
});

const testLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: "t3-antigravity-driver-config-",
}).pipe(
  Layer.provideMerge(NodeServices.layer),
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
  Layer.provideMerge(ModelManifest.layerTest),
  Layer.provideMerge(
    Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make((request) =>
        Effect.succeed(HttpClientResponse.fromWeb(request, Response.json({ version: "0.0.0" }))),
      ),
    ),
  ),
  Layer.provideMerge(
    Layer.succeed(
      PtyAdapter.PtyAdapter,
      PtyAdapter.PtyAdapter.of({
        spawn: () => Effect.die("Legacy Antigravity must remain lazy in ACP driver tests"),
      }),
    ),
  ),
  Layer.provideMerge(IdAllocator.layer),
);

it.layer(testLayer)("AntigravityDriver", (it) => {
  it.effect.skipIf(windowsHost)(
    "awaits native target teardown before sign-in and logout while a peer survives and a turn respawns",
    () =>
      Effect.gen(function* () {
        const target = yield* makeHarness();
        const peer = yield* makeHarness();
        const targetNative = yield* openNative(target);
        const peerNative = yield* openNative(peer);
        for (const [h, native] of [
          [target, targetNative],
          [peer, peerNative],
        ] as const) {
          const create = (yield* h.readRequests).find(
            (request) => request.method === "session/new",
          );
          expect(create?.params?.mcpServers).toEqual([
            expect.objectContaining({
              name: "scient",
              env: expect.arrayContaining([
                { name: "T3_ACP_MCP_ENDPOINT", value: native.mcp.endpoint },
                { name: "T3_ACP_MCP_AUTHORIZATION", value: native.mcp.authorizationHeader },
              ]),
            }),
          ]);
        }
        yield* targetNative.turn(1);
        const beforeSignIn = (yield* target.readRequests).length;
        const oldLaunches = [...nativeLaunches(target)];
        for (const launch of oldLaunches) {
          if (launch.tempDirectory) {
            yield* target.fs.writeFileString(
              target.path.join(launch.tempDirectory, "owned.bin"),
              "fixture",
            );
          }
        }
        const { actions } = actionsFor(target);
        let authSpawnObserved = false;
        target.controls.beforeSpawn = Effect.gen(function* () {
          yield* assertProcessesClosed(target, oldLaunches);
          for (const launch of nativeLaunches(peer))
            expect(yield* launch.handle.isRunning).toBe(true);
          expect(McpProviderSession.readMcpProviderSession(peerNative.threadId)).toEqual(
            peerNative.mcp,
          );
          authSpawnObserved = true;
        }).pipe(Effect.orDie);
        const connection = yield* actions.start("antigravity_google");
        yield* connection.waitForCompletion;
        expect(authSpawnObserved).toBe(true);
        const signInRequests = (yield* target.readRequests).slice(beforeSignIn);
        expect(signInRequests.map((request) => request.method)).toContain("auth/login");
        expect(signInRequests.map((request) => request.method)).toContain("session/new");
        expect(
          signInRequests.find((request) => request.method === "session/new")?.params?.mcpServers,
        ).toEqual([]);
        expect((yield* target.instance.snapshot.getSnapshot).auth.status).toBe("authenticated");
        yield* assertProcessesClosed(target);

        target.controls.beforeSpawn = Effect.void;
        yield* targetNative.turn(2);
        expect(nativeLaunches(target)).toHaveLength(oldLaunches.length + 2);
        expect(yield* nativeLaunches(target).at(-1)!.handle.isRunning).toBe(true);
        const reopened = [...nativeLaunches(target)];
        let logoutSpawnObserved = false;
        target.controls.beforeSpawn = Effect.gen(function* () {
          yield* assertProcessesClosed(target, reopened);
          for (const launch of nativeLaunches(peer))
            expect(yield* launch.handle.isRunning).toBe(true);
          expect(McpProviderSession.readMcpProviderSession(targetNative.threadId)).toEqual(
            targetNative.mcp,
          );
          logoutSpawnObserved = true;
        }).pipe(Effect.orDie);
        const beforeLogout = (yield* target.readRequests).length;
        yield* actions.disconnect;
        expect(logoutSpawnObserved).toBe(true);
        expect(
          (yield* target.readRequests).slice(beforeLogout).map((request) => request.method),
        ).toEqual(["initialize", "auth/logout"]);
        const signedOut = yield* target.instance.snapshot.getSnapshot;
        expect(signedOut.auth.status).toBe("unauthenticated");
        expect(signedOut.models).toEqual([]);
        yield* assertProcessesClosed(target);
        yield* peerNative.turn(1);
        expect(nativeLaunches(peer)).toHaveLength(1);
        expect(McpProviderSession.readMcpProviderSession(peerNative.threadId)).toEqual(
          peerNative.mcp,
        );
      }).pipe(Effect.scoped),
  );

  for (const startupKind of ["native", "generation", "refresh"] as const) {
    for (const operation of ["sign-in", "logout"] as const) {
      it.effect.skipIf(windowsHost)(
        `${operation} interrupts registered ${startupKind} startup and refuses every competing factory launch`,
        () =>
          Effect.gen(function* () {
            const h = yield* makeHarness();
            const { actions } = actionsFor(h);
            const entered = yield* Deferred.make<void>();
            const lateRelease = yield* Deferred.make<void>();
            const authEntered = yield* Deferred.make<void>();
            const authRelease = yield* Deferred.make<void>();
            yield* Effect.addFinalizer(() => Deferred.succeed(lateRelease, undefined));
            yield* Effect.addFinalizer(() => Deferred.succeed(authRelease, undefined));
            let acquisitions = 0;
            h.controls.beforeAcquire = Effect.suspend(() =>
              ++acquisitions === 1
                ? Deferred.succeed(entered, undefined).pipe(
                    Effect.andThen(Deferred.await(lateRelease)),
                  )
                : Deferred.succeed(authEntered, undefined).pipe(
                    Effect.andThen(Deferred.await(authRelease)),
                  ),
            );
            const generate = h.instance.textGeneration.generateThreadTitle({
              cwd: h.profileDirectory,
              message: "Registered helper startup",
              modelSelection: { instanceId: h.instance.instanceId, model: "gemini-test-low" },
            });
            const pending = yield* Effect.gen(function* () {
              if (startupKind === "native") yield* openNative(h);
              else if (startupKind === "generation") yield* generate;
              else yield* h.refresh();
            }).pipe(Effect.exit, Effect.forkScoped);
            yield* Deferred.await(entered);
            const credential = yield* (
              operation === "sign-in"
                ? actions
                    .start("antigravity_google")
                    .pipe(Effect.flatMap((connection) => connection.waitForCompletion))
                : actions.disconnect
            ).pipe(Effect.exit, Effect.forkScoped);
            yield* Deferred.await(authEntered);
            const interrupted = yield* Fiber.join(pending);
            expect(Exit.isFailure(interrupted)).toBe(true);
            const deniedNative = yield* openNative(h, "denied").pipe(Effect.exit);
            const deniedGeneration = yield* generate.pipe(Effect.exit);
            const deniedRefresh = yield* h.refresh().pipe(Effect.exit);
            expect(Exit.isFailure(deniedNative)).toBe(true);
            expect(Exit.isFailure(deniedGeneration)).toBe(true);
            expect(Exit.isFailure(deniedRefresh)).toBe(true);
            expect(h.acquisitions).toHaveLength(2);
            expect(nativeLaunches(h)).toEqual([]);
            yield* Deferred.succeed(lateRelease, undefined);
            yield* Deferred.succeed(authRelease, undefined);
            const credentialResult = yield* Fiber.join(credential);
            if (Exit.isFailure(credentialResult)) return yield* credentialResult;
            expect(Exit.isSuccess(credentialResult)).toBe(true);
            expect(h.acquisitions).toHaveLength(2);
            expect(nativeLaunches(h)).toHaveLength(1);
            const requests = yield* h.readRequests;
            expect(requests.map((request) => request.method)).toEqual(
              operation === "sign-in"
                ? ["initialize", "auth/login", "session/new"]
                : ["initialize", "auth/logout"],
            );
            h.controls.beforeAcquire = Effect.void;
            yield* h.refresh();
            expect(nativeLaunches(h)).toHaveLength(2);
            yield* assertProcessesClosed(h);
          }).pipe(Effect.scoped),
      );
    }
  }

  for (const operation of ["sign-in", "logout"] as const) {
    it.effect.skipIf(windowsHost)(
      `${operation} refuses credential mutation after defective native teardown without clearing the catalog`,
      () =>
        Effect.gen(function* () {
          const h = yield* makeHarness();
          const peer = yield* makeHarness();
          yield* openNative(h);
          const peerNative = yield* openNative(peer);
          const before = yield* h.instance.snapshot.getSnapshot;
          const requestsBefore = yield* h.readRequests;
          h.controls.beforeRelease = Effect.die("Fixture owned installation lease close failed");
          const { actions } = actionsFor(h);
          const result = yield* (
            operation === "sign-in"
              ? actions
                  .start("antigravity_google")
                  .pipe(Effect.flatMap((connection) => connection.waitForCompletion))
              : actions.disconnect
          ).pipe(Effect.result);
          expect(result._tag).toBe("Failure");
          if (result._tag === "Failure") {
            expect(result.failure.message).toContain("could not stop active Antigravity sessions");
            if (operation === "logout")
              expect(result.failure.cause).toMatchObject({ operation: "stopSessions" });
          }
          expect(yield* h.readRequests).toEqual(requestsBefore);
          expect(nativeLaunches(h)).toHaveLength(1);
          yield* assertProcessesClosed(h);
          const after = yield* h.instance.snapshot.getSnapshot;
          expect(after.models).toEqual(before.models);
          expect(after.auth).toEqual(before.auth);
          expect(McpProviderSession.readMcpProviderSession(peerNative.threadId)).toEqual(
            peerNative.mcp,
          );
          yield* peerNative.turn(1);
          expect(nativeLaunches(peer)).toHaveLength(1);
          h.controls.beforeRelease = Effect.void;
          yield* h.refresh();
          expect(nativeLaunches(h)).toHaveLength(2);
        }).pipe(Effect.scoped),
    );
  }

  it.effect.skipIf(windowsHost)(
    "completes factory logout after the requesting client disconnects from blocked physical teardown",
    () =>
      Effect.gen(function* () {
        const h = yield* makeHarness();
        yield* openNative(h);
        const { actions, auth } = actionsFor(h);
        const entered = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        yield* Effect.addFinalizer(() => Deferred.succeed(release, undefined));
        h.controls.beforeRelease = Deferred.succeed(entered, undefined).pipe(
          Effect.andThen(Deferred.await(release)),
        );
        const previous = yield* h.readRequests;
        const request = yield* actions.disconnect.pipe(Effect.forkScoped);
        yield* Deferred.await(entered);
        yield* assertProcessesClosed(h);
        yield* Fiber.interrupt(request);
        expect(yield* h.readRequests).toEqual(previous);
        h.controls.beforeRelease = Effect.void;
        yield* Deferred.succeed(release, undefined);
        const state = yield* auth.subscribe("native-callback-observer").pipe(
          Stream.filter((value) => value.message === "Signed out of Google."),
          Stream.runHead,
          Effect.map(Option.getOrThrow),
        );
        expect(state.phase).toBe("idle");
        expect((yield* h.readRequests).slice(previous.length).map((value) => value.method)).toEqual(
          ["initialize", "auth/logout"],
        );
        expect((yield* h.instance.snapshot.getSnapshot).models).toEqual([]);
        yield* assertProcessesClosed(h);
        yield* h.refresh();
      }).pipe(Effect.scoped),
  );

  it.effect.skipIf(windowsHost)(
    "cancels a factory browser flow and retires its real pending ACP child before native reopen",
    () =>
      Effect.gen(function* () {
        const h = yield* makeHarness();
        yield* openNative(h);
        const before = yield* h.instance.snapshot.getSnapshot;
        const oldLaunches = [...nativeLaunches(h)];
        h.controls.selected = h.waiting;
        const { actions } = actionsFor(h);
        const flow = yield* actions.start("antigravity_google");
        expect(flow.initialStatus).toBe("waiting_for_browser");
        yield* assertProcessesClosed(h, oldLaunches);
        expect(nativeLaunches(h)).toHaveLength(2);
        expect(yield* nativeLaunches(h)[1]!.handle.isRunning).toBe(true);
        yield* flow.cancel;
        expect(Exit.isFailure(yield* flow.waitForCompletion.pipe(Effect.exit))).toBe(true);
        yield* assertProcessesClosed(h);
        expect((yield* h.instance.snapshot.getSnapshot).models).toEqual(before.models);
        h.controls.selected = h.first;
        yield* openNative(h, "after-cancel");
        expect(nativeLaunches(h)).toHaveLength(3);
      }).pipe(Effect.scoped),
  );

  it.effect.skipIf(windowsHost)(
    "times out factory logout, closes its stalled child and reopens admission without clearing the catalog",
    () =>
      Effect.gen(function* () {
        const h = yield* makeHarness();
        yield* openNative(h);
        const before = yield* h.instance.snapshot.getSnapshot;
        const oldLaunches = [...nativeLaunches(h)];
        const { actions } = actionsFor(h);
        h.controls.selected = h.stalled;
        const spawned = yield* Deferred.make<void>();
        h.controls.beforeSpawn = assertProcessesClosed(h, oldLaunches);
        h.controls.afterSpawn = Deferred.succeed(spawned, undefined).pipe(Effect.asVoid);
        const logout = yield* actions.disconnect.pipe(Effect.exit, Effect.forkScoped);
        // Observe the actual stalled child, not merely the auth admission receipt.
        yield* Deferred.await(spawned);
        expect(nativeLaunches(h)).toHaveLength(2);
        expect(yield* nativeLaunches(h)[1]!.handle.isRunning).toBe(true);
        yield* TestClock.adjust("90 seconds");
        expect(Exit.isFailure(yield* Fiber.join(logout))).toBe(true);
        yield* assertProcessesClosed(h, oldLaunches);
        yield* assertProcessesClosed(h);
        expect((yield* h.instance.snapshot.getSnapshot).models).toEqual(before.models);
        expect((yield* h.readRequests).some((request) => request.method === "auth/logout")).toBe(
          false,
        );
        h.controls.selected = h.first;
        yield* openNative(h, "after-timeout");
      }).pipe(Effect.scoped),
  );

  it.effect.skipIf(windowsHost)(
    "preserves the Node install message when starting a standalone provider",
    () =>
      Effect.gen(function* () {
        const h = yield* makeHarness();
        const error = yield* h.refresh().pipe(Effect.flip);
        expect(error.detail).toContain("Install Node.js");
        expect(h.launches).toEqual([]);
      }).pipe(
        Effect.scoped,
        Effect.provideService(HostProcessIsExecutable, true),
        Effect.provideService(HostProcessEnvironment, { PATH: "" }),
      ),
  );

  it.effect.skipIf(windowsHost)("does not launch a process for a disabled instance", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness();
      const snapshot = yield* h.instance.snapshot.refresh;
      expect(snapshot.status).toBe("disabled");
      expect(h.acquisitions).toEqual([]);
      expect(h.launches).toEqual([]);
      expect(yield* h.fs.exists(h.profileDirectory)).toBe(false);
    }).pipe(Effect.scoped),
  );

  it.effect.skipIf(windowsHost)("refreshes models after slow process startup", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness();
      const entered = yield* Deferred.make<void>();
      const ready = yield* Deferred.make<void>();
      h.controls.beforeAcquire = Deferred.succeed(entered, undefined).pipe(
        Effect.andThen(Deferred.await(ready)),
      );
      const refresh = yield* h.refresh().pipe(Effect.forkScoped);
      yield* Deferred.await(entered);
      yield* TestClock.adjust("70 seconds");
      yield* Deferred.succeed(ready, undefined);
      yield* Fiber.join(refresh);
      const snapshot = yield* h.instance.snapshot.getSnapshot;
      expect(snapshot.auth.status).toBe("authenticated");
      expect(snapshot.models.length).toBeGreaterThan(0);
      yield* h.assertClosed;
    }).pipe(Effect.scoped),
  );

  it.effect.skipIf(windowsHost)(
    "refreshes a disabled instance through the selected executable and personal Google ACP",
    () =>
      Effect.gen(function* () {
        const h = yield* makeHarness();
        yield* h.refresh();
        const snapshot = yield* h.instance.snapshot.getSnapshot;
        expect(snapshot.status).toBe("disabled");
        expect(snapshot.auth.status).toBe("authenticated");
        expect(snapshot.models.map((model) => model.slug)).toEqual([
          "gemini-test-low",
          "gemini-test-high",
        ]);
        expect(snapshot.models[0]?.aliases).toContain(ANTIGRAVITY_DEFAULT_MODEL);
        // Unknown runtime discoveries remain visible unless explicitly
        // classified as legacy by the manifest or provider.
        expect(snapshot.models.every((model) => !model.isLegacy)).toBe(true);
        expect(snapshot.slashCommands.map((command) => command.name)).toEqual(["plan", "logout"]);
        expect(snapshot.supportsTextGeneration).toBe(true);
        h.controls.selected = h.second;
        yield* h.refresh();

        expect(h.acquisitions).toEqual([
          { binaryPath: "", path: h.instancePath },
          { binaryPath: "", path: h.instancePath },
        ]);
        const nativeLaunches = h.launches.filter((launch) => launch.harnessPath !== undefined);
        expect(nativeLaunches.map((launch) => launch.command)).toEqual([
          h.first.executablePath,
          h.second.executablePath,
        ]);
        expect(nativeLaunches.map((launch) => launch.harnessPath)).toEqual([
          h.first.harnessPath,
          h.second.harnessPath,
        ]);
        for (const launch of nativeLaunches) {
          expect(launch.args).toEqual(hostPlatform === "linux" ? ["--uid="] : []);
          expect(launch.profileDirectory).toBe(h.profileDirectory);
          expect(launch.forceFileStorage).toBe("1");
          expect(launch.extendEnv).toBe(false);
        }
        for (const launch of h.launches) expect(launch.credentialKeys).toEqual([]);
        expect(h.releases).toEqual([h.first.version, h.second.version]);
        const requests = yield* h.readRequests;
        expect(requests.map((request) => request.method)).toEqual([
          "initialize",
          "auth/login",
          "session/new",
          "initialize",
          "auth/login",
          "session/new",
        ]);
        expect(
          requests
            .filter((request) => request.method === "auth/login")
            .map((request) => request.params?.methodId),
        ).toEqual(["oauth-personal", "oauth-personal"]);
        expect(
          requests
            .filter((request) => request.method === "session/new")
            .map((request) => request.params?.mcpServers),
        ).toEqual([[], []]);
        yield* h.assertClosed;
      }).pipe(Effect.scoped),
  );

  it.effect.skipIf(windowsHost)(
    "authenticates with the configured API key method and labels the account by method",
    () =>
      Effect.gen(function* () {
        const h = yield* makeHarness({
          config: { authMethod: "gemini-api-key", apiKey: "fixture-gemini-key" },
        });
        yield* h.refresh();
        const snapshot = yield* h.instance.snapshot.getSnapshot;
        expect(snapshot.auth).toMatchObject({
          status: "authenticated",
          type: "gemini-api-key",
          label: "Gemini API key",
        });
        expect(snapshot.models.length).toBeGreaterThan(0);
        const nativeLaunches = h.launches.filter((launch) => launch.harnessPath !== undefined);
        expect(nativeLaunches.map((launch) => launch.geminiApiKey)).toEqual(["fixture-gemini-key"]);
        const requests = yield* h.readRequests;
        expect(
          requests
            .filter((request) => request.method === "auth/login")
            .map((request) => request.params?.methodId),
        ).toEqual(["gemini-api-key"]);
        yield* h.assertClosed;
      }).pipe(Effect.scoped),
  );

  it.effect.skipIf(windowsHost)("reports the missing credential before launching a process", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness({ config: { authMethod: "gemini-api-key" } });
      const error = yield* h.refresh().pipe(Effect.flip);
      expect(error.detail).toContain("API key");
      expect(h.launches.filter((launch) => launch.harnessPath !== undefined)).toEqual([]);
    }).pipe(Effect.scoped),
  );

  it.effect.skipIf(windowsHost)(
    "closes refresh processes and clears account metadata when Google sign-in is required",
    () =>
      Effect.gen(function* () {
        const h = yield* makeHarness();
        yield* h.refresh();
        h.controls.selected = h.signedOut;
        const error = yield* h.refresh().pipe(Effect.flip);
        expect(error.detail).toContain("Sign in to Antigravity");
        const snapshot = yield* h.instance.snapshot.getSnapshot;
        expect(snapshot.auth.status).toBe("unauthenticated");
        expect(snapshot.models).toEqual([]);
        expect(snapshot.slashCommands).toEqual([]);
        expect(snapshot.supportsTextGeneration).toBe(false);
        expect(h.acquisitions).toHaveLength(2);
        expect(h.releases).toEqual([h.first.version, h.signedOut.version]);
        yield* h.assertClosed;
      }).pipe(Effect.scoped),
  );

  it.effect.skipIf(windowsHost)(
    "clears account metadata when a text helper needs Google sign-in",
    () =>
      Effect.gen(function* () {
        const h = yield* makeHarness();
        yield* h.refresh();
        h.controls.selected = h.signedOut;
        const error = yield* h.instance.textGeneration
          .generateThreadTitle({
            cwd: h.profileDirectory,
            message: "Repair Google login",
            modelSelection: { instanceId: h.instance.instanceId, model: "gemini-test-low" },
          })
          .pipe(Effect.flip);
        expect(error._tag).toBe("TextGenerationError");
        const snapshot = yield* h.instance.snapshot.getSnapshot;
        expect(snapshot.auth.status).toBe("unauthenticated");
        expect(snapshot.models).toEqual([]);
        expect(snapshot.supportsTextGeneration).toBe(false);
        expect(h.releases).toEqual([h.first.version, h.signedOut.version]);
        yield* h.assertClosed;
      }).pipe(Effect.scoped),
  );

  it.effect.skipIf(windowsHost)("keeps the previous catalog when executable resolution fails", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness();
      yield* h.refresh();
      const before = yield* h.instance.snapshot.getSnapshot;
      h.controls.failResolution = true;
      const error = yield* h.refresh().pipe(Effect.flip);
      expect(error.detail).toContain("previous model list is unchanged");
      const after = yield* h.instance.snapshot.getSnapshot;
      expect(after.models).toEqual(before.models);
      expect(after.auth).toEqual(before.auth);
      expect(h.acquisitions).toHaveLength(2);
      expect(h.releases).toEqual([h.first.version]);
      yield* h.assertClosed;
    }).pipe(Effect.scoped),
  );

  it.effect.skipIf(windowsHost)(
    "gives each process its own temp directory and removes it when the process closes",
    () =>
      Effect.gen(function* () {
        const h = yield* makeHarness();
        const tempRoot = h.directories.runtimeTemp;
        yield* h.refresh();
        yield* h.refresh();
        const directories = h.launches.flatMap((launch) =>
          launch.tempDirectory === undefined ? [] : [launch.tempDirectory],
        );
        expect(directories).toHaveLength(2);
        for (const directory of directories) {
          expect(h.path.dirname(directory)).toBe(tempRoot);
        }
        expect(new Set(directories).size).toBe(2);
        yield* h.assertClosed;
      }).pipe(Effect.scoped),
  );

  it.effect.skipIf(windowsHost)(
    "removes runtime temp directories left by a previous server on create",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const config = yield* ServerConfig.ServerConfig;
        const instanceId = ProviderInstanceId.make("antigravity-orphan-sweep");
        const directories = yield* resolveAntigravityInstanceDirectories(
          config.stateDir,
          instanceId,
        );
        // Older builds unpacked inside the profile.
        const legacyRoot = path.join(directories.profile, "antigravity-acp", "tmp");
        for (const root of [directories.runtimeTemp, legacyRoot]) {
          const orphan = path.join(root, "run-orphan", "_MEI123", "google3");
          yield* fs.makeDirectory(orphan, { recursive: true });
          yield* fs.writeFileString(path.join(orphan, "payload.bin"), "stale");
        }
        yield* AntigravityDriver.create({
          instanceId,
          displayName: "Sweep",
          enabled: false,
          config: AntigravityDriver.defaultConfig(),
          environment: [],
        }).pipe(
          Effect.provide(
            Layer.mock(AntigravityInstallation.AntigravityInstallation)({
              managedDirectory: config.stateDir,
              latestRelease: Effect.succeed(null),
              state: Effect.succeed({
                driver: ProviderDriverKind.make("antigravity"),
                operationId: null,
                phase: "idle",
                downloadedBytes: 0,
                totalBytes: null,
                version: null,
                installedVersion: null,
                canRemove: false,
                message: null,
              }),
              resolve: () =>
                Effect.fail(
                  new AntigravityInstallation.AntigravityInstallationError({
                    operation: "resolve",
                    detail: "No runtime is needed for orphan cleanup.",
                  }),
                ),
              acquire: () => Effect.die("unused"),
            }),
          ),
        );
        expect(yield* fs.exists(directories.runtimeTemp)).toBe(false);
        expect(yield* fs.exists(legacyRoot)).toBe(false);
      }).pipe(Effect.scoped),
  );

  it.effect("probes through installation resolution without launching a process", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness({ enabled: true });
      const snapshot = yield* h.instance.snapshot.refresh;
      expect(snapshot.installed).toBe(true);
      expect(snapshot.version).toBe(h.first.version);
      expect(h.launches).toEqual([]);
      expect(h.acquisitions).toEqual([]);
    }).pipe(Effect.scoped),
  );
});
