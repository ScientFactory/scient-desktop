import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import * as Queue from "effect/Queue";
import * as PlatformError from "effect/PlatformError";
import * as Cause from "effect/Cause";
import * as Schema from "effect/Schema";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as Predicate from "effect/Predicate";

import { checkPiProviderStatus, MINIMUM_PI_VERSION } from "./status.ts";
import { decodePiModelSlug, encodePiModelSlug } from "./model.ts";

/**
 * Deliberately outside the valid pid range: PiRpc's group kill must never land
 * on a real process when a fake session is torn down.
 */
const FAKE_PID = 999_999_999;

const encoder = new TextEncoder();
const decodeRpcRequest = Schema.decodeSync(
  Schema.fromJsonString(Schema.Struct({ id: Schema.String, type: Schema.String })),
);
const encodeJsonLine = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

/** Splits a byte stream into LF-delimited records, as Pi's RPC framing requires. */
function makeLineSplitter() {
  let buffer = "";
  const decoder = new TextDecoder();
  return (chunk: Uint8Array): ReadonlyArray<string> => {
    buffer += decoder.decode(chunk, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    return lines.map((line) => line.replace(/\r$/u, "")).filter((line) => line.length > 0);
  };
}

function processHandle(input: {
  readonly stdout?: string;
  readonly stderr?: string;
  readonly exitCode?: number;
}) {
  const bytes = (value: string | undefined) =>
    value === undefined || value.length === 0
      ? Stream.empty
      : Stream.succeed(encoder.encode(value));
  return ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(FAKE_PID),
    exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(input.exitCode ?? 0)),
    isRunning: Effect.succeed(false),
    kill: () => Effect.void,
    unref: Effect.succeed(Effect.void),
    stdin: Sink.drain,
    stdout: bytes(input.stdout),
    stderr: bytes(input.stderr),
    all: Stream.empty,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
  });
}

/** One recorded `pi` launch: the command it ran with and the environment it saw. */
interface PiSpawn {
  readonly args: ReadonlyArray<string>;
  readonly env: NodeJS.ProcessEnv;
}

/** The fake RPC session answers real transport requests so discovery exercises response routing. */
function makePiProbeSpawner(input: {
  readonly version: string;
  readonly rawVersion?: boolean;
  readonly answer?: (request: Record<string, unknown>) => unknown;
  /** When set, every spawn fails with this platform error (a missing binary). */
  readonly spawnFailure?: PlatformError.PlatformError;
  readonly onSpawn?: (spawn: PiSpawn) => void;
}) {
  return ChildProcessSpawner.make((command) =>
    Effect.gen(function* () {
      if (input.spawnFailure !== undefined) {
        return yield* input.spawnFailure;
      }
      const standard = ChildProcess.isStandardCommand(command);
      const args = standard ? command.args : [];
      input.onSpawn?.({ args, env: (standard ? command.options.env : undefined) ?? {} });
      if (args.includes("--version")) {
        return processHandle({ stdout: `${input.rawVersion ? "" : "pi "}${input.version}\n` });
      }

      const stdout = yield* Queue.unbounded<Uint8Array>();
      const split = makeLineSplitter();
      return ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(FAKE_PID),
        exitCode: Effect.never,
        isRunning: Effect.succeed(true),
        kill: () => Effect.void,
        unref: Effect.succeed(Effect.void),
        stdin: Sink.forEach((chunk: Uint8Array) =>
          Effect.sync(() => {
            for (const line of split(chunk)) {
              const request = decodeJsonLine(line);
              if (!Predicate.isObject(request)) continue;
              const data = input.answer?.(request);
              if (data === undefined) continue;
              Queue.offerUnsafe(
                stdout,
                encoder.encode(
                  `${encodeJsonLine({ type: "response", id: request["id"], command: request["type"], success: true, data })}\n`,
                ),
              );
            }
          }),
        ),
        stdout: Stream.fromQueue(stdout),
        stderr: Stream.empty,
        all: Stream.empty,

        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
      });
    }),
  );
}

const decodeJsonLine = Schema.decodeSync(Schema.fromJsonString(Schema.Unknown));

/** Spawner whose RPC session dies on startup, as an unlaunchable Pi would. */
function piRpcStartupFailureSpawner(version: string) {
  return ChildProcessSpawner.make((command) => {
    const args = ChildProcess.isStandardCommand(command) ? command.args : [];
    return Effect.succeed(
      args.includes("--version")
        ? processHandle({ stdout: `pi ${version}\n` })
        : processHandle({ stderr: "RPC startup failed", exitCode: 1 }),
    );
  });
}

