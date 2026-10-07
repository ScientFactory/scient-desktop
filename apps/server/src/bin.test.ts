import * as ThreadCommandExecutor from "./orchestration-v2/ThreadCommandExecutor.ts";
import * as ProjectCloneTracker from "./project/ProjectCloneTracker.ts";
// @effect-diagnostics nodeBuiltinImport:off - CLI integration exercises Node HTTP and filesystem boundaries.
import * as NodeHttp from "node:http";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeChildProcess from "node:child_process";

import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { CommandId, EnvironmentHttpApi, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as NetService from "@t3tools/shared/Net";
import { HostProcessEnvironment } from "@t3tools/shared/hostProcess";
import { DEFAULT_SIGNAL_EXPORT } from "@t3tools/shared/observability";
import * as OtelEnvironment from "@t3tools/shared/otelEnvironment";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Layer from "effect/Layer";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServer from "effect/http/HttpServer";
import * as HttpApi from "effect/http-api/HttpApi";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import * as CliError from "effect/cli/CliError";
import * as TestConsole from "effect/testing/TestConsole";
import { Command } from "effect/cli";

import { cli, makeCli } from "./binCli.ts";
import * as ServiceLauncherClient from "./cloud/serviceLauncherClient.ts";
import {
  SERVICE_LAUNCHER_CONTEXT_ENV,
  SERVICE_LAUNCHER_PROTOCOL,
} from "./cloud/serviceProtocol.ts";
import * as ServerConfig from "./config.ts";
import * as ServerEnvironment from "./environment/ServerEnvironment.ts";
import * as ProjectService from "./project/ProjectService.ts";
import * as ProjectionStore from "./orchestration-v2/ProjectionStore.ts";
import * as ProjectStore from "./orchestration-v2/ProjectStore.ts";
import * as ThreadManagement from "./orchestration-v2/ThreadManagementService.ts";
import * as ProviderAdapterRegistryV2 from "./orchestration-v2/ProviderAdapterRegistry.ts";
import { layerWithRegistry as makeOrchestratorV2ReplayLayerWithRegistry } from "./orchestration-v2/testkit/ProviderReplayHarness.ts";
import { layerProjectService as ProjectServiceLayerLive } from "./orchestration-v2/runtimeLayer.ts";
import { layer as projectHttpApiLayer } from "./project/http.ts";
import * as ProjectEnrichmentService from "./project/ProjectEnrichmentService.ts";
import * as ProjectFaviconResolver from "./project/ProjectFaviconResolver.ts";
import * as T3ProjectFileLoader from "./project/T3ProjectFileLoader.ts";
import * as ServerRuntimeStartup from "./serverRuntimeStartup.ts";
import { layerConfig as SqlitePersistenceLayerLive } from "./persistence/Sqlite.ts";
import * as RepositoryIdentityResolver from "./project/RepositoryIdentityResolver.ts";
import {
  makePersistedServerRuntimeState,
  persistServerRuntimeState,
} from "./serverRuntimeState.ts";
import * as WorkspacePaths from "./workspace/WorkspacePaths.ts";
import * as ServerSecretStore from "./auth/ServerSecretStore.ts";
import * as EnvironmentAuth from "./auth/EnvironmentAuth.ts";
import { layerAuthenticatedAuth as environmentAuthenticatedAuthLayer } from "./auth/http.ts";

import packageJson from "../package.json" with { type: "json" };

const CliRuntimeLayer = Layer.mergeAll(
  NodeServices.layer,
  NetService.layer,
  ConfigProvider.layer(ConfigProvider.fromEnv({ env: {} })),
);
const DisconnectedLauncherChildLayer = Layer.mergeAll(
  Layer.succeed(HostProcessEnvironment, {
    ...process.env,
    [SERVICE_LAUNCHER_CONTEXT_ENV]: JSON.stringify({
      protocol: SERVICE_LAUNCHER_PROTOCOL,
      childVersion: packageJson.version,
    }),
  }),
  Layer.succeed(ServiceLauncherClient.ServiceLauncherHostProcess, {
    connected: false,
    send: () => false,
    on: () => undefined,
    off: () => undefined,
  }),
);
class ProjectCliHttpApi extends HttpApi.make("environment").add(
  EnvironmentHttpApi.groups.projects,
) {}

const connectCli = makeCli({ cloudEnabled: true });
const noConnectCli = makeCli({ cloudEnabled: false });
const runCli = (args: ReadonlyArray<string>, command = cli) =>
  Command.runWith(command, { version: "0.0.0" })(args);
const runConnectCli = (args: ReadonlyArray<string>) => runCli(args, connectCli);
const runCliWithRuntime = (args: ReadonlyArray<string>) =>
  runCli(args).pipe(Effect.provide(CliRuntimeLayer));

const captureStdout = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const result = yield* effect;
    const output =
      (yield* TestConsole.logLines).findLast((line): line is string => typeof line === "string") ??
      "";
    return { result, output };
  }).pipe(Effect.provide(Layer.mergeAll(CliRuntimeLayer, TestConsole.layer)));

