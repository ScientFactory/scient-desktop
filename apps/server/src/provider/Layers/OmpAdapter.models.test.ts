// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import {
  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
  ProviderInstanceId,
  ThreadId,
  type ProviderRuntimeEvent,
} from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { makeOmpRpcClient } from "effect-omp-rpc/client";

import { OMP_PENDING_CONNECTION_DETAIL } from "../omp/OmpModel.ts";
import type { OmpProcessExit, OmpRpcProcessOptions } from "../omp/OmpRpcProcess.ts";
import { makeOmpAdapter } from "./OmpAdapter.ts";

const encodeJson = Schema.encodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
const decodeJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));

interface FakeModel {
  readonly provider: string;
  readonly id: string;
  readonly reasoning?: boolean;
  readonly contextWindow?: number;
  readonly input?: ReadonlyArray<string>;
  readonly thinking?: {
    readonly mode?: string;
    readonly efforts?: ReadonlyArray<string>;
    readonly defaultLevel?: string;
  };
}

interface Frame {
  readonly id?: string;
  readonly type: string;
  readonly provider?: string;
  readonly modelId?: string;
  readonly level?: string;
  readonly message?: string;
  readonly images?: ReadonlyArray<{ readonly data: string; readonly mimeType: string }>;
}

const cleanExit: OmpProcessExit = { code: 0, forced: false, stderrTail: "" };

/**
 * A scripted Oh My Pi behind the real RPC client. set_model re-applies the
 * model's default level, as OMP does; set_thinking_level may clamp.
 */
