// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeURL from "node:url";

import { NodeHttpServer } from "@effect/platform-node";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { afterEach, describe, expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  ProviderInstanceId,
  ThreadId,
  type ServerSettings as ServerSettingsValue,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Redacted from "effect/Redacted";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { HttpRouter } from "effect/unstable/http";
import type { OmpRpcClient, OmpRpcNotification } from "effect-omp-rpc/client";
import { OmpRpcProtocolError } from "effect-omp-rpc/errors";
import type { OmpRpcResponse } from "effect-omp-rpc/schema";

import * as ServerConfig from "../../config.ts";
import type { ResolvedModelConnection } from "../../customModels.ts";
import * as ServerEnvironment from "../../environment/ServerEnvironment.ts";
import * as McpHttpServer from "../../mcp/McpHttpServer.ts";
import type { McpCapability } from "../../mcp/McpInvocationContext.ts";
import {
  clearAllMcpProviderSessions,
  readMcpProviderSession,
  setMcpProviderSession,
} from "../../mcp/McpProviderSession.ts";
import * as McpSessionRegistry from "../../mcp/McpSessionRegistry.ts";
import { ComputeMcpGateway } from "../../mcp/toolkits/compute/ComputeMcpGateway.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import * as ProviderSessionRuntime from "../../persistence/ProviderSessionRuntime.ts";
import { WorkspaceBindingResolutionError } from "../../scient/projectScope/WorkspaceBinding.ts";
import { WorkspaceBindingResolver } from "../../scient/projectScope/WorkspaceBindingResolver.ts";
import { workspaceResolverForTest } from "../../scient/projectScope/WorkspaceBindingTestUtils.ts";
import * as ServerSettings from "../../serverSettings.ts";
import * as AnalyticsService from "../../telemetry/AnalyticsService.ts";
import * as ProviderAdapterRegistry from "../Services/ProviderAdapterRegistry.ts";
import * as ProviderService from "../Services/ProviderService.ts";
import { makeAdapterRegistryMock } from "../testUtils/providerAdapterRegistryMock.ts";
import { makeFakeOmpModelsExtension } from "../omp/OmpCustomModelsTestHelpers.ts";
import { makeOmpCustomModelsClientFactory } from "../omp/OmpCustomModels.ts";
import { ompProcessEnvironment } from "../omp/OmpEnvironment.ts";
import * as OmpExecutableGate from "../omp/OmpExecutableGate.ts";
import type { OmpProcessExit, OmpRpcProcess, OmpRpcProcessOptions } from "../omp/OmpRpcProcess.ts";
import type { OmpScientExtensionBootstrap } from "../omp/OmpScientExtension.ts";
import { ompScientExtensionSource } from "../omp/OmpScientExtension.ts";
import { SCIENT_CORE_AWARENESS } from "../ScientAwareness.ts";
import { makeOmpAdapter, type OmpAdapterOptions } from "./OmpAdapter.ts";
import * as ProviderEventLoggers from "./ProviderEventLoggers.ts";
import { makeProviderServiceLive } from "./ProviderService.ts";
import { ProviderSessionDirectoryLive } from "./ProviderSessionDirectory.ts";

type FakeProcess = OmpRpcClient & {
  readonly version: string;
  readonly shutdown: Effect.Effect<OmpProcessExit, never>;
};

const cleanExit: OmpProcessExit = { code: 0, forced: false, stderrTail: "" };
const readyFrame = {
  type: "ready" as const,
  protocolVersion: 1 as const,
  supportedProtocolVersions: [1, 2],
  maxFrameBytes: 1_048_576,
  maxReassembledFrameBytes: 67_108_864,
};
const success = (command: string, data: unknown = {}): OmpRpcResponse => ({
  id: "scient-extension-request",
  type: "response",
  command,
  success: true,
  data,
});

const makeClient = (input: {
  readonly events: Queue.Queue<OmpRpcNotification, Cause.Done>;
  readonly sessionDir: string;
  readonly overrides?: Partial<OmpRpcClient>;
}): FakeProcess => {
  const sessionFile = NodePath.join(input.sessionDir, "session.jsonl");
  return {
    version: "18.3.1",
    ready: Effect.succeed(readyFrame),
    events: Stream.fromQueue(input.events),
    flushEvents: () => Queue.offer(input.events, { _tag: "Drain" }).pipe(Effect.asVoid),
    command: () => Effect.succeed(success("command")),
    prompt: () => Effect.succeed(success("prompt", { agentInvoked: true })),
    steer: () => Effect.succeed(success("steer")),
    followUp: () => Effect.succeed(success("follow_up")),
    abort: () => Effect.succeed(success("abort")),
    getState: () =>
      Effect.sync(() => {
        NodeFS.mkdirSync(input.sessionDir, { recursive: true });
        NodeFS.writeFileSync(sessionFile, "{}\n");
        return {
          sessionFile,
          sessionId: "scient-extension-session",
          isStreaming: false,
          isCompacting: false,
        };
      }),
    getModels: () => Effect.succeed({ models: [] }),
    getCommands: () => Effect.succeed({ commands: [] }),
    setModel: () => Effect.succeed(success("set_model")),
    setThinkingLevel: () => Effect.succeed(success("set_thinking_level")),
    compact: () => Effect.succeed(success("compact")),
    switchSession: () => Effect.succeed({ cancelled: false }),
    setSubagentSubscription: () => Effect.succeed(success("set_subagent_subscription")),
    setEventFilter: (events) => Effect.succeed({ events: events === null ? null : [...events] }),
    limits: Effect.succeed({
      maxFrameBytes: readyFrame.maxFrameBytes,
      maxReassembledFrameBytes: readyFrame.maxReassembledFrameBytes,
    }),
    setHostTools: () => Effect.succeed(success("set_host_tools")),
    setHostUriSchemes: () => Effect.succeed(success("set_host_uri_schemes")),
    extensionUiResponse: () => Effect.void,
    hostToolUpdate: () => Effect.void,
    hostToolResult: () => Effect.void,
    hostUriResult: () => Effect.void,
    close: () => Effect.void,
    shutdown: Effect.succeed(cleanExit),
    ...input.overrides,
  };
};

let rootCounter = 0;
/** Roots made by the current test, removed after it whether it passed or not. */
const roots: Array<string> = [];
const makeRoot = (label: string) => {
  const root = NodePath.join(
    NodeOS.tmpdir(),
    `scient-omp-extension-${process.pid}-${label}-${rootCounter++}`,
  );
  NodeFS.rmSync(root, { recursive: true, force: true });
  NodeFS.mkdirSync(root, { recursive: true });
  roots.push(root);
  return NodeFS.realpathSync(root);
};

const instanceId = ProviderInstanceId.make("omp-scient-extension");
const token = "Bearer synthetic-scient-omp-token";
const endpoint = "http://127.0.0.1:43123/mcp";

const grantScientSession = (
  threadId: ThreadId,
  capabilities: ReadonlyArray<McpCapability> = ["preview", "skills:read", "sources:read"],
  providerInstanceId: ProviderInstanceId = instanceId,
) =>
  setMcpProviderSession({
    environmentId: EnvironmentId.make("environment-omp-extension"),
    threadId,
    providerSessionId: `provider-${String(threadId)}`,
    providerInstanceId,
    endpoint,
    authorizationHeader: token,
    capabilities: new Set(capabilities),
    agentDeviceEnvironment: { PATH: "/scient/device-shim", PATH_SEPARATOR: ":" },
  });

/** Every generated Scient extension or bootstrap file under the adapter's state directory. */
const extensionFiles = (root: string): ReadonlyArray<string> => {
  const sessions = NodePath.join(root, "state", "omp-sessions");
  if (!NodeFS.existsSync(sessions)) return [];
  return NodeFS.readdirSync(sessions, { recursive: true })
    .map(String)
    .filter((entry) => /scient-extension-[^/\\]+\.(?:mjs|bootstrap\.json)$/u.test(entry))
    .map((entry) => NodePath.join(sessions, entry));
};

/** The bootstrap file a generated extension names, and its contents. */
const bootstrapOf = (extension: string) => {
  const embedded = /\bSCIENT_BOOTSTRAP_PATH = ("(?:[^"\\]|\\.)*");/u.exec(
    NodeFS.readFileSync(extension, "utf8"),
  )?.[1];
  if (!embedded) throw new Error("The Scient extension does not name its bootstrap.");
  const path = JSON.parse(embedded) as string;
  return {
    path,
    mode: (NodeFS.statSync(path).mode & 0o777).toString(8),
    value: JSON.parse(NodeFS.readFileSync(path, "utf8")) as OmpScientExtensionBootstrap,
  };
};