const makeCliTestServerConfig = (baseDir: string) =>
  Effect.gen(function* () {
    const derivedPaths = yield* ServerConfig.deriveServerPaths(baseDir, undefined);
    return {
      logLevel: "Info",
      traceMinLevel: "Info",
      traceTimingEnabled: true,
      traceBatchWindowMs: 200,
      traceMaxBytes: 10 * 1024 * 1024,
      traceMaxFiles: 10,
      otlpTracesUrl: undefined,
      otlpMetricsUrl: undefined,
      otlpLogsUrl: undefined,
      otlpTracesExport: DEFAULT_SIGNAL_EXPORT,
      otlpMetricsExport: DEFAULT_SIGNAL_EXPORT,
      otlpLogsExport: DEFAULT_SIGNAL_EXPORT,
      otelEnvironment: OtelEnvironment.none,
      mode: "web",
      port: 0,
      host: "127.0.0.1",
      cwd: process.cwd(),
      baseDir,
      ...derivedPaths,
      staticDir: undefined,
      devUrl: undefined,
      devAllowedOrigins: [],
      noBrowser: true,
      startupPresentation: "browser",
      desktopBootstrapToken: undefined,
      autoBootstrapProjectFromCwd: false,
      logWebSocketEvents: false,
      tailscaleServeEnabled: false,
      tailscaleServePort: 443,
    } satisfies ServerConfig.ServerConfig["Service"];
  });

const makeProjectPersistenceLayer = (config: ServerConfig.ServerConfig["Service"]) => {
  const database = SqlitePersistenceLayerLive.pipe(
    Layer.provide(ServerConfig.layer(config)),
    Layer.provide(NodeServices.layer),
  );
  const replay = makeOrchestratorV2ReplayLayerWithRegistry(
    { name: "project-cli" },
    ProviderAdapterRegistryV2.layerFromAdapters([]),
    { layerDatabase: database, runEffectWorker: false },
  );
  return Layer.mergeAll(
    ProjectServiceLayerLive,
    ProjectStore.layer,
    ProjectionStore.layer,
    ThreadManagement.layer.pipe(Layer.provide(replay)),
  ).pipe(
    Layer.provideMerge(ProjectEnrichmentService.layer),
    Layer.provide(
      Layer.mock(ProjectCloneTracker.ProjectCloneTracker)({ discard: () => Effect.void }),
    ),
    Layer.provideMerge(RepositoryIdentityResolver.layer),
    Layer.provideMerge(
      ProjectFaviconResolver.layer.pipe(
        Layer.provide(WorkspacePaths.layer),
        Layer.provide(T3ProjectFileLoader.layer),
      ),
    ),
    Layer.provideMerge(WorkspacePaths.layer),
    Layer.provideMerge(database),
    Layer.provideMerge(NodeServices.layer),
    Layer.provide(ServerConfig.layer(config)),
    Layer.provide(ThreadCommandExecutor.layer),
  );
};
const readPersistedSnapshot = (baseDir: string) =>
  Effect.gen(function* () {
    const config = yield* makeCliTestServerConfig(baseDir);
    return yield* Effect.gen(function* () {
      const projects = yield* (yield* ProjectService.ProjectService).snapshot;
      const storedProjects = yield* (yield* ProjectStore.ProjectStoreV2).list({
        includeDeleted: true,
      });
      const shell = yield* (yield* ProjectionStore.ProjectionStoreV2).getShellSnapshot();
      return {
        ...projects,
        projects: storedProjects.map(({ projectId, ...project }) => ({
          ...project,
          id: projectId,
        })),
        threads: shell.threads,
      };
    }).pipe(Effect.provide(makeProjectPersistenceLayer(config)));
  });