const makeFakeOmp = (input: {
  readonly models: ReadonlyArray<FakeModel>;
  readonly initial: { readonly provider: string; readonly id: string; readonly level?: string };
  /** Registered only when the bridge's refreshModels runs. */
  readonly lateModels?: ReadonlyArray<FakeModel>;
  readonly maxFrameBytes?: number;
  /** What OMP really applies per `provider/id`, when it differs from the advertised efforts. */
  readonly clamp?: Readonly<Record<string, Readonly<Record<string, string>>>>;
  readonly setModelError?: (provider: string, modelId: string) => string | undefined;
  readonly setThinkingLevelError?: (level: string) => string | undefined;
  /** OMP selects another model than the one requested (a fallback). */
  readonly substitute?: Readonly<
    Record<string, { readonly provider: string; readonly id: string }>
  >;
}) => {
  let finish: Effect.Effect<void> = Effect.void;
  const state = {
    models: [...input.models],
    model: { provider: input.initial.provider, id: input.initial.id },
    thinkingLevel: input.initial.level ?? "off",
    log: [] as Array<string>,
    prompts: [] as Array<{ readonly frame: Frame; readonly bytes: number }>,
  };
  const find = (provider: string, id: string) =>
    state.models.find((model) => model.provider === provider && model.id === id);
  const makeProcess = (options: OmpRpcProcessOptions) =>
    Effect.gen(function* () {
      const sessionDir = options.sessionDir ?? NodeOS.tmpdir();
      const stdout = yield* Queue.unbounded<Uint8Array, Cause.Done>();
      const encoder = new TextEncoder();
      const decoder = new TextDecoder();
      const line = (value: unknown) => encoder.encode(`${encodeJson(value)}\n`);
      const respond = (frame: Frame, data?: unknown, error?: string) =>
        line({
          id: frame.id,
          type: "response",
          command: frame.type,
          success: error === undefined,
          ...(data === undefined ? {} : { data }),
          ...(error === undefined ? {} : { error }),
        });
      finish = Queue.offer(stdout, line({ type: "agent_start" })).pipe(
        Effect.andThen(
          Queue.offer(stdout, line({ type: "agent_end", messages: [], isTerminal: true })),
        ),
        Effect.asVoid,
      );
      const reply = (frame: Frame, bytes: number): Uint8Array => {
        if (
          frame.type !== "get_state" &&
          frame.type !== "negotiate_protocol" &&
          frame.type !== "set_subagent_subscription" &&
          frame.type !== "set_event_filter" &&
          frame.type !== "get_available_commands"
        ) {
          state.log.push(
            frame.type === "set_model"
              ? `set_model ${frame.provider}/${frame.modelId}`
              : frame.type === "set_thinking_level"
                ? `set_thinking_level ${frame.level}`
                : frame.type,
          );
        }
        switch (frame.type) {
          case "negotiate_protocol":
            return respond(frame, { protocolVersion: 2 });
          case "get_state": {
            NodeFS.mkdirSync(sessionDir, { recursive: true });
            const sessionFile = NodePath.join(sessionDir, "session.jsonl");
            NodeFS.writeFileSync(sessionFile, "{}\n");
            return respond(frame, {
              model: state.model,
              thinkingLevel: state.thinkingLevel,
              sessionFile,
              sessionId: "models-session",
              isStreaming: false,
            });
          }
          case "get_available_models":
            return respond(frame, {
              models: state.models,
            });
          case "get_available_commands":
            return respond(frame, { commands: [{ name: "help", source: "builtin" }] });
          case "set_model": {
            const provider = frame.provider ?? "";
            const modelId = frame.modelId ?? "";
            const refused = input.setModelError?.(provider, modelId);
            if (refused) return respond(frame, undefined, refused);
            if (!find(provider, modelId)) {
              return respond(frame, undefined, `Model not found: ${provider}/${modelId}`);
            }
            const selected = input.substitute?.[`${provider}/${modelId}`] ?? {
              provider,
              id: modelId,
            };
            const model = find(selected.provider, selected.id);
            if (!model) return respond(frame, undefined, `Model not found: ${provider}/${modelId}`);
            state.model = { provider: selected.provider, id: selected.id };
            state.thinkingLevel = model.reasoning
              ? (model.thinking?.defaultLevel ?? "medium")
              : "off";
            return respond(frame, { provider, id: modelId });
          }
          case "set_thinking_level": {
            const level = frame.level ?? "off";
            const refused = input.setThinkingLevelError?.(level);
            if (refused) return respond(frame, undefined, refused);
            state.thinkingLevel =
              input.clamp?.[`${state.model.provider}/${state.model.id}`]?.[level] ?? level;
            return respond(frame);
          }
          case "prompt":
          case "steer":
            state.prompts.push({ frame, bytes });
            return respond(frame);
          default:
            return respond(frame, {});
        }
      };
      const client = yield* makeOmpRpcClient({
        stdout: Stream.fromQueue(stdout),
        write: (bytes) =>
          Effect.forEach(
            decoder
              .decode(bytes)
              .split("\n")
              .filter((text) => text.trim().length > 0),
            (text) =>
              Queue.offer(stdout, reply(decodeJson(text) as Frame, Buffer.byteLength(text) + 1)),
            { discard: true },
          ),
      });
      yield* Queue.offer(
        stdout,
        line({
          type: "ready",
          protocolVersion: 1,
          supportedProtocolVersions: [1, 2],
          maxFrameBytes: input.maxFrameBytes ?? 1_048_576,
          maxReassembledFrameBytes: 67_108_864,
        }),
      );
      return {
        ...client,
        version: "18.3.1",
        shutdown: Queue.end(stdout).pipe(Effect.as(cleanExit)),
        // The custom-model bridge's barrier: registers late models.
        refreshModels: () =>
          Effect.sync(() => {
            state.log.push("refresh");
            for (const model of input.lateModels ?? []) {
              if (!find(model.provider, model.id)) state.models.push(model);
            }
          }),
      };
    });
  return { state, makeProcess, finish: () => finish };
};

let rootCounter = 0;
const makeRoot = (label: string) => {
  const root = NodePath.join(
    NodeOS.tmpdir(),
    `scient-omp-models-${process.pid}-${label}-${rootCounter++}`,
  );
  NodeFS.rmSync(root, { recursive: true, force: true });
  NodeFS.mkdirSync(NodePath.join(root, "attachments"), { recursive: true });
  return root;
};

