import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  ProviderInstanceId,
  type PiSettings,
  type ServerSettings as ServerSettingsData,
} from "@t3tools/contracts";
import type * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Predicate from "effect/Predicate";
import * as PlatformError from "effect/PlatformError";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { FetchHttpClient, HttpClient } from "effect/http";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import * as BackgroundPolicy from "../../background/BackgroundPolicy.ts";
import * as ServerConfig from "../../config.ts";
import * as ServerSettings from "../../serverSettings.ts";
import * as IdAllocator from "../../orchestration-v2/IdAllocator.ts";
import type { ResolvedModelConnection } from "../../customModels.ts";
import { PiDriver } from "./PiDriver.ts";

const decodeJson = Schema.decodeSync(Schema.fromJsonString(Schema.Unknown));
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decodeBootstrap = Schema.decodeUnknownEffect(
  Schema.Array(
    Schema.Struct({
      id: Schema.String,
      config: Schema.Struct({
        models: Schema.Array(
          Schema.Struct({
            id: Schema.String,
            name: Schema.String,
            reasoning: Schema.Boolean,
            contextWindow: Schema.Number,
            maxTokens: Schema.Number,
          }),
        ),
      }),
    }),
  ),
);
const testLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: "scient-pi-driver-discovery-",
}).pipe(
  Layer.provideMerge(NodeServices.layer),
  Layer.provideMerge(FetchHttpClient.layer),
  Layer.provideMerge(IdAllocator.layer),
  Layer.provideMerge(ServerSettings.layerTest()),
  Layer.provideMerge(
    Layer.mock(BackgroundPolicy.BackgroundPolicy)({
      shouldRunScopeWork: () => Effect.succeed(false),
    }),
  ),
);