const makeProjectLookupFixture = Effect.fn("makeProjectLookupFixture")(function* (
  withThread: boolean,
  removeWorkspace: boolean,
) {
  const baseDir = NodeFS.mkdtempSync(
    NodePath.join(NodeOS.tmpdir(), "t3-cli-project-lookup-state-"),
  );
  const workspaceRoot = NodeFS.mkdtempSync(
    NodePath.join(NodeOS.tmpdir(), "t3-cli-project-lookup-git-"),
  );
  NodeChildProcess.execFileSync("git", ["init", "--initial-branch=main", workspaceRoot], {
    stdio: "ignore",
  });
  yield* runCliWithRuntime(["project", "add", workspaceRoot, "--base-dir", baseDir]);
  const snapshot = yield* readPersistedSnapshot(baseDir);
  const project = snapshot.projects.find((candidate) => candidate.workspaceRoot === workspaceRoot)!;
  assert.isDefined(project);
  if (withThread) {
    const config = yield* makeCliTestServerConfig(baseDir);
    yield* Effect.gen(function* () {
      const threads = yield* ThreadManagement.ThreadManagementService;
      yield* threads.dispatch({
        type: "thread.create",
        commandId: CommandId.make("cmd-project-lookup-thread"),
        threadId: ThreadId.make("thread-project-lookup"),
        projectId: project.id,
        title: "Project lookup test",
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5-codex" },
        interactionMode: "default",
        runtimeMode: "approval-required",
        branch: null,
        worktreePath: null,
        createdBy: "user",
        creationSource: "server",
      });
    }).pipe(Effect.provide(makeProjectPersistenceLayer(config)));
  }
  if (removeWorkspace) {
    NodeFS.renameSync(workspaceRoot, `${workspaceRoot}-removed`);
    assert.isFalse(NodeFS.existsSync(workspaceRoot));
  }
  return { baseDir, workspaceRoot, project };
});