const instanceId = ProviderInstanceId.make("omp-models");

const startAdapter = (root: string, fake: ReturnType<typeof makeFakeOmp>) =>
  Effect.gen(function* () {
    const adapter = yield* makeOmpAdapter({
      binaryPath: "omp",
      providerInstanceId: instanceId,
      stateDir: NodePath.join(root, "state"),
      attachmentsDir: NodePath.join(root, "attachments"),
      environment: { PATH: "/usr/bin" },
      makeProcess: fake.makeProcess,
    });
    const events: Array<ProviderRuntimeEvent> = [];
    const completed = yield* Queue.unbounded<string>();
    yield* adapter.streamEvents.pipe(
      Stream.runForEach((event) =>
        Effect.sync(() => events.push(event)).pipe(
          Effect.andThen(
            event.type === "turn.completed" && event.turnId
              ? Queue.offer(completed, event.turnId)
              : Effect.void,
          ),
        ),
      ),
      Effect.forkScoped,
    );
    const threadId = ThreadId.make(`omp-models-${rootCounter}`);
    yield* adapter.startSession({ threadId, cwd: root, runtimeMode: "full-access" });
    fake.state.log.length = 0;
    const awaitCompletion = (turnId: string) =>
      Effect.gen(function* () {
        for (;;) {
          if ((yield* Queue.take(completed)) === turnId) return;
        }
      });
    return { adapter, events, threadId, awaitCompletion };
  });

const selection = (model: string, thinkingLevel?: string) =>
  createModelSelection(
    instanceId,
    model,
    thinkingLevel === undefined ? undefined : [{ id: "thinkingLevel", value: thinkingLevel }],
  );

const warnings = (events: ReadonlyArray<ProviderRuntimeEvent>) =>
  events.flatMap((event) =>
    event.type === "runtime.warning"
      ? [String((event.payload as { message: string }).message)]
      : [],
  );

const reasoning = (
  provider: string,
  id: string,
  efforts: ReadonlyArray<string>,
  defaultLevel?: string,
  extra: Partial<FakeModel> = {},
): FakeModel => ({
  provider,
  id,
  reasoning: true,
  input: ["text", "image"],
  thinking: { mode: "effort", efforts, ...(defaultLevel ? { defaultLevel } : {}) },
  ...extra,
});

const withAdapter = <A, E>(
  label: string,
  fake: ReturnType<typeof makeFakeOmp>,
  body: (input: {
    readonly root: string;
    readonly adapter: Effect.Success<ReturnType<typeof makeOmpAdapter>>;
    readonly events: Array<ProviderRuntimeEvent>;
    readonly threadId: ThreadId;
    readonly awaitCompletion: (turnId: string) => Effect.Effect<void>;
  }) => Effect.Effect<A, E>,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const root = makeRoot(label);
      const started = yield* startAdapter(root, fake);
      try {
        return yield* body({ root, ...started });
      } finally {
        yield* started.adapter.stopAll();
        NodeFS.rmSync(root, { recursive: true, force: true });
      }
    }),
  ).pipe(Effect.provide(NodeServices.layer));