it.layer(testLayer)("PiDriver native discovery and runtime envelope", (it) => {
  it.effect.each(
    [false, true].map((custom) => ({
      caseTitle: `bootstraps instance-scoped native discovery with custom connections=${custom}`,
      custom,
    })),
  )("$caseTitle", ({ custom }) =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped();
        const baseSettings = yield* ServerSettings.ServerSettingsService;
        const instanceId = ProviderInstanceId.make("pi-discovery-owner");
        let connections: ReadonlyArray<ResolvedModelConnection> = custom
          ? [
              {
                id: "connection",
                name: "Scoped connection",
                baseUrl: "https://unused.example.test/v1",
                protocol: "openai-completions",
                credentialId: "fixture",
                apiKey: Redacted.make("synthetic-fixture"),
                models: [
                  {
                    id: "entry",
                    modelId: "model/with space",
                    name: "Original model",
                    contextWindow: 32000,
                    maxOutputTokens: 1000,
                    images: false,
                    reasoning: false,
                    instanceIds: [instanceId],
                  },
                ],
              },
            ]
          : [];
        const current = yield* baseSettings.getSettings;
        const snapshot = (): ServerSettingsData => ({
          ...current,
          customModels: { revision: 0, connections },
        });
        const updates = yield* PubSub.unbounded<ServerSettingsData>();
        const requestedInstances: string[] = [];
        const settings = {
          ...baseSettings,
          getSettings: Effect.sync(snapshot),
          streamChanges: Stream.fromPubSub(updates),
          subscribeChanges: Effect.succeed(Stream.fromPubSub(updates)),
          resolveCustomModels: (id: ProviderInstanceId) =>
            Effect.sync(() => {
              requestedInstances.push(id);
              return connections.flatMap((connection) => {
                const models = connection.models.filter((model) => model.instanceIds.includes(id));
                return models.length ? [{ ...connection, models }] : [];
              });
            }),
        };
        const nativeLaunches: Array<{ args: ReadonlyArray<string>; env: NodeJS.ProcessEnv }> = [];
        const httpClient = yield* HttpClient.HttpClient;
        const spawner = ChildProcessSpawner.make((command) =>
          Effect.gen(function* () {
            if (!ChildProcess.isStandardCommand(command))
              return yield* Effect.die("Expected direct native Pi command");
            const args = command.args;
            const env = command.options.env ?? {};
            const output = yield* Queue.unbounded<Uint8Array, Cause.Done>();
            if (args.includes("--version")) {
              yield* Queue.offer(output, new TextEncoder().encode("0.84.4\n"));
              yield* Queue.end(output);
            } else nativeLaunches.push({ args, env });
            let buffer = "";
            const decoder = new TextDecoder();
            const handle = ChildProcessSpawner.makeHandle({
              pid: ChildProcessSpawner.ProcessId(999999999),
              exitCode: args.includes("--version")
                ? Effect.succeed(ChildProcessSpawner.ExitCode(0))
                : Effect.never,
              isRunning: Effect.succeed(!args.includes("--version")),
              kill: () => Queue.end(output).pipe(Effect.asVoid),
              unref: Effect.succeed(Effect.void),
              stdin: Sink.forEach((chunk: Uint8Array) =>
                Effect.gen(function* () {
                  buffer += decoder.decode(chunk, { stream: true });
                  const lines = buffer.split("\n");
                  buffer = lines.pop() ?? "";
                  for (const line of lines.filter(Boolean)) {
                    const request = decodeJson(line);
                    if (!Predicate.isObject(request))
                      return yield* Effect.die("Invalid native Pi request");
                    let data: unknown = {};
                    if (request.type === "get_commands")
                      data = {
                        commands: [
                          { name: "scient-models-refresh", source: "extension" },
                          { name: "skill:review", source: "skill" },
                        ],
                      };
                    if (request.type === "get_available_models" || request.type === "prompt") {
                      if (!env.SCIENT_PI_MODELS_URL || !env.SCIENT_PI_MODELS_TOKEN)
                        return yield* Effect.die("Production discovery omitted instance bootstrap");
                      const response = yield* HttpClient.get(env.SCIENT_PI_MODELS_URL, {
                        headers: { authorization: `Bearer ${env.SCIENT_PI_MODELS_TOKEN}` },
                      });
                      assert.equal(response.status, 200);
                      const bootstrap = yield* response.json.pipe(Effect.flatMap(decodeBootstrap));
                      data =
                        request.type === "prompt"
                          ? {}
                          : {
                              models: bootstrap.flatMap((connection) =>
                                connection.config.models.map((model) => ({
                                  ...model,
                                  provider: connection.id,
                                })),
                              ),
                            };
                    }
                    yield* Queue.offer(
                      output,
                      new TextEncoder().encode(
                        `${encodeJson({ type: "response", id: request.id, command: request.type, success: true, data })}\n`,
                      ),
                    );
                  }
                }).pipe(
                  Effect.provideService(HttpClient.HttpClient, httpClient),
                  Effect.mapError((cause) =>
                    PlatformError.systemError({
                      _tag: "Unknown",
                      module: "PiDiscoveryNativeFixture",
                      method: "writeResponse",
                      description: "Could not read or decode the private model bootstrap response.",
                      cause,
                    }),
                  ),
                ),
              ),
              stdout: Stream.fromQueue(output),
              stderr: Stream.empty,
              all: Stream.empty,
              getInputFd: () => Sink.drain,
              getOutputFd: () => Stream.empty,
            });
            return handle;
          }),
        );
        const instance = yield* PiDriver.create({
          instanceId,
          displayName: undefined,
          enabled: true,
          environment: [{ name: "HOME", value: root, sensitive: false }],
          config: { ...PiDriver.defaultConfig(), binaryPath: `${root}/pi-fixture` },
        }).pipe(
          Effect.provideService(ServerSettings.ServerSettingsService, settings),
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        );
        const initial = yield* instance.snapshot.getSnapshot;
        assert.isDefined(initial.connection?.runtime);
        assert.deepEqual(initial.connection?.methods, []);
        assert.equal(initial.connection?.canDisconnect, false);
        const checked = yield* instance.snapshot.refresh;
        assert.deepEqual(checked.connection?.runtime, initial.connection?.runtime);
        assert.isTrue(nativeLaunches.length > 0);
        for (const launch of nativeLaunches) {
          assert.include(launch.args, "--no-session");
          assert.equal(launch.args.filter((arg) => arg === "--mode").length, 1);
          assert.include(launch.args, "--extension");
          assert.equal(launch.env.HOME, root);
          assert.isString(launch.env.SCIENT_PI_MODELS_URL);
        }
        assert.isTrue(requestedInstances.every((id) => id === instanceId));
        if (!custom) {
          assert.equal(checked.auth.status, "unauthenticated");
          assert.deepEqual(checked.modelConnections, []);
          return;
        }
        assert.equal(checked.auth.status, "authenticated");
        assert.equal(
          checked.models.find((model) => model.name === "Original model")?.subProvider,
          "Scoped connection",
        );
        assert.equal(checked.modelConnections?.[0]?.state, "available");
        const observerReady = yield* Deferred.make<void>();
        const refreshed = yield* instance.snapshot.streamChanges.pipe(
          Stream.tap(() => Deferred.succeed(observerReady, undefined)),
          Stream.filter((value) => value.models.some((model) => model.name === "Renamed model")),
          Stream.runHead,
          Effect.forkScoped,
        );
        yield* instance.snapshot.refresh;
        yield* Deferred.await(observerReady);
        const before = nativeLaunches.length;
        const first = connections[0];
        if (!first) return yield* Effect.die("Missing owned connection");
        connections = [
          ...connections,
          {
            ...first,
            id: "peer",
            models: first.models.map((model) => ({
              ...model,
              instanceIds: [ProviderInstanceId.make("other-instance")],
            })),
          },
        ];
        yield* PubSub.publish(updates, snapshot());
        connections = connections.map((connection) =>
          connection.id === "connection"
            ? {
                ...connection,
                models: connection.models.map((model) => ({ ...model, name: "Renamed model" })),
              }
            : connection,
        );
        yield* PubSub.publish(updates, snapshot());
        yield* Fiber.join(refreshed);
        assert.equal(nativeLaunches.length, before + 1);
        const updated = yield* instance.snapshot.getSnapshot;
        assert.equal(
          updated.models.find((model) => model.name === "Renamed model")?.subProvider,
          "Scoped connection",
        );
        assert.deepEqual(updated.connection?.runtime, initial.connection?.runtime);
        if (!instance.snapshotForCwd) return yield* Effect.die("Missing workspace discovery");
        const workspace = yield* instance.snapshotForCwd(root);
        assert.deepEqual(workspace.connection?.runtime, initial.connection?.runtime);
      }),
    ),
  );
});