/** What OMP does while it loads the extension: read the bootstrap, then delete it. */
const consumeBootstrap = (extension: string) => {
  const bootstrap = bootstrapOf(extension);
  NodeFS.rmSync(bootstrap.path);
  return bootstrap;
};

const extensionArgument = (options: OmpRpcProcessOptions): string | undefined => {
  const args = options.extraArgs ?? [];
  const index = args.indexOf("--extension");
  return index === -1 ? undefined : args[index + 1];
};

/** Poll real time until `read` holds. */
const waitUntil = (read: () => boolean, detail: string) =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < 400; attempt += 1) {
      if (read()) return;
      yield* Effect.sleep("5 millis");
    }
    return yield* Effect.die(new Error(detail));
  }).pipe(TestClock.withLive);

const makeAdapter = (input: {
  readonly root: string;
  readonly environment?: NodeJS.ProcessEnv;
  readonly makeProcess: NonNullable<OmpAdapterOptions["makeProcess"]>;
}) =>
  makeOmpAdapter({
    binaryPath: "omp",
    providerInstanceId: instanceId,
    stateDir: NodePath.join(input.root, "state"),
    attachmentsDir: NodePath.join(input.root, "attachments"),
    environment: input.environment ?? { PATH: "/usr/bin" },
    makeProcess: input.makeProcess,
  });