describe("Oh My Pi model and reasoning selection", () => {
  it.effect("M-6 reads the applied level back after a model switch re-applies its default", () => {
    const fake = makeFakeOmp({
      models: [
        reasoning("vendor", "a", ["low", "medium", "high"], "high"),
        reasoning("vendor", "b", ["low", "medium", "high"], "low"),
      ],
      initial: { provider: "vendor", id: "a", level: "high" },
    });
    return withAdapter("readback", fake, ({ adapter, threadId }) =>
      Effect.gen(function* () {
        // The session is at "high"; switching to b makes OMP apply b's "low".
        yield* adapter.sendTurn({
          threadId,
          input: "switch",
          modelSelection: selection("vendor/b", "high"),
        });
        expect(fake.state.log).toEqual(["set_model vendor/b", "set_thinking_level high", "prompt"]);
        expect(fake.state.thinkingLevel).toBe("high");
      }),
    );
  });

  it.effect("M-6 a clamped level is stored as applied and reported as a warning", () => {
    const fake = makeFakeOmp({
      models: [
        reasoning("vendor", "a", ["low", "high"], "low"),
        reasoning("anthropic", "opus", ["low", "medium", "high", "xhigh"], "high"),
      ],
      initial: { provider: "vendor", id: "a", level: "low" },
      clamp: { "anthropic/opus": { xhigh: "high" } },
    });
    return withAdapter("clamp", fake, ({ adapter, events, threadId }) =>
      Effect.gen(function* () {
        yield* adapter.sendTurn({
          threadId,
          input: "think hard",
          modelSelection: selection("anthropic/opus", "xhigh"),
        });
        expect(fake.state.thinkingLevel).toBe("high");
        expect(warnings(events)).toContainEqual(expect.stringMatching(/"high".*"xhigh"/u));
        // The effective level is what the session remembers: asking for
        // "high" now changes nothing (the turn is still open, so this steers).
        fake.state.log.length = 0;
        yield* adapter.sendTurn({
          threadId,
          input: "again",
          modelSelection: selection("anthropic/opus", "high"),
        });
        expect(fake.state.log).toEqual(["steer"]);
      }),
    );
  });

  it.effect("R1-F2 an unchanged selection after a clamp neither fails a steer nor re-sends", () => {
    const fake = makeFakeOmp({
      models: [reasoning("anthropic", "opus", ["low", "medium", "high", "xhigh"], "high")],
      initial: { provider: "anthropic", id: "opus", level: "low" },
      clamp: { "anthropic/opus": { xhigh: "high" } },
    });
    return withAdapter("clamp-requested", fake, ({ adapter, events, threadId, awaitCompletion }) =>
      Effect.gen(function* () {
        const pick = selection("anthropic/opus", "xhigh");
        const first = yield* adapter.sendTurn({ threadId, input: "one", modelSelection: pick });
        expect(fake.state.log).toEqual(["set_thinking_level xhigh", "prompt"]);
        // The UI still shows "xhigh": steering with it changes nothing.
        yield* adapter.sendTurn({ threadId, input: "steer", modelSelection: pick });
        yield* fake.finish();
        yield* awaitCompletion(first.turnId);
        // Nor does the next idle turn re-request the clamped level.
        const second = yield* adapter.sendTurn({ threadId, input: "two", modelSelection: pick });
        expect(fake.state.log).toEqual(["set_thinking_level xhigh", "prompt", "steer", "prompt"]);
        expect(warnings(events).filter((message) => message.includes('"xhigh"'))).toHaveLength(1);
        // A genuinely different request is applied.
        yield* fake.finish();
        yield* awaitCompletion(second.turnId);
        yield* adapter.sendTurn({
          threadId,
          input: "three",
          modelSelection: selection("anthropic/opus", "medium"),
        });
        expect(fake.state.log.slice(-2)).toEqual(["set_thinking_level medium", "prompt"]);
      }),
    );
  });

  it.effect(
    "R1-F2 an unchanged selection after a model fallback neither fails a steer nor re-sends",
    () => {
      const fake = makeFakeOmp({
        models: [
          reasoning("vendor", "a", ["low", "high"], "low"),
          reasoning("vendor", "b", ["low", "high"], "low"),
          reasoning("vendor", "c", ["low", "high"], "low"),
        ],
        initial: { provider: "vendor", id: "a", level: "low" },
        substitute: { "vendor/b": { provider: "vendor", id: "c" } },
      });
      return withAdapter(
        "fallback-requested",
        fake,
        ({ adapter, events, threadId, awaitCompletion }) =>
          Effect.gen(function* () {
            const pick = selection("vendor/b");
            const first = yield* adapter.sendTurn({ threadId, input: "one", modelSelection: pick });
            expect(fake.state.log).toEqual(["set_model vendor/b", "prompt"]);
            yield* adapter.sendTurn({ threadId, input: "steer", modelSelection: pick });
            yield* fake.finish();
            yield* awaitCompletion(first.turnId);
            yield* adapter.sendTurn({ threadId, input: "two", modelSelection: pick });
            expect(fake.state.log).toEqual(["set_model vendor/b", "prompt", "steer", "prompt"]);
            expect(
              warnings(events).filter((message) => message.includes("instead of")),
            ).toHaveLength(1);
          }),
      );
    },
  );

  it.effect("rejects a level the model does not list before changing anything", () => {
    const fake = makeFakeOmp({
      models: [
        reasoning("vendor", "a", ["low", "high"], "low"),
        reasoning("vendor", "b", ["low", "medium", "high"], "medium"),
        { provider: "vendor", id: "plain", input: ["text"] },
      ],
      initial: { provider: "vendor", id: "a", level: "low" },
    });
    return withAdapter("reject-level", fake, ({ adapter, threadId }) =>
      Effect.gen(function* () {
        const rejected = yield* adapter
          .sendTurn({ threadId, input: "x", modelSelection: selection("vendor/b", "max") })
          .pipe(Effect.flip);
        expect(rejected.message).toContain("max");
        expect(rejected.message).toContain("low, medium, high");
        const plain = yield* adapter
          .sendTurn({ threadId, input: "x", modelSelection: selection("vendor/plain", "high") })
          .pipe(Effect.flip);
        expect(plain.message).toMatch(/no reasoning levels/u);
        expect(fake.state.log).toEqual([]);
        expect(fake.state.model).toEqual({ provider: "vendor", id: "a" });
      }),
    );
  });

  it.effect("M-6 refreshes custom models before selecting an unknown one", () => {
    const fake = makeFakeOmp({
      models: [reasoning("vendor", "a", ["low", "high"], "low")],
      lateModels: [reasoning("scient_local", "new-model", ["low", "medium", "high"], "medium")],
      initial: { provider: "vendor", id: "a", level: "low" },
    });
    return withAdapter("refresh-first", fake, ({ adapter, threadId }) =>
      Effect.gen(function* () {
        yield* adapter.sendTurn({
          threadId,
          input: "use the new model",
          modelSelection: selection("scient_local/new-model", "high"),
        });
        expect(fake.state.log.slice(0, 2)).toEqual(["refresh", "set_model scient_local/new-model"]);
        expect(fake.state.log).toContain("set_thinking_level high");
        expect(fake.state.thinkingLevel).toBe("high");
      }),
    );
  });

  it.effect("M-6 refreshes before retrying a rejected model", () => {
    const fake = makeFakeOmp({
      models: [reasoning("vendor", "a", ["low", "high"], "low")],
      lateModels: [reasoning("ollama", "late", ["low", "high"], "low")],
      initial: { provider: "vendor", id: "a", level: "low" },
    });
    return withAdapter("refresh-retry", fake, ({ adapter, threadId }) =>
      Effect.gen(function* () {
        yield* adapter.sendTurn({
          threadId,
          input: "use late",
          modelSelection: selection("ollama/late"),
        });
        expect(fake.state.log.slice(0, 4)).toEqual([
          "set_model ollama/late",
          "refresh",
          "get_available_models",
          "set_model ollama/late",
        ]);
      }),
    );
  });

  it.effect("M-6 shows the pending-key message for a connection added after start", () => {
    const fake = makeFakeOmp({
      models: [reasoning("vendor", "a", ["low", "high"], "low")],
      initial: { provider: "vendor", id: "a", level: "low" },
      setModelError: (provider) =>
        provider === "scient_new-keyed" ? OMP_PENDING_CONNECTION_DETAIL : undefined,
    });
    return withAdapter("pending", fake, ({ adapter, threadId }) =>
      Effect.gen(function* () {
        const failed = yield* adapter
          .sendTurn({
            threadId,
            input: "x",
            modelSelection: selection("scient_new-keyed/model"),
          })
          .pipe(Effect.flip);
        expect(failed.message).toContain("Start a new conversation to use this connection");
        expect(fake.state.log).toContain("refresh");
        expect(fake.state.model).toEqual({ provider: "vendor", id: "a" });
      }),
    );
  });

  it.effect("restores the previous model when a level check fails after a refresh", () => {
    const fake = makeFakeOmp({
      models: [reasoning("vendor", "a", ["low", "high"], "high")],
      lateModels: [reasoning("scient_local", "late", ["low", "medium"], "low")],
      initial: { provider: "vendor", id: "a", level: "high" },
    });
    return withAdapter("restore", fake, ({ adapter, threadId }) =>
      Effect.gen(function* () {
        const failed = yield* adapter
          .sendTurn({
            threadId,
            input: "x",
            modelSelection: selection("scient_local/late", "high"),
          })
          .pipe(Effect.flip);
        expect(failed.message).toContain("low, medium");
        expect(fake.state.model).toEqual({ provider: "vendor", id: "a" });
        expect(fake.state.thinkingLevel).toBe("high");
        expect(fake.state.prompts).toHaveLength(0);
      }),
    );
  });
});