const layerTest = Layer.mergeAll(
  ServerConfig.layerTest("/machine", { prefix: "t3-pi-driver-" }),
  IdAllocator.layer,
  ServerSettings.layerTest({ enableProviderUpdateChecks: false }),
  Layer.mock(BackgroundPolicy.BackgroundPolicy)({
    shouldRunScopeWork: () => Effect.succeed(false),
  }),
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make(() => Effect.die("Unexpected HTTP")),
  ),
).pipe(Layer.provideMerge(NodeServices.layer));

const decodeRequest = Schema.decodeSync(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
);
const encoder = new TextEncoder();
const personalSkill = {
  name: "skill:personal",
  source: "skill",
  sourceInfo: { scope: "user", path: "/home/.pi/agent/skills/personal/SKILL.md" },
};

// Respond through the real stdio transport, with a distinct command catalog for each cwd.
const makePiSpawner = Effect.gen(function* () {
  const pendingCommand = yield* Deferred.make<void>();
  const launches: Array<ChildProcess.StandardCommand> = [];
  const spawner = ChildProcessSpawner.make((command) =>
    Effect.gen(function* () {
      assert.isTrue(ChildProcess.isStandardCommand(command));
      if (!ChildProcess.isStandardCommand(command)) return yield* Effect.die("Unexpected pipeline");
      launches.push(command);
      const version = command.args.includes("--version");
      const stdout = yield* Queue.unbounded<Uint8Array>();
      const cwd = command.options.cwd;
      return ChildProcessSpawner.makeHandle({
        // Outside the valid PID range, so transport cleanup cannot signal a real process.
        pid: ChildProcessSpawner.ProcessId(999_999_999),
        exitCode: version ? Effect.succeed(ChildProcessSpawner.ExitCode(0)) : Effect.never,
        isRunning: Effect.succeed(!version),
        kill: () => Effect.void,
        unref: Effect.succeed(Effect.void),
        stdin: Sink.forEach((chunk: Uint8Array) => {
          const request = decodeRequest(new TextDecoder().decode(chunk).trim());
          if (cwd === "/pending" && request.type === "get_commands") {
            return Deferred.succeed(pendingCommand, undefined).pipe(Effect.asVoid);
          }
          const failed = cwd === "/failed" && request.type === "get_commands";
          const data =
            request.type === "get_commands"
              ? {
                  commands: [
                    { name: "scient-models-refresh", source: "extension" },
                    personalSkill,
                    ...(cwd === "/machine"
                      ? []
                      : [
                          {
                            name: `skill:${cwd?.slice(1)}`,
                            source: "skill",
                            sourceInfo: {
                              scope: "project",
                              path: `${cwd}/.agents/skills/SKILL.md`,
                            },
                          },
                          { name: `prompt-${cwd?.slice(1)}`, source: "prompt" },
                        ]),
                  ],
                }
              : request.type === "get_available_models"
                ? { models: [{ provider: "test", id: "model" }] }
                : {};
          return Queue.offer(
            stdout,
            encoder.encode(
              `${JSON.stringify({ type: "response", id: request.id, command: request.type, success: !failed, data, ...(failed ? { error: "commands unavailable" } : {}) })}\n`,
            ),
          ).pipe(Effect.asVoid);
        }),
        stdout: version ? Stream.succeed(encoder.encode("1.0.2\n")) : Stream.fromQueue(stdout),
        stderr: Stream.empty,
        all: Stream.empty,
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
      });
    }),
  );
  return { spawner, launches, pendingCommand };
});