const piDiscoverySpawner = (inventory: unknown) =>
  Effect.gen(function* () {
    const stdout = yield* Queue.unbounded<Uint8Array, Cause.Done>();
    let stdinBuffer = "";
    const stdin = Sink.forEach((chunk: Uint8Array) =>
      Effect.gen(function* () {
        stdinBuffer += new TextDecoder().decode(chunk);
        while (true) {
          const newline = stdinBuffer.indexOf("\n");
          if (newline === -1) return;
          const line = stdinBuffer.slice(0, newline);
          stdinBuffer = stdinBuffer.slice(newline + 1);
          if (line.length === 0) continue;
          const request = decodeRpcRequest(line);
          const data =
            request.type === "get_available_models"
              ? inventory
              : request.type === "get_commands"
                ? { commands: [] }
                : {};
          yield* Queue.offer(
            stdout,
            encoder.encode(
              `${encodeJsonLine({ type: "response", id: request.id, command: request.type, success: true, data })}\n`,
            ),
          );
        }
      }),
    );
    return ChildProcessSpawner.make((command) => {
      const args = ChildProcess.isStandardCommand(command) ? command.args : [];
      return Effect.succeed(
        args.includes("--version")
          ? processHandle({ stdout: "pi 0.84.3\n" })
          : ChildProcessSpawner.makeHandle({
              ...processHandle({}),
              exitCode: Effect.never,
              isRunning: Effect.succeed(true),
              stdin,
              stdout: Stream.fromQueue(stdout),
            }),
      );
    });
  });

const settings = {
  enabled: true,
  binaryPath: "pi",
  launchArgs: "",
  customModels: [],
} as const;

const DISCOVERED_COMMANDS = {
  commands: [
    {
      name: "subagents",
      description: "List subagents",
      source: "extension",
      sourceInfo: {
        path: "/home/test/.pi/extensions/subagents.ts",
        source: "auto",
        scope: "user",
        origin: "top-level",
      },
    },
    {
      name: "skill:review",
      description: "Review changes",
      source: "skill",
      sourceInfo: {
        path: "/home/test/.pi/skills/review/SKILL.md",
        source: "auto",
        scope: "user",
        origin: "top-level",
      },
    },
  ],
};