describe("Oh My Pi selection restore", () => {
  it.effect("R2-F3 a refused restore keeps OMP's real model, so the next send re-selects", () => {
    let refuseRestore = true;
    const fake = makeFakeOmp({
      models: [
        reasoning("vendor", "a", ["low", "high"], "low"),
        reasoning("vendor", "b", ["low", "high"], "low"),
      ],
      initial: { provider: "vendor", id: "a", level: "low" },
      setThinkingLevelError: (level) => (level === "high" ? "Thinking level refused" : undefined),
      setModelError: (provider, modelId) => {
        if (`${provider}/${modelId}` !== "vendor/a" || !refuseRestore) return undefined;
        refuseRestore = false;
        return "Model switch refused";
      },
    });
    return withAdapter("restore-refused", fake, ({ adapter, events, threadId }) =>
      Effect.gen(function* () {
        const failed = yield* adapter
          .sendTurn({ threadId, input: "x", modelSelection: selection("vendor/b", "high") })
          .pipe(Effect.flip);
        expect(failed.message).toContain("Thinking level refused");
        expect(fake.state.log).toEqual([
          "set_model vendor/b",
          "set_thinking_level high",
          "set_model vendor/a",
          "set_thinking_level low",
        ]);
        // Let the event consumer catch up.
        for (let index = 0; index < 50; index += 1) yield* Effect.yieldNow;
        // OMP is still on b; the session must know it.
        expect(fake.state.model).toEqual({ provider: "vendor", id: "b" });
        expect(warnings(events)).toContainEqual(expect.stringMatching(/vendor\/b/u));
        fake.state.log.length = 0;
        yield* adapter.sendTurn({
          threadId,
          input: "y",
          modelSelection: selection("vendor/a", "low"),
        });
        expect(fake.state.log[0]).toBe("set_model vendor/a");
        expect(fake.state.model).toEqual({ provider: "vendor", id: "a" });
      }),
    );
  });
});