afterEach(() => {
  clearAllMcpProviderSessions();
  for (const root of roots.splice(0)) NodeFS.rmSync(root, { recursive: true, force: true });
});

describe("Scient tools, skills and awareness for Oh My Pi", () => {
  it.effect("passes the credential only in a private bootstrap, never the environment", () =>
    Effect.gen(function* () {
      const root = makeRoot("delivery");
      const launches: Array<OmpRpcProcessOptions> = [];
      const bootstraps: Array<ReturnType<typeof bootstrapOf>> = [];
      const inherited = ompProcessEnvironment({
        platform: "darwin",
        baseEnv: {
          PATH: "/usr/bin",
          SCIENT_OMP_MCP_ENDPOINT: "http://127.0.0.1:1/inherited",
          SCIENT_OMP_MCP_AUTHORIZATION: "Bearer inherited",
          SCIENT_OMP_AWARENESS: "inherited awareness",
        },
      });
      const adapter = yield* makeAdapter({
        root,
        environment: inherited,
        makeProcess: (options) =>
          Effect.gen(function* () {
            launches.push(options);
            // The file exists, is private and holds no secret while OMP runs.
            const file = extensionArgument(options)!;
            expect((NodeFS.statSync(file).mode & 0o777).toString(8)).toBe("600");
            const contents = NodeFS.readFileSync(file, "utf8");
            const bootstrap = consumeBootstrap(file);
            bootstraps.push(bootstrap);
            expect(contents).toBe(ompScientExtensionSource(bootstrap.path));
            expect(contents).not.toContain("synthetic-scient-omp-token");
            expect(contents).not.toContain(endpoint);
            const events = yield* Queue.unbounded<OmpRpcNotification, Cause.Done>();
            return makeClient({ events, sessionDir: options.sessionDir ?? root });
          }),
      });
      const threadId = ThreadId.make("omp-scient-delivery");
      grantScientSession(threadId);

      yield* adapter.startSession({ threadId, cwd: root, runtimeMode: "full-access" });

      expect(adapter.capabilities.mcpSessionInjection).toBe(true);
      expect(launches).toHaveLength(1);
      const options = launches[0]!;
      const file = extensionArgument(options)!;
      expect(options.extraArgs).toEqual(["--extension", file]);
      expect(NodePath.dirname(file)).toBe(NodeFS.realpathSync(options.sessionDir!));
      expect(options.extraArgs?.some((arg) => arg.includes("synthetic-scient-omp-token"))).toBe(
        false,
      );
      // Inherited copies were filtered out, and nothing was added back: the
      // session's values are only in the private bootstrap.
      expect(Object.keys(options.env ?? {}).filter((name) => name.startsWith("SCIENT_"))).toEqual(
        [],
      );
      // @effect-diagnostics-next-line preferSchemaOverJson:off
      expect(JSON.stringify(options.env)).not.toContain("synthetic-scient-omp-token");
      const bootstrap = bootstraps[0]!;
      expect(bootstrap.mode).toBe("600");
      expect(NodePath.dirname(bootstrap.path)).toBe(NodePath.dirname(file));
      expect(bootstrap.value.endpoint).toBe(endpoint);
      expect(bootstrap.value.authorization).toBe(token);
      const awareness = bootstrap.value.awareness;
      expect(awareness.startsWith(SCIENT_CORE_AWARENESS)).toBe(true);
      expect(awareness).toContain("## Scient browser");
      expect(awareness).toContain("## Scient skills");
      expect(awareness).toContain("`scient_skill_load`");
      expect(awareness).not.toContain("inherited awareness");
      // The device CLI shim is prepended like for every other MCP provider.
      expect(options.env?.PATH).toBe("/scient/device-shim:/usr/bin");
      expect(extensionFiles(root)).toEqual([file]);

      yield* adapter.stopSession(threadId);
      expect(NodeFS.existsSync(file)).toBe(false);
      expect(extensionFiles(root)).toHaveLength(0);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("delivers core awareness without a Scient tool connection", () =>
    Effect.gen(function* () {
      const root = makeRoot("no-mcp");
      const launches: Array<OmpRpcProcessOptions> = [];
      const bootstraps: Array<ReturnType<typeof bootstrapOf>> = [];
      const adapter = yield* makeAdapter({
        root,
        makeProcess: (options) =>
          Effect.gen(function* () {
            launches.push(options);
            bootstraps.push(consumeBootstrap(extensionArgument(options)!));
            const events = yield* Queue.unbounded<OmpRpcNotification, Cause.Done>();
            return makeClient({ events, sessionDir: options.sessionDir ?? root });
          }),
      });
      const threadId = ThreadId.make("omp-scient-no-mcp");

      yield* adapter.startSession({ threadId, cwd: root, runtimeMode: "full-access" });

      const options = launches[0]!;
      expect(extensionArgument(options)).toBeDefined();
      expect(bootstraps[0]?.value).toEqual({
        endpoint: null,
        authorization: null,
        awareness: SCIENT_CORE_AWARENESS,
      });
      expect(options.env?.PATH).toBe("/usr/bin");
      yield* adapter.stopAll();
      expect(extensionFiles(root)).toHaveLength(0);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("rejects a Scient tool session that belongs to another provider instance", () =>
    Effect.gen(function* () {
      const root = makeRoot("ownership");
      let launches = 0;
      const adapter = yield* makeAdapter({
        root,
        makeProcess: (options) =>
          Effect.gen(function* () {
            launches += 1;
            const events = yield* Queue.unbounded<OmpRpcNotification, Cause.Done>();
            return makeClient({ events, sessionDir: options.sessionDir ?? root });
          }),
      });
      const threadId = ThreadId.make("omp-scient-ownership");
      grantScientSession(threadId, ["preview"], ProviderInstanceId.make("omp-other-instance"));

      const failed = yield* adapter
        .startSession({ threadId, cwd: root, runtimeMode: "full-access" })
        .pipe(Effect.flip);

      expect(failed._tag).toBe("ProviderAdapterValidationError");
      expect(failed.message).toContain("belongs to another provider instance");
      expect(launches).toBe(0);
      expect(extensionFiles(root)).toHaveLength(0);
      expect(yield* adapter.hasSession(threadId)).toBe(false);

      // The same thread starts once its credential is this instance's.
      grantScientSession(threadId, ["preview"]);
      yield* adapter.startSession({ threadId, cwd: root, runtimeMode: "full-access" });
      expect(launches).toBe(1);
      yield* adapter.stopAll();
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("removes the extension on every close path", () =>
    Effect.gen(function* () {
      type Path = "stop" | "stop-all" | "start-failure" | "crash" | "adapter-close";
      const paths: ReadonlyArray<Path> = [
        "stop",
        "stop-all",
        "start-failure",
        "crash",
        "adapter-close",
      ];
      for (const closePath of paths) {
        const root = makeRoot(`close-${closePath}`);
        const scope = yield* Scope.make("sequential");
        const events = yield* Queue.unbounded<OmpRpcNotification, Cause.Done>();
        const launched: Array<string> = [];
        const adapter = yield* makeAdapter({
          root,
          makeProcess: (options) =>
            Effect.sync(() => {
              launched.push(extensionArgument(options)!);
              return makeClient({
                events,
                sessionDir: options.sessionDir ?? root,
                overrides:
                  closePath === "start-failure"
                    ? { ready: Effect.fail(new OmpRpcProtocolError({ detail: "no ready" })) }
                    : {},
              });
            }),
        }).pipe(Effect.provideService(Scope.Scope, scope));
        const threadId = ThreadId.make(`omp-scient-close-${closePath}`);
        grantScientSession(threadId);

        const started = yield* adapter
          .startSession({ threadId, cwd: root, runtimeMode: "full-access" })
          .pipe(Effect.exit);
        expect(launched, closePath).toHaveLength(1);
        if (closePath === "start-failure") {
          expect(Exit.isFailure(started), closePath).toBe(true);
        } else {
          expect(Exit.isSuccess(started), closePath).toBe(true);
          expect(NodeFS.existsSync(launched[0]!), closePath).toBe(true);
          // This stand-in never loads the extension: its unread bootstrap was
          // deleted once OMP reported ready, before any turn could read it.
          expect(extensionFiles(root), closePath).toEqual([launched[0]!]);
        }
        if (closePath === "stop") yield* adapter.stopSession(threadId);
        if (closePath === "stop-all") yield* adapter.stopAll();
        if (closePath === "crash") yield* Queue.end(events);
        if (closePath === "adapter-close") yield* Scope.close(scope, Exit.void);
        yield* waitUntil(
          () => !NodeFS.existsSync(launched[0]!),
          `${closePath} left the Scient extension behind`,
        );
        expect(extensionFiles(root), closePath).toHaveLength(0);
        yield* Scope.close(scope, Exit.void);
      }
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("stacks with the custom-model extension in the same OMP process", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const root = makeRoot("stacked");
        const spawned: Array<OmpRpcProcessOptions> = [];
        const connection: ResolvedModelConnection = {
          id: "local",
          name: "Local",
          protocol: "openai-completions",
          baseUrl: "http://127.0.0.1:11434/v1",
          credentialId: "credential",
          apiKey: Redacted.make("synthetic-model-key"),
          models: [
            {
              id: "model",
              modelId: "local-model",
              name: "Local model",
              configurationMode: "manual",
              contextWindow: 32_000,
              maxOutputTokens: 2_048,
              images: false,
              reasoning: false,
              instanceIds: [instanceId],
            },
          ],
        };
        const settingsChanges = yield* Queue.unbounded<ServerSettingsValue>();
        const customModels = yield* makeOmpCustomModelsClientFactory(
          {
            resolveCustomModels: () => Effect.succeed([connection]),
            subscribeChanges: Effect.succeed(Stream.fromQueue(settingsChanges)),
          },
          instanceId,
          NodePath.join(root, "state"),
          (options) =>
            Effect.gen(function* () {
              spawned.push(options);
              // Real OMP loads the custom-model extension at startup, which
              // registers the models and acknowledges their generation.
              const extension = makeFakeOmpModelsExtension(options);
              yield* Effect.promise(() => extension.start());
              yield* Effect.addFinalizer(() => Effect.sync(() => extension.stop()));
              const events = yield* Queue.unbounded<OmpRpcNotification, Cause.Done>();
              return makeClient({
                events,
                sessionDir: options.sessionDir ?? root,
              }) as unknown as OmpRpcProcess;
            }),
        );
        const adapter = yield* makeAdapter({
          root,
          makeProcess: customModels,
        });
        const threadId = ThreadId.make("omp-scient-stacked");
        grantScientSession(threadId);

        yield* adapter.startSession({ threadId, cwd: root, runtimeMode: "full-access" });

        const options = spawned[0]!;
        const extensions = (options.extraArgs ?? []).flatMap((arg, index, args) =>
          args[index - 1] === "--extension" ? [arg] : [],
        );
        expect(extensions).toHaveLength(2);
        expect(NodePath.basename(extensions[0]!)).toMatch(/^scient-extension-.+\.mjs$/u);
        expect(NodePath.basename(extensions[1]!)).toBe("scient-custom-models.mjs");
        // Each extension has its own bootstrap; none of it is in the environment.
        expect(Object.keys(options.env ?? {}).filter((name) => name.startsWith("SCIENT_"))).toEqual(
          [],
        );
        // @effect-diagnostics-next-line preferSchemaOverJson:off
        const environment = JSON.stringify(options.env);
        expect(environment).not.toContain(token);
        expect(environment).not.toContain("synthetic-model-key");
        yield* adapter.stopAll();
        expect(NodeFS.existsSync(extensions[0]!)).toBe(false);
      }),
    ).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, OmpExecutableGate.layer))),
  );
});

type LoadedTool = {
  readonly name: string;
  readonly loadMode?: string;
  readonly execute: (
    id: string,
    args: unknown,
  ) => Promise<{
    readonly content: ReadonlyArray<{ readonly type: string; readonly text?: string }>;
  }>;
};

/**
 * Stands in for the `omp` binary: imports the extension file the adapter
 * passed, which reads its bootstrap, against Scient's real MCP server.
 */
const loadExtensionLikeOmp = (options: OmpRpcProcessOptions, tools: Map<string, LoadedTool>) =>
  Effect.promise(async () => {
    const file = extensionArgument(options);
    if (!file) throw new Error("Oh My Pi was started without the Scient extension.");
    const module = (await import(/* @vite-ignore */ NodeURL.pathToFileURL(file).href)) as {
      readonly default: (pi: unknown) => Promise<void>;
    };
    const install = module.default;
    await install({
      on: () => undefined,
      registerCommand: () => undefined,
      registerTool: (tool: LoadedTool) => {
        tools.set(tool.name, tool);
      },
    });
  });

const mcpEnvironmentLayer = Layer.succeed(
  ServerEnvironment.ServerEnvironment,
  ServerEnvironment.ServerEnvironment.of({
    getEnvironmentId: Effect.succeed(EnvironmentId.make("environment-omp-mcp")),
    getDescriptor: Effect.die("unused"),
  }),
);

/** Scient's authenticated MCP transport with the Compute toolkit, served on a real port. */
const ScientMcpServerLive = HttpRouter.serve(
  McpHttpServer.ScientComputeToolkitRegistrationLive.pipe(
    Layer.provide(
      Layer.succeed(ComputeMcpGateway, {
        runtimeInventory: () => Effect.succeed({ languages: [] }),
      }),
    ),
    Layer.provideMerge(McpHttpServer.McpTransportLive),
    // A projectless thread: workspace tools are withheld, Compute inventory is not.
    Layer.provide(
      Layer.succeed(WorkspaceBindingResolver, {
        ...workspaceResolverForTest(new Map()),
        resolveThread: () =>
          Effect.fail(
            new WorkspaceBindingResolutionError({ operation: "test", kind: "project-required" }),
          ),
      }),
    ),
    Layer.provideMerge(McpSessionRegistry.layer),
    Layer.provide(mcpEnvironmentLayer),
  ),
  { disableListenLog: true, disableLogger: true },
);

describe("Scient tool authority for Oh My Pi", () => {
  it.effect("rejects a stopped session's tool calls at Scient's MCP server", () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* Layer.build(ScientMcpServerLive);
        const root = makeRoot("mcp-authority");
        const ompInstanceId = ProviderInstanceId.make("omp");
        const tools = new Map<string, LoadedTool>();
        const adapter = yield* makeOmpAdapter({
          binaryPath: "omp",
          providerInstanceId: ompInstanceId,
          stateDir: NodePath.join(root, "state"),
          attachmentsDir: NodePath.join(root, "attachments"),
          environment: { PATH: "/usr/bin" },
          makeProcess: (options) =>
            Effect.gen(function* () {
              yield* loadExtensionLikeOmp(options, tools);
              const events = yield* Queue.unbounded<OmpRpcNotification, Cause.Done>();
              return makeClient({ events, sessionDir: options.sessionDir ?? root });
            }),
        });
        const providerLayer = makeProviderServiceLive().pipe(
          Layer.provide(
            Layer.succeed(
              ProviderAdapterRegistry.ProviderAdapterRegistry,
              makeAdapterRegistryMock({ [adapter.provider]: adapter }),
            ),
          ),
          Layer.provide(
            ProviderSessionDirectoryLive.pipe(
              Layer.provide(ProviderSessionRuntime.layer),
              Layer.provide(SqlitePersistenceMemory),
            ),
          ),
          Layer.provide(ServerSettings.ServerSettingsService.layerTest()),
          Layer.provide(ServerConfig.layerTest(root, { prefix: "scient-omp-mcp-authority-" })),
          Layer.provide(AnalyticsService.layerTest),
          Layer.provide(
            Layer.succeed(
              ProviderEventLoggers.ProviderEventLoggers,
              ProviderEventLoggers.NoOpProviderEventLoggers,
            ),
          ),
        );
        const threadId = ThreadId.make("omp-mcp-authority");

        yield* Effect.gen(function* () {
          const provider = yield* ProviderService.ProviderService;
          yield* provider.startSession(threadId, {
            provider: adapter.provider,
            providerInstanceId: ompInstanceId,
            threadId,
            cwd: root,
            runtimeMode: "full-access",
          });
          const credential = readMcpProviderSession(threadId);
          expect(credential?.providerInstanceId).toBe(ompInstanceId);
          const inventory = tools.get("scient_compute_inventory");
          expect(inventory?.loadMode).toBe("essential");
          const allowed = yield* Effect.promise(() => inventory!.execute("call-1", {}));
          expect(allowed.content.length).toBeGreaterThan(0);

          yield* provider.stopSession({ threadId });

          expect(readMcpProviderSession(threadId)).toBeUndefined();
          const rejected = yield* Effect.promise(() =>
            inventory!.execute("call-2", {}).then(
              () => "accepted",
              (error: unknown) => String(error),
            ),
          );
          expect(rejected).toContain("Scient tool connection returned HTTP 401.");
          expect(extensionFiles(root)).toHaveLength(0);
        }).pipe(Effect.provide(providerLayer));
      }),
    ).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, NodeHttpServer.layerTest))),
  );
});