it.layer(NodeServices.layer)("project lookup with unavailable workspaces", (it) => {
  it.effect("removes an empty project by ID without force after its directory is gone", () =>
    Effect.gen(function* () {
      const { baseDir, project } = yield* makeProjectLookupFixture(false, true);
      yield* runCliWithRuntime(["project", "remove", project.id, "--base-dir", baseDir]);
      const after = yield* readPersistedSnapshot(baseDir);
      assert.isNotNull(after.projects.find((candidate) => candidate.id === project.id)!.deletedAt);
    }),
  );

  it.effect.each([true, false])(
    "requires force for child threads, then removes by ID; missing=%s",
    (removeWorkspace) =>
      Effect.gen(function* () {
        const { baseDir, project } = yield* makeProjectLookupFixture(true, removeWorkspace);
        const error = yield* runCliWithRuntime([
          "project",
          "remove",
          project.id,
          "--base-dir",
          baseDir,
        ]).pipe(Effect.flip);
        assert.instanceOf(error, ProjectService.ProjectNotEmptyError);
        const retained = yield* readPersistedSnapshot(baseDir);
        assert.isNull(
          retained.projects.find((candidate) => candidate.id === project.id)!.deletedAt,
        );
        assert.isDefined(retained.threads.find((thread) => thread.id === "thread-project-lookup"));
        yield* runCliWithRuntime([
          "project",
          "remove",
          project.id,
          "--force",
          "--base-dir",
          baseDir,
        ]);
        const after = yield* readPersistedSnapshot(baseDir);
        assert.isNotNull(
          after.projects.find((candidate) => candidate.id === project.id)!.deletedAt,
        );
        assert.isUndefined(after.threads.find((thread) => thread.id === "thread-project-lookup"));
      }),
  );

  it.effect("cannot remove the old environment's ID from a replacement empty database", () =>
    Effect.gen(function* () {
      const { baseDir, project } = yield* makeProjectLookupFixture(true, true);
      const replacementDir = NodeFS.mkdtempSync(
        NodePath.join(NodeOS.tmpdir(), "t3-cli-project-lookup-new-state-"),
      );
      const error = yield* runCliWithRuntime([
        "project",
        "remove",
        project.id,
        "--force",
        "--base-dir",
        replacementDir,
      ]).pipe(Effect.flip);
      assert.include(error.message, "No active project found");
      assert.include(String(error.cause), "Workspace root does not exist");
      const original = yield* readPersistedSnapshot(baseDir);
      assert.isNull(original.projects.find((candidate) => candidate.id === project.id)!.deletedAt);
      const replacement = yield* readPersistedSnapshot(replacementDir);
      assert.equal(replacement.projects.length, 0);
    }),
  );

  it.effect("renames by ID and stored path, then force removes after the directory is gone", () =>
    Effect.gen(function* () {
      const { baseDir, workspaceRoot, project } = yield* makeProjectLookupFixture(true, true);
      yield* runCliWithRuntime([
        "project",
        "rename",
        project.id,
        "Renamed by ID",
        "--base-dir",
        baseDir,
      ]);
      const afterIdRename = yield* readPersistedSnapshot(baseDir);
      assert.equal(
        afterIdRename.projects.find((candidate) => candidate.id === project.id)!.title,
        "Renamed by ID",
      );
      yield* runCliWithRuntime([
        "project",
        "rename",
        workspaceRoot,
        "Renamed by stored path",
        "--base-dir",
        baseDir,
      ]);
      const afterPathRename = yield* readPersistedSnapshot(baseDir);
      assert.equal(
        afterPathRename.projects.find((candidate) => candidate.id === project.id)!.title,
        "Renamed by stored path",
      );
      const error = yield* runCliWithRuntime([
        "project",
        "remove",
        workspaceRoot,
        "--base-dir",
        baseDir,
      ]).pipe(Effect.flip);
      assert.instanceOf(error, ProjectService.ProjectNotEmptyError);
      yield* runCliWithRuntime([
        "project",
        "remove",
        workspaceRoot,
        "--force",
        "--base-dir",
        baseDir,
      ]);
      const after = yield* readPersistedSnapshot(baseDir);
      assert.isNotNull(after.projects.find((candidate) => candidate.id === project.id)!.deletedAt);
      assert.isUndefined(after.threads.find((thread) => thread.id === "thread-project-lookup"));
      assert.isFalse(NodeFS.existsSync(workspaceRoot));
    }),
  );

  it.effect("preserves normalized paths and distinct symlink project entries", () =>
    Effect.gen(function* () {
      const { baseDir, workspaceRoot, project } = yield* makeProjectLookupFixture(false, false);
      const normalizedInput = `${workspaceRoot}${NodePath.sep}.`;
      yield* runCliWithRuntime([
        "project",
        "rename",
        normalizedInput,
        "Normalized",
        "--base-dir",
        baseDir,
      ]);
      const renamed = yield* readPersistedSnapshot(baseDir);
      assert.equal(
        renamed.projects.find((candidate) => candidate.id === project.id)!.title,
        "Normalized",
      );
      const aliasPath = `${workspaceRoot}-alias`;
      NodeFS.symlinkSync(workspaceRoot, aliasPath, "junction");
      const error = yield* runCliWithRuntime([
        "project",
        "remove",
        aliasPath,
        "--force",
        "--base-dir",
        baseDir,
      ]).pipe(Effect.flip);
      assert.include(error.message, "No active project found");
      yield* runCliWithRuntime(["project", "add", aliasPath, "--base-dir", baseDir]);
      const added = yield* readPersistedSnapshot(baseDir);
      const aliasProject = added.projects.find(
        (candidate) => candidate.workspaceRoot === aliasPath,
      )!;
      assert.notEqual(aliasProject.id, project.id);
      yield* runCliWithRuntime([
        "project",
        "remove",
        `${aliasPath}${NodePath.sep}.`,
        "--base-dir",
        baseDir,
      ]);
      const after = yield* readPersistedSnapshot(baseDir);
      assert.isNotNull(
        after.projects.find((candidate) => candidate.id === aliasProject.id)!.deletedAt,
      );
      assert.isNull(after.projects.find((candidate) => candidate.id === project.id)!.deletedAt);
      assert.isTrue(NodeFS.existsSync(workspaceRoot));
    }),
  );
});

const withLiveProjectCliServer = <A, E, R>(baseDir: string, run: () => Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const config = yield* makeCliTestServerConfig(baseDir);
    const routesLayer = HttpApiBuilder.layer(ProjectCliHttpApi).pipe(
      Layer.provide(projectHttpApiLayer),
      Layer.provide(
        Layer.succeed(ServerRuntimeStartup.ServerRuntimeStartup, {
          awaitCommandReady: Effect.void,
          markHttpListening: Effect.void,
          enqueueCommand: (operation) => operation,
        }),
      ),
      Layer.provide(environmentAuthenticatedAuthLayer),
    );
    const appLayer = HttpRouter.serve(routesLayer, {
      disableListenLog: true,
      disableLogger: true,
    }).pipe(
      Layer.provideMerge(
        EnvironmentAuth.layer.pipe(
          Layer.provideMerge(SqlitePersistenceLayerLive),
          Layer.provide(ServerEnvironment.layerIdentity),
          Layer.provide(ServerSecretStore.layer),
        ),
      ),
      Layer.provideMerge(makeProjectPersistenceLayer(config)),
      Layer.provideMerge(
        NodeHttpServer.layer(NodeHttp.createServer, {
          host: "127.0.0.1",
          port: 0,
        }),
      ),
      Layer.provideMerge(NodeServices.layer),
      Layer.provide(ServerConfig.layer(config)),
    );

    return yield* Effect.scoped(
      Effect.gen(function* () {
        const server = yield* HttpServer.HttpServer;
        const address = server.address;
        if (typeof address === "string" || !("port" in address)) {
          assert.fail(`Expected TCP address, got ${address}`);
        }
        yield* persistServerRuntimeState({
          path: config.serverRuntimeStatePath,
          state: yield* makePersistedServerRuntimeState({
            config,
            port: address.port,
          }),
        });
        return yield* run();
      }).pipe(Effect.provide(Layer.mergeAll(appLayer, NodeServices.layer))),
    );
  });