const create = (config: Partial<PiSettings> = {}, enabled = true) =>
  PiDriver.create({
    instanceId: ProviderInstanceId.make("pi-workspace-test"),
    displayName: "My Pi",
    accentColor: "#abcdef",
    environment: [{ name: "PI_CODING_AGENT_DIR", value: "/isolated-pi", sensitive: false }],
    enabled,
    config: { ...PiDriver.defaultConfig(), binaryPath: "custom-pi", ...config },
  });

it.layer(layerTest)("PiDriver workspace discovery", (it) => {
  it.effect("keeps each workspace's skills and commands separate from the machine catalog", () =>
    Effect.gen(function* () {
      const { spawner, launches } = yield* makePiSpawner;
      const instance = yield* create({ launchArgs: '--approve --skill "extra skill"' }).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      );
      yield* instance.snapshot.refresh;
      assert.isDefined(instance.snapshotForCwd);
      const [first, second] = yield* Effect.all(
        [instance.snapshotForCwd!("/first"), instance.snapshotForCwd!("/second")],
        { concurrency: "unbounded" },
      );
      assert.deepEqual(
        first.skills.map((skill) => skill.name),
        ["personal", "first"],
      );
      assert.deepEqual(
        second.skills.map((skill) => skill.name),
        ["personal", "second"],
      );
      assert.deepEqual(
        first.slashCommands.map((command) => command.name),
        ["compact", "prompt-first"],
      );
      const machine = yield* instance.snapshot.getSnapshot;
      assert.deepEqual(
        machine.skills.map((skill) => skill.name),
        ["personal"],
      );
      assert.deepEqual(
        machine.slashCommands.map((command) => command.name),
        ["compact"],
      );
      assert.equal(first.instanceId, instance.instanceId);
      assert.equal(first.displayName, "My Pi");
      assert.equal(first.accentColor, "#abcdef");
      assert.deepEqual(first.models, machine.models);
      const workspaceLaunch = launches.find((launch) => launch.options.cwd === "/first");
      assert.isDefined(workspaceLaunch);
      assert.equal(workspaceLaunch!.command, "custom-pi");
      assert.includeMembers(
        [...workspaceLaunch!.args],
        ["--approve", "--skill", "extra skill", "--no-session", "--no-extensions"],
      );
      assert.equal(workspaceLaunch!.options.env?.PI_CODING_AGENT_DIR, "/isolated-pi");
    }).pipe(Effect.scoped),
  );

  it.effect("does not run a disabled provider's workspace probe", () =>
    Effect.gen(function* () {
      const instance = yield* create({}, false).pipe(
        Effect.provideService(
          ChildProcessSpawner.ChildProcessSpawner,
          ChildProcessSpawner.make(() => Effect.die("Disabled Pi must not spawn")),
        ),
      );
      assert.isDefined(instance.snapshotForCwd);
      const workspace = yield* instance.snapshotForCwd!("/first");
      assert.isFalse(workspace.enabled);
      assert.deepEqual(workspace.skills, []);
    }).pipe(Effect.scoped),
  );

  it.effect(
    "fails command discovery instead of returning an empty successful workspace catalog",
    () =>
      Effect.gen(function* () {
        const { spawner } = yield* makePiSpawner;
        const instance = yield* create().pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        );
        yield* instance.snapshot.refresh;
        assert.isDefined(instance.snapshotForCwd);
        const error = yield* Effect.flip(instance.snapshotForCwd!("/failed"));
        assert.equal(error._tag, "ProviderDriverError");
        assert.equal(error.instanceId, instance.instanceId);
        assert.deepEqual(
          (yield* instance.snapshot.getSnapshot).skills.map((skill) => skill.name),
          ["personal"],
        );
      }).pipe(Effect.scoped),
  );

  it.effect("times out workspace discovery that needs interactive input", () =>
    Effect.gen(function* () {
      const { spawner, pendingCommand } = yield* makePiSpawner;
      const instance = yield* create().pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      );
      const probe = yield* instance.snapshotForCwd!("/pending").pipe(Effect.flip, Effect.forkChild);
      yield* Deferred.await(pendingCommand);
      yield* TestClock.adjust("15 seconds");
      const error = yield* Fiber.join(probe);
      assert.equal(error._tag, "ProviderDriverError");
      assert.include(error.detail, "workspace commands");
    }).pipe(Effect.scoped),
  );
});