describe("Oh My Pi fork context", () => {
  it.effect("reports the selected model's window only for its own instance", () => {
    const fake = makeFakeOmp({
      models: [{ provider: "vendor", id: "a/b", contextWindow: 1_000_000 }],
      initial: { provider: "vendor", id: "a/b" },
    });
    return withAdapter("context-window", fake, ({ adapter, threadId }) =>
      Effect.gen(function* () {
        expect(
          yield* adapter.getModelContextWindow({
            threadId,
            modelSelection: selection("vendor/a%2Fb"),
          }),
        ).toBe(1_000_000);
        expect(
          yield* adapter.getModelContextWindow({
            threadId,
            modelSelection: selection("vendor/missing"),
          }),
        ).toBeUndefined();
        expect(
          yield* adapter.getModelContextWindow({
            threadId,
            modelSelection: createModelSelection(ProviderInstanceId.make("other"), "vendor/a%2Fb"),
          }),
        ).toBeUndefined();
        yield* adapter.stopAll();
        expect(
          yield* adapter.getModelContextWindow({
            threadId,
            modelSelection: selection("vendor/a%2Fb"),
          }),
        ).toBeUndefined();
      }),
    );
  });

  it.effect("refuses a fork slash command before changing a model or sending a prompt", () => {
    const fake = makeFakeOmp({
      models: [{ provider: "vendor", id: "a" }],
      initial: { provider: "vendor", id: "a" },
    });
    return withAdapter("fork-command", fake, ({ adapter, threadId }) =>
      Effect.gen(function* () {
        const failure = yield* adapter
          .sendTurn({
            threadId,
            originalInput: "/help",
            input: "history\n\n/help",
            hasContextPreamble: true,
          })
          .pipe(Effect.flip);
        expect(failure.message).toContain("Start this fork with a normal message");
        expect(fake.state.log).toEqual([]);
        expect(fake.state.prompts).toHaveLength(0);
        yield* adapter.sendTurn({
          threadId,
          originalInput: "/help",
          input: "augmented instructions\n/help",
        });
        expect(fake.state.prompts[0]?.frame.message).toBe("/help");
      }),
    );
  });

  it.effect(
    "preserves a large Unicode fork prompt in a private scoped file alongside images",
    () => {
      const fake = makeFakeOmp({
        models: [reasoning("vendor", "vision", ["low"], "low")],
        initial: { provider: "vendor", id: "vision" },
        maxFrameBytes: 8192,
      });
      return withAdapter("fork-file", fake, ({ root, adapter, threadId }) =>
        Effect.gen(function* () {
          const prompt =
            "SCIENT_FORK_CONTEXT_JSON\n" + "שלום ".repeat(2000) + "\nCURRENT REQUEST: continue";
          const image = Buffer.alloc(9000, 1);
          NodeFS.writeFileSync(NodePath.join(root, "attachments", "fork-image.png"), image);
          yield* adapter.sendTurn({
            threadId,
            input: prompt,
            originalInput: "continue",
            hasContextPreamble: true,
            attachments: [
              {
                type: "image",
                id: "fork-image",
                name: "fork-image.png",
                mimeType: "image/png",
                sizeBytes: image.length,
              },
            ],
          });
          const sent = fake.state.prompts[0]!;
          expect(sent.bytes).toBeLessThanOrEqual(8192);
          expect(sent.frame.images ?? []).toHaveLength(0);
          const paths = sent.frame
            .message!.split("\n")
            .filter((line) => line.startsWith('"'))
            .map((line) => JSON.parse(line) as string);
          const contextPath = paths.find((path) => path.endsWith(".txt"))!;
          expect(
            NodePath.relative(NodeFS.realpathSync(NodePath.join(root, "state")), contextPath),
          ).not.toMatch(/^\.\./u);
          expect(NodeFS.readFileSync(contextPath, "utf8")).toBe(prompt);
          if ((yield* HostProcessPlatform) !== "win32")
            expect(NodeFS.statSync(contextPath).mode & 0o777).toBe(0o600);
          expect(paths).toContain(
            NodeFS.realpathSync(NodePath.join(root, "attachments", "fork-image.png")),
          );
          expect(sent.frame.message).toContain("Read the entire file");
          yield* adapter.stopAll();
          expect(NodeFS.existsSync(contextPath)).toBe(false);
        }),
      );
    },
  );
});