it.layer(NodeServices.layer)("bin cli parsing", (it) => {
  it.effect("accepts the built-in lowercase log-level flag values", () =>
    Effect.gen(function* () {
      const { output } = yield* captureStdout(runCli(["--log-level", "debug", "--version"]));

      assert.include(output, "0.0.0");
    }),
  );

  it.effect("accepts canonical --no-<flag> boolean negation", () =>
    Effect.gen(function* () {
      const { output } = yield* captureStdout(runCli(["--no-log-websocket-events", "--version"]));

      assert.include(output, "0.0.0");
    }),
  );

  it.effect("rejects invalid log-level casing before launching the server", () =>
    Effect.gen(function* () {
      const error = yield* runCliWithRuntime(["--log-level", "Debug"]).pipe(Effect.flip);

      if (!CliError.isCliError(error)) {
        assert.fail(`Expected CliError, got ${String(error)}`);
      }
      if (error._tag !== "InvalidValue") {
        assert.fail(`Expected InvalidValue, got ${error._tag}`);
      }
      assert.equal(error.option, "log-level");
      assert.equal(error.value, "Debug");
    }),
  );

  it.effect("rejects connect commands when public configuration is missing", () =>
    Effect.gen(function* () {
      const error = yield* runCli(["connect", "status"], noConnectCli).pipe(Effect.flip);

      if (!CliError.isCliError(error)) {
        assert.fail(`Expected CliError, got ${String(error)}`);
      }
      if (error._tag !== "ShowHelp") {
        assert.fail(`Expected ShowHelp, got ${error._tag}`);
      }
      assert.deepEqual(error.commandPath, ["t3", "connect"]);
      assert.include(error.errors[0]?.message ?? "", "missing T3 Connect public configuration");

      const output = (yield* TestConsole.errorLines).join("\n");
      assert.include(output, "ERROR");
      assert.include(output, "missing T3 Connect public configuration");
    }).pipe(Effect.provide(Layer.mergeAll(CliRuntimeLayer, TestConsole.layer))),
  );

  it.effect("does not expose the inherited service lifecycle in Scient", () =>
    Effect.gen(function* () {
      const { output } = yield* captureStdout(runCli(["--help"], noConnectCli));

      assert.notInclude(output, "Manage the Scient background service.");
      for (const command of [
        "service",
        "__service-preflight",
        "update",
        "uninstall",
        "__service-launcher",
      ]) {
        assert.isFalse(
          noConnectCli.subcommands
            .flatMap((group) => group.commands)
            .some((candidate) => candidate.name === command),
          command,
        );
        // The root accepts a positional cwd, so an unknown name alone is a
        // directory argument. --help exercises parsing without starting a server.
        const help = yield* captureStdout(runCli([command, "--help"], noConnectCli));
        assert.include(help.output, "Run the Scient server.", command);
      }
    }),
  );

  it.effect("reports fresh headless connect state without requiring local configuration", () =>
    Effect.gen(function* () {
      const baseDir = NodeFS.mkdtempSync(
        NodePath.join(NodeOS.tmpdir(), "t3-cli-cloud-status-test-"),
      );
      const { output } = yield* captureStdout(
        runConnectCli(["connect", "status", "--base-dir", baseDir, "--json"]),
      );
      const status = JSON.parse(output) as {
        readonly desired: boolean;
        readonly authenticated: boolean;
        readonly linked: boolean;
        readonly cloudUserId: string | null;
        readonly relayUrl: string | null;
      };

      assert.equal(status.desired, false);
      assert.equal(status.authenticated, false);
      assert.equal(status.linked, false);
      assert.equal(status.cloudUserId, null);
      assert.equal(status.relayUrl, null);
    }).pipe(Effect.provide(DisconnectedLauncherChildLayer)),
  );

  it.effect("reports actionable human-readable headless connect state", () =>
    Effect.gen(function* () {
      const baseDir = NodeFS.mkdtempSync(
        NodePath.join(NodeOS.tmpdir(), "t3-cli-cloud-status-human-test-"),
      );
      const { output } = yield* captureStdout(
        runConnectCli(["connect", "status", "--base-dir", baseDir]),
      );

      assert.include(output, "T3 Connect\n  Exposure: disabled");
      assert.include(output, "  Authorization: missing");
      assert.include(output, "  Environment link: not provisioned");
      assert.include(output, "Next: Run `t3 connect link` to authorize and enable T3 Connect.");
    }),
  );

  it.effect("accepts the --headless login override without enabling access", () =>
    Effect.gen(function* () {
      const baseDir = NodeFS.mkdtempSync(
        NodePath.join(NodeOS.tmpdir(), "t3-cli-cloud-login-test-"),
      );
      const { secretsDir } = yield* ServerConfig.deriveServerPaths(baseDir, undefined);
      NodeFS.mkdirSync(secretsDir, { recursive: true });
      NodeFS.writeFileSync(
        NodePath.join(secretsDir, "cloud-cli-oauth-token.bin"),
        JSON.stringify({
          accessToken: "access-token",
          refreshToken: "refresh-token",
          expiresAtEpochMs: Number.MAX_SAFE_INTEGER,
        }),
      );

      const login = yield* captureStdout(
        runConnectCli(["connect", "login", "--base-dir", baseDir, "--headless"]),
      );
      const status = yield* captureStdout(
        runConnectCli(["connect", "status", "--base-dir", baseDir, "--json"]),
      );
      const decoded = JSON.parse(status.output) as {
        readonly desired: boolean;
        readonly authenticated: boolean;
      };

      assert.equal(login.output, "✓ Signed in");
      assert.isFalse(decoded.desired);
      assert.isTrue(decoded.authenticated);
    }),
  );

  it.effect("disables headless connect without a running server", () =>
    Effect.gen(function* () {
      const baseDir = NodeFS.mkdtempSync(
        NodePath.join(NodeOS.tmpdir(), "t3-cli-cloud-unlink-test-"),
      );
      const { output } = yield* captureStdout(
        runConnectCli(["connect", "unlink", "--base-dir", baseDir]),
      );

      assert.equal(output, "T3 Connect is disabled locally.");
    }),
  );

  it.effect("logs out of headless connect and removes the stored CLI authorization", () =>
    Effect.gen(function* () {
      const baseDir = NodeFS.mkdtempSync(
        NodePath.join(NodeOS.tmpdir(), "t3-cli-cloud-logout-test-"),
      );
      const { secretsDir } = yield* ServerConfig.deriveServerPaths(baseDir, undefined);
      const tokenPath = NodePath.join(secretsDir, "cloud-cli-oauth-token.bin");
      NodeFS.mkdirSync(secretsDir, { recursive: true });
      NodeFS.writeFileSync(tokenPath, "invalid persisted token");

      const { output } = yield* captureStdout(
        runConnectCli(["connect", "logout", "--base-dir", baseDir]),
      );

      assert.equal(
        output,
        "Signed out of T3 Connect locally.\nThe background service is managed separately with `t3 service`.",
      );
      assert.isFalse(NodeFS.existsSync(tokenPath));
    }),
  );

  it.effect("executes auth pairing subcommands and redacts secrets from list output", () =>
    Effect.gen(function* () {
      const baseDir = NodeFS.mkdtempSync(
        NodePath.join(NodeOS.tmpdir(), "t3-cli-auth-pairing-test-"),
      );

      const createdOutput = yield* captureStdout(
        runCli(["auth", "pairing", "create", "--base-dir", baseDir, "--json"]),
      );
      const created = JSON.parse(createdOutput.output) as {
        readonly id: string;
        readonly credential: string;
      };
      const listedOutput = yield* captureStdout(
        runCli(["auth", "pairing", "list", "--base-dir", baseDir, "--json"]),
      );
      const listed = JSON.parse(listedOutput.output) as ReadonlyArray<{
        readonly id: string;
        readonly credential?: string;
      }>;

      assert.equal(typeof created.id, "string");
      assert.equal(typeof created.credential, "string");
      assert.equal(created.credential.length > 0, true);
      assert.equal(listed.length, 1);
      assert.equal(listed[0]?.id, created.id);
      assert.equal("credential" in (listed[0] ?? {}), false);
    }),
  );

  it.effect("executes auth session subcommands and redacts secrets from list output", () =>
    Effect.gen(function* () {
      const baseDir = NodeFS.mkdtempSync(
        NodePath.join(NodeOS.tmpdir(), "t3-cli-auth-session-test-"),
      );

      const issuedOutput = yield* captureStdout(
        runCli(["auth", "session", "issue", "--base-dir", baseDir, "--json"]),
      );
      const issued = JSON.parse(issuedOutput.output) as {
        readonly sessionId: string;
        readonly token: string;
        readonly scopes: ReadonlyArray<string>;
      };
      const listedOutput = yield* captureStdout(
        runCli(["auth", "session", "list", "--base-dir", baseDir, "--json"]),
      );
      const listed = JSON.parse(listedOutput.output) as ReadonlyArray<{
        readonly sessionId: string;
        readonly token?: string;
        readonly scopes: ReadonlyArray<string>;
      }>;

      assert.equal(typeof issued.sessionId, "string");
      assert.equal(typeof issued.token, "string");
      assert.deepEqual(issued.scopes, [
        "orchestration:read",
        "orchestration:operate",
        "terminal:operate",
        "review:write",
        "relay:read",
        "access:read",
        "access:write",
        "relay:write",
      ]);
      assert.equal(listed.length, 1);
      assert.equal(listed[0]?.sessionId, issued.sessionId);
      assert.deepEqual(listed[0]?.scopes, [
        "orchestration:read",
        "orchestration:operate",
        "terminal:operate",
        "review:write",
        "relay:read",
        "access:read",
        "access:write",
        "relay:write",
      ]);
      assert.equal("token" in (listed[0] ?? {}), false);
    }).pipe(Effect.provide(DisconnectedLauncherChildLayer)),
  );

  it.effect("rejects invalid ttl values before running auth commands", () =>
    Effect.gen(function* () {
      const error = yield* runCliWithRuntime(["auth", "pairing", "create", "--ttl", "soon"]).pipe(
        Effect.flip,
      );

      if (!CliError.isCliError(error)) {
        assert.fail(`Expected CliError, got ${String(error)}`);
      }
      if (error._tag !== "ShowHelp") {
        assert.fail(`Expected ShowHelp, got ${error._tag}`);
      }
      assert.deepEqual(error.commandPath, ["t3", "auth", "pairing", "create"]);
      const ttlError = error.errors[0] as CliError.CliError | undefined;
      if (!ttlError || ttlError._tag !== "InvalidValue") {
        assert.fail(`Expected InvalidValue, got ${String(ttlError?._tag)}`);
      }
      assert.equal(ttlError.option, "ttl");
      assert.equal(ttlError.value, "soon");
      assert.isTrue(ttlError.message.includes("Invalid duration"));
      assert.isTrue(ttlError.message.includes("5m, 1h, 30d, or 15 minutes"));
    }),
  );

  it.effect("adds, renames, and removes projects offline through the orchestration engine", () =>
    Effect.gen(function* () {
      const baseDir = NodeFS.mkdtempSync(
        NodePath.join(NodeOS.tmpdir(), "t3-cli-projects-offline-test-"),
      );
      const workspaceRoot = NodeFS.mkdtempSync(
        NodePath.join(NodeOS.tmpdir(), "t3-cli-projects-workspace-"),
      );

      yield* runCliWithRuntime([
        "project",
        "add",
        workspaceRoot,
        "--title",
        "Alpha",
        "--base-dir",
        baseDir,
      ]);
      const afterAdd = yield* readPersistedSnapshot(baseDir);
      const addedProject = afterAdd.projects.find(
        (project) => project.workspaceRoot === workspaceRoot && project.deletedAt === null,
      );
      assert.isTrue(addedProject !== undefined);
      assert.equal(addedProject?.title, "Alpha");

      yield* runCliWithRuntime(["project", "rename", workspaceRoot, "Beta", "--base-dir", baseDir]);
      const afterRename = yield* readPersistedSnapshot(baseDir);
      const renamedProject = afterRename.projects.find(
        (project) => project.id === addedProject?.id,
      );
      assert.equal(renamedProject?.title, "Beta");
      assert.equal(renamedProject?.deletedAt, null);

      yield* runCliWithRuntime([
        "project",
        "remove",
        addedProject?.id ?? "",
        "--base-dir",
        baseDir,
      ]);
      const afterRemove = yield* readPersistedSnapshot(baseDir);
      const removedProject = afterRemove.projects.find(
        (project) => project.id === addedProject?.id,
      );
      assert.isTrue((removedProject?.deletedAt ?? null) !== null);
    }),
  );

  it.effect("force removes projects that still contain threads", () =>
    Effect.gen(function* () {
      const baseDir = NodeFS.mkdtempSync(
        NodePath.join(NodeOS.tmpdir(), "t3-cli-projects-force-remove-test-"),
      );
      const workspaceRoot = NodeFS.mkdtempSync(
        NodePath.join(NodeOS.tmpdir(), "t3-cli-projects-force-remove-workspace-"),
      );

      yield* runCliWithRuntime(["project", "add", workspaceRoot, "--base-dir", baseDir]);
      const afterAdd = yield* readPersistedSnapshot(baseDir);
      const project = afterAdd.projects.find(
        (candidate) => candidate.workspaceRoot === workspaceRoot && candidate.deletedAt === null,
      );
      assert.isTrue(project !== undefined);

      const config = yield* makeCliTestServerConfig(baseDir);
      yield* Effect.gen(function* () {
        const threads = yield* ThreadManagement.ThreadManagementService;
        yield* threads.dispatch({
          type: "thread.create",
          commandId: CommandId.make("cmd-cli-force-remove-thread"),
          threadId: ThreadId.make("thread-cli-force-remove"),
          projectId: project!.id,
          title: "Thread",
          modelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5-codex",
          },
          interactionMode: "default",
          runtimeMode: "approval-required",
          branch: null,
          worktreePath: null,
          createdBy: "user",
          creationSource: "server",
        });
      }).pipe(Effect.provide(makeProjectPersistenceLayer(config)));

      yield* runCliWithRuntime([
        "project",
        "remove",
        project!.id,
        "--force",
        "--base-dir",
        baseDir,
      ]);
      const afterRemove = yield* readPersistedSnapshot(baseDir);
      assert.isTrue(
        (afterRemove.projects.find((candidate) => candidate.id === project!.id)?.deletedAt ??
          null) !== null,
      );
      assert.isUndefined(
        afterRemove.threads.find((thread) => thread.id === "thread-cli-force-remove"),
      );
    }),
  );

  it.effect("routes project commands through a running server when runtime state is present", () =>
    Effect.gen(function* () {
      const baseDir = NodeFS.mkdtempSync(
        NodePath.join(NodeOS.tmpdir(), "t3-cli-projects-live-test-"),
      );
      const workspaceRoot = NodeFS.mkdtempSync(
        NodePath.join(NodeOS.tmpdir(), "t3-cli-projects-live-workspace-"),
      );

      yield* withLiveProjectCliServer(baseDir, () =>
        Effect.gen(function* () {
          yield* runCliWithRuntime([
            "project",
            "add",
            workspaceRoot,
            "--title",
            "Live Project",
            "--base-dir",
            baseDir,
          ]);
          const projects = yield* ProjectService.ProjectService;
          const readModel = yield* projects.snapshot;
          const addedProject = readModel.projects.find(
            (project) => project.workspaceRoot === workspaceRoot && project.deletedAt === null,
          );
          assert.isTrue(addedProject !== undefined);
          assert.equal(addedProject?.title, "Live Project");
        }),
      );
    }),
  );

  it.effect("rejects dev-url on project commands", () =>
    Effect.gen(function* () {
      const workspaceRoot = NodeFS.mkdtempSync(
        NodePath.join(NodeOS.tmpdir(), "t3-cli-projects-unknown-option-workspace-"),
      );
      const error = yield* runCliWithRuntime([
        "project",
        "add",
        workspaceRoot,
        "--dev-url",
        "http://127.0.0.1:5173",
      ]).pipe(Effect.flip);

      if (!CliError.isCliError(error)) {
        assert.fail(`Expected CliError, got ${String(error)}`);
      }
      if (error._tag !== "ShowHelp") {
        assert.fail(`Expected ShowHelp, got ${error._tag}`);
      }
      assert.deepEqual(error.commandPath, ["t3", "project", "add"]);
      const optionError = error.errors[0] as CliError.CliError | undefined;
      if (!optionError || optionError._tag !== "UnrecognizedOption") {
        assert.fail(`Expected UnrecognizedOption, got ${String(optionError?._tag)}`);
      }
      assert.equal(optionError.option, "--dev-url");
    }),
  );
});