describe("PiProvider", () => {
  it.effect("requires the first published Pi version with entries and settlement hooks", () =>
    Effect.gen(function* () {
      const snapshot = yield* checkPiProviderStatus(settings).pipe(
        Effect.provideService(
          ChildProcessSpawner.ChildProcessSpawner,
          piRpcStartupFailureSpawner("0.80.3"),
        ),
      );
      assert.equal(snapshot.status, "error");
      assert.equal(snapshot.version, "0.80.3");
      assert.include(snapshot.message ?? "", `Pi ${MINIMUM_PI_VERSION} or newer`);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("keeps compatible Pi selectable when optional discovery fails", () =>
    Effect.gen(function* () {
      const snapshot = yield* checkPiProviderStatus(settings).pipe(
        Effect.provideService(
          ChildProcessSpawner.ChildProcessSpawner,
          piRpcStartupFailureSpawner("0.84.3"),
        ),
      );
      assert.equal(snapshot.status, "ready");
      assert.equal(snapshot.auth.status, "unknown");
      assert.deepEqual(
        snapshot.models.map((model) => model.slug),
        ["default"],
      );
      assert.include(snapshot.message ?? "", "could not refresh its models and commands");
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("reports a missing binary as not installed", () =>
    Effect.gen(function* () {
      const snapshot = yield* checkPiProviderStatus(settings).pipe(
        Effect.provideService(
          ChildProcessSpawner.ChildProcessSpawner,
          makePiProbeSpawner({
            version: "0.84.3",
            spawnFailure: PlatformError.systemError({
              _tag: "NotFound",
              module: "ChildProcess",
              method: "spawn",
            }),
          }),
        ),
      );

      assert.equal(snapshot.installed, false);
      assert.equal(snapshot.status, "error");
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("maps Pi RPC inventory into selectable models, commands, and skills", () =>
    Effect.gen(function* () {
      const spawns: Array<PiSpawn> = [];
      const snapshot = yield* checkPiProviderStatus(
        { ...settings, binaryPath: "fake-pi" },
        { PI_TOKEN: "test" },
      ).pipe(
        Effect.provideService(
          ChildProcessSpawner.ChildProcessSpawner,
          makePiProbeSpawner({
            version: "0.84.3",
            onSpawn: (spawn) => spawns.push(spawn),
            answer: (request) => {
              switch (request["type"]) {
                case "get_state":
                  return {
                    model: { provider: "anthropic", id: "claude", reasoning: true },
                    thinkingLevel: "medium",
                  };
                case "get_available_models":
                  return {
                    models: [
                      {
                        provider: "anthropic",
                        id: "claude",
                        name: "Claude",
                        reasoning: true,
                      },
                      {
                        provider: "team/provider %",
                        id: "org/model with space%2F",
                        name: "Private canonical model",
                        reasoning: false,
                      },
                    ],
                  };
                case "get_commands":
                  return DISCOVERED_COMMANDS;
                default:
                  return undefined;
              }
            },
          }),
        ),
      );

      // The discovery session is an ephemeral `--mode rpc` launch of the
      // configured binary, carrying the caller's environment.
      const rpcSpawn = spawns.find((spawn) => spawn.args.includes("--mode"));
      assert.deepEqual(rpcSpawn?.args, ["--mode", "rpc", "--no-session", "--no-extensions"]);
      assert.equal(rpcSpawn?.env.PI_TOKEN, "test");

      assert.equal(snapshot.status, "ready");
      assert.equal(snapshot.auth.status, "authenticated");
      assert.equal(snapshot.auth.type, "pi");
      assert.deepEqual(snapshot.supportedRuntimeModes, [
        "approval-required",
        "auto-accept-edits",
        "full-access",
      ]);
      // Pi's presentation no longer advertises rollback at all, so clients
      // fall back to their default rather than being told "unsupported".
      assert.equal(snapshot.supportsConversationRollback, undefined);
      assert.equal(snapshot.reportsContextWindow, true);

      const model = snapshot.models.find((entry) => entry.slug !== "default");
      assert.equal(model?.slug, "anthropic/claude");
      assert.equal(model?.name, "Claude");
      // A model discovered without a Pi-side default is not pre-selected; the
      // snapshot defers to the user's own settings.json default.
      assert.equal(model?.isDefault, undefined);
      assert.equal(model?.capabilities?.optionDescriptors?.[0]?.id, "thinking");
      // Discovery's session preference is not an existing conversation's applied state.
      assert.equal(model?.capabilities?.optionDescriptors?.[0]?.currentValue, undefined);
      const privateModel = snapshot.models.find(
        (entry) => entry.name === "Private canonical model",
      );
      assert.equal(
        privateModel?.slug,
        encodePiModelSlug("team/provider %", "org/model with space%2F"),
      );
      assert.deepEqual(decodePiModelSlug(privateModel?.slug ?? ""), {
        provider: "team/provider %",
        modelId: "org/model with space%2F",
      });

      assert.deepEqual(
        snapshot.slashCommands?.map((command) => [command.name, command.description]),
        [
          ["compact", "Summarize the conversation and reduce context usage"],
          ["subagents", "List subagents"],
        ],
      );
      assert.deepEqual(snapshot.skills, [
        {
          name: "review",
          description: "Review changes",
          path: "/home/test/.pi/skills/review/SKILL.md",
          scope: "user",
          enabled: true,
        },
      ]);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("does not spawn Pi at all while disabled", () =>
    Effect.gen(function* () {
      const spawns: Array<PiSpawn> = [];
      const snapshot = yield* checkPiProviderStatus({ ...settings, enabled: false }, {}).pipe(
        Effect.provideService(
          ChildProcessSpawner.ChildProcessSpawner,
          makePiProbeSpawner({
            version: "0.84.3",
            onSpawn: (spawn) => spawns.push(spawn),
            answer: () => ({ models: [] }),
          }),
        ),
      );

      assert.equal(snapshot.enabled, false);
      assert.equal(snapshot.status, "disabled");
      assert.include(snapshot.message ?? "", "disabled");
      assert.deepEqual(spawns, []);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("reports a known unauthenticated inventory when Pi returns no usable models", () =>
    Effect.gen(function* () {
      const spawner = yield* piDiscoverySpawner({ models: [] });
      const snapshot = yield* checkPiProviderStatus(settings).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      );
      assert.equal(snapshot.status, "warning");
      assert.equal(snapshot.auth.status, "unauthenticated");
      assert.deepEqual(
        snapshot.models.map((model) => model.slug),
        ["default"],
      );
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  // regression: #18498 a malformed model inventory must not restore stale Pi models
  it.effect.each([
    ["missing models", {}],
    ["missing model id", { models: [{ provider: "anthropic" }] }],
    [
      "mixed valid and invalid models",
      { models: [{ provider: "anthropic", id: "claude-sonnet-4" }, { provider: "openrouter" }] },
    ],
  ] as const)("reports unknown authentication when Pi discovery returns %s", (_label, inventory) =>
    Effect.gen(function* () {
      const spawner = yield* piDiscoverySpawner(inventory);
      const snapshot = yield* checkPiProviderStatus(settings).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      );
      assert.equal(snapshot.status, "ready");
      assert.equal(snapshot.auth.status, "unknown");
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