describe("Oh My Pi image attachments", () => {
  const vision = reasoning("vendor", "vision", ["low", "high"], "low");
  const writeImage = (root: string, id: string, size: number) => {
    NodeFS.writeFileSync(NodePath.join(root, "attachments", `${id}.png`), Buffer.alloc(size, 7));
    return {
      type: "image" as const,
      id,
      name: `${id}.png`,
      mimeType: "image/png",
      sizeBytes: size,
    };
  };
  const attachedImagePaths = (message: string | undefined) =>
    (message ?? "")
      .split("\n")
      .filter((line) => line.startsWith('"') && line.includes("attachments"))
      .map((line) => JSON.parse(line) as string);

  it.effect("sends a small image inline and a 900 KB image as an attached file", () => {
    const fake = makeFakeOmp({ models: [vision], initial: { provider: "vendor", id: "vision" } });
    return withAdapter("images-1mib", fake, ({ root, adapter, threadId }) =>
      Effect.gen(function* () {
        yield* adapter.sendTurn({
          threadId,
          input: "small",
          attachments: [writeImage(root, "small-image", 600 * 1024)],
        });
        const small = fake.state.prompts.at(-1)!;
        expect(small.frame.images).toHaveLength(1);
        expect(small.frame.message).toBe("small");
        expect(small.bytes).toBeLessThanOrEqual(1_048_576);

        // 900 KB is 1.2 MB of base64: over the advertised 1 MiB frame.
        yield* adapter.sendTurn({
          threadId,
          input: "large",
          attachments: [writeImage(root, "large-image", 900 * 1024)],
        });
        const large = fake.state.prompts.at(-1)!;
        expect(large.frame.images ?? []).toHaveLength(0);
        expect(large.frame.message).toContain("read tool");
        const [path] = attachedImagePaths(large.frame.message);
        expect(path).toMatch(/large-image\.png$/u);
        expect(NodeFS.statSync(path!).size).toBe(900 * 1024);

        yield* adapter.sendTurn({
          threadId,
          input: "huge",
          attachments: [writeImage(root, "huge-image", 3 * 1024 * 1024)],
        });
        expect(attachedImagePaths(fake.state.prompts.at(-1)!.frame.message)).toHaveLength(1);
      }),
    );
  });

  it.effect("budgets several images against one frame", () => {
    const fake = makeFakeOmp({ models: [vision], initial: { provider: "vendor", id: "vision" } });
    return withAdapter("images-budget", fake, ({ root, adapter, threadId }) =>
      Effect.gen(function* () {
        yield* adapter.sendTurn({
          threadId,
          input: "two",
          attachments: [
            writeImage(root, "first-image", 500 * 1024),
            writeImage(root, "second-image", 500 * 1024),
          ],
        });
        const sent = fake.state.prompts.at(-1)!;
        expect(sent.frame.images).toHaveLength(1);
        expect(attachedImagePaths(sent.frame.message)).toEqual([
          expect.stringMatching(/second-image\.png$/u),
        ]);
        expect(sent.bytes).toBeLessThanOrEqual(1_048_576);
      }),
    );
  });

  it.effect("uses the frame limit Oh My Pi advertises", () => {
    const fake = makeFakeOmp({
      models: [vision],
      initial: { provider: "vendor", id: "vision" },
      maxFrameBytes: 2 * 1024 * 1024,
    });
    return withAdapter("images-2mib", fake, ({ root, adapter, threadId }) =>
      Effect.gen(function* () {
        yield* adapter.sendTurn({
          threadId,
          input: "inline",
          attachments: [writeImage(root, "wide-image", 900 * 1024)],
        });
        expect(fake.state.prompts.at(-1)!.frame.images).toHaveLength(1);
      }),
    );
  });

  it.effect("states the limits when an image or message cannot be sent", () => {
    const fake = makeFakeOmp({ models: [vision], initial: { provider: "vendor", id: "vision" } });
    return withAdapter("images-limits", fake, ({ root, adapter, threadId }) =>
      Effect.gen(function* () {
        const tooLarge = yield* adapter
          .sendTurn({
            threadId,
            input: "too large",
            attachments: [writeImage(root, "oversize", PROVIDER_SEND_TURN_MAX_IMAGE_BYTES + 1)],
          })
          .pipe(Effect.flip);
        expect(tooLarge.message).toContain("10 MB");
        const longText = yield* adapter
          .sendTurn({ threadId, input: "x".repeat(1_100_000) })
          .pipe(Effect.flip);
        expect(longText.message).toContain("1 MB");
        expect(fake.state.prompts).toHaveLength(0);
      }),
    );
  });
});
