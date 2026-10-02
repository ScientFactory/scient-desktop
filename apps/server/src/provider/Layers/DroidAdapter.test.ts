// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import * as NodeFSP from "node:fs/promises";
import * as NodeURL from "node:url";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as EffectAcpErrors from "effect-acp/errors";

import {
  ApprovalRequestId,
  DroidSettings,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type ProviderRuntimeEvent,
} from "@t3tools/contracts";

import { ServerConfig } from "../../config.ts";
import { scriptedDroid } from "../testUtils/scriptedDroid.ts";
import { makeDroidAdapter } from "./DroidAdapter.ts";
import { isDroidNestedTaskToolCall } from "../droid/DroidSubagents.ts";
import {
  buildDroidModelsFromConfigOptions,
  resolveDroidAutonomyModeId,
  resolveDroidCliBinaryPath,
  makeDroidAcpRuntime,
} from "../acp/DroidAcpSupport.ts";

const decodeDroidSettings = Schema.decodeSync(DroidSettings);
const encodeUnknownJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

const __dirname = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const mockAgentPath = NodePath.join(__dirname, "../../../scripts/acp-mock-agent.ts");
const mockAgentCommand = process.execPath;

async function makeMockDroidWrapper(extraEnv?: Record<string, string>) {
  const dir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "droid-acp-mock-"));
  const wrapperPath = NodePath.join(dir, "fake-droid.sh");
  const envExports = Object.entries({
    // Real Droid publishes authoritative config-option updates for every
    // model/mode write; keep every Droid adapter fixture faithful by default.
    T3_ACP_DROID_ASYNC_CONFIG_REFRESH: "1",
    // Real Droid always offers its autonomy ladder, and Scient requires it per prompt.
    T3_ACP_DROID_AUTONOMY: "normal",
    ...extraEnv,
  })
    .map(([key, value]) => `export ${key}=${JSON.stringify(value)}`)
    .join("\n");
  const script = `#!/bin/sh
${envExports}
exec ${JSON.stringify(mockAgentCommand)} ${JSON.stringify(mockAgentPath)} "$@"
`;
  await NodeFSP.writeFile(wrapperPath, script, "utf8");
  await NodeFSP.chmod(wrapperPath, 0o755);
  return wrapperPath;
}

const droidAdapterTestLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: "t3code-droid-adapter-test-",
}).pipe(Layer.provideMerge(NodeServices.layer));

const makeTestAdapter = (binaryPath: string, options?: Parameters<typeof makeDroidAdapter>[1]) =>
  makeDroidAdapter(decodeDroidSettings({ binaryPath }), options).pipe(Effect.orDie);

it.effect("rejects images for a loaded text-only custom model before prompting", () =>
  Effect.gen(function* () {
    const wrapperPath = yield* Effect.promise(() => makeMockDroidWrapper());
    yield* Effect.addFinalizer(() =>
      Effect.promise(() =>
        NodeFSP.rm(NodePath.dirname(wrapperPath), { recursive: true, force: true }),
      ),
    );
    let prompts = 0;
    const adapter = yield* makeTestAdapter(wrapperPath, {
      makeAcpRuntime: (input) =>
        Effect.gen(function* () {
          const runtime = yield* makeDroidAcpRuntime(input);
          return {
            ...runtime,
            getImageSupport: () => false,
            prompt: (...args: Parameters<typeof runtime.prompt>) =>
              Effect.gen(function* () {
                prompts++;
                return yield* runtime.prompt(...args);
              }),
          };
        }),
    });
    const threadId = ThreadId.make("droid-text-only-image");
    yield* adapter.startSession({
      threadId,
      cwd: process.cwd(),
      runtimeMode: "full-access",
      modelSelection: { instanceId: ProviderInstanceId.make("droid"), model: "custom:Ox-Alpha-0" },
    });
    const result = yield* adapter
      .sendTurn({
        threadId,
        input: "read image",
        attachments: [
          { type: "image", id: "not-read", name: "image.png", mimeType: "image/png", sizeBytes: 1 },
        ],
      })
      .pipe(Effect.result);
    assert.equal(result._tag, "Failure");
    if (result._tag === "Failure")
      assert.include(
        result.failure.message,
        "This custom model is set up without image input. Turn on Image input in its advanced settings under Settings > Custom models, or pick a model that takes images.",
      );
    assert.equal(prompts, 0);
  }).pipe(Effect.scoped, Effect.provide(droidAdapterTestLayer)),
);

it.effect("preserves explicit and inherited conversation effort over the saved model default", () =>
  Effect.gen(function* () {
    const wrapperPath = yield* Effect.promise(() => makeMockDroidWrapper());
    yield* Effect.addFinalizer(() =>
      Effect.promise(() =>
        NodeFSP.rm(NodePath.dirname(wrapperPath), { recursive: true, force: true }),
      ),
    );
    const sentEfforts: unknown[] = [];
    const adapter = yield* makeTestAdapter(wrapperPath, {
      makeAcpRuntime: (input) =>
        Effect.gen(function* () {
          const runtime = yield* makeDroidAcpRuntime(input);
          return {
            ...runtime,
            getReasoningMetadata: () => ({
              status: "known" as const,
              supported: true,
              levels: ["low", "medium", "high"] as const,
              defaultLevel: "medium" as const,
            }),
            getDefaultReasoningLevel: () => "high",
            prompt: (...args: Parameters<typeof runtime.prompt>) =>
              Effect.gen(function* () {
                const options = yield* runtime.getConfigOptions;
                sentEfforts.push(
                  options.find((option) => option.id === "reasoning_effort")?.currentValue,
                );
                return yield* runtime.prompt(...args);
              }),
          };
        }),
    });
    const threadId = ThreadId.make("droid-default-does-not-overwrite-choice");
    const selection = { instanceId: ProviderInstanceId.make("droid"), model: "custom:Ox-Alpha-0" };
    yield* adapter.startSession({
      threadId,
      cwd: process.cwd(),
      runtimeMode: "full-access",
      modelSelection: selection,
    });
    for (const effort of ["low", "low", "medium", undefined]) {
      const completed = yield* adapter.streamEvents.pipe(
        Stream.takeUntil((event) => event.type === "turn.completed"),
        Stream.runCollect,
        Effect.forkChild,
      );
      yield* adapter.sendTurn({
        threadId,
        input: "hello",
        attachments: [],
        ...(effort
          ? {
              modelSelection: { ...selection, options: [{ id: "reasoningEffort", value: effort }] },
            }
          : {}),
      });
      const events = yield* Fiber.join(completed);
      assert.equal(
        events.find((event) => event.type === "turn.completed")?.payload.state,
        "completed",
      );
    }
    assert.deepEqual(sentEfforts, ["low", "low", "medium", "medium"]);
  }).pipe(Effect.scoped, Effect.provide(droidAdapterTestLayer)),
);

it.effect(
  "runs at the level Droid applies in place of the configured default and says so once",
  () =>
    Effect.gen(function* () {
      // Droid 0.213.0 and 0.230.0 run a model id they know at Low when it is configured with Minimal.
      const wrapperPath = yield* Effect.promise(() =>
        makeMockDroidWrapper({ T3_ACP_DROID_EFFORT_REPLACEMENT: "minimal=low" }),
      );
      yield* Effect.addFinalizer(() =>
        Effect.promise(() =>
          NodeFSP.rm(NodePath.dirname(wrapperPath), { recursive: true, force: true }),
        ),
      );
      const sentEfforts: unknown[] = [];
      const adapter = yield* makeTestAdapter(wrapperPath, {
        makeAcpRuntime: (input) =>
          Effect.gen(function* () {
            const runtime = yield* makeDroidAcpRuntime({
              ...input,
              // The configured level joins the ladder Droid advertises.
              resolveConfigOptions: (options) =>
                options.map((option) =>
                  option.id === "reasoning_effort" && option.type === "select"
                    ? {
                        ...option,
                        options: ["minimal", "low", "medium", "high"].map((value) => ({
                          value,
                          name: value,
                        })),
                      }
                    : option,
                ),
            });
            return {
              ...runtime,
              getReasoningMetadata: () => ({
                status: "known" as const,
                supported: true,
                mode: "effort" as const,
                levels: ["minimal", "low", "medium", "high"] as const,
                defaultLevel: "medium" as const,
              }),
              getDefaultReasoningLevel: () => "minimal",
              prompt: (...args: Parameters<typeof runtime.prompt>) =>
                Effect.gen(function* () {
                  const options = yield* runtime.getConfigOptions;
                  sentEfforts.push(
                    options.find((option) => option.id === "reasoning_effort")?.currentValue,
                  );
                  return yield* runtime.prompt(...args);
                }),
            };
          }),
      });
      const threadId = ThreadId.make("droid-replaced-default");
      // The composer dispatches the default level like any other.
      const selection = {
        instanceId: ProviderInstanceId.make("droid"),
        model: "custom:Ox-Alpha-0",
        options: [{ id: "reasoningEffort", value: "minimal" }],
      };
      yield* adapter.startSession({
        threadId,
        cwd: process.cwd(),
        runtimeMode: "full-access",
        modelSelection: selection,
      });
      const warnings: string[] = [];
      for (const modelSelection of [selection, selection, undefined]) {
        const completed = yield* adapter.streamEvents.pipe(
          Stream.takeUntil((event) => event.type === "turn.completed"),
          Stream.runCollect,
          Effect.forkChild,
        );
        yield* adapter.sendTurn({
          threadId,
          input: "hello",
          attachments: [],
          ...(modelSelection ? { modelSelection } : {}),
        });
        const events = yield* Fiber.join(completed);
        assert.equal(
          events.find((event) => event.type === "turn.completed")?.payload.state,
          "completed",
        );
        for (const event of events)
          if (event.type === "runtime.warning") warnings.push(event.payload.message);
      }
      assert.deepEqual(sentEfforts, ["low", "low", "low"]);
      assert.deepEqual(warnings, [
        "Droid uses Low for this model instead of the configured default Minimal.",
      ]);
    }).pipe(Effect.scoped, Effect.provide(droidAdapterTestLayer)),
);

it.effect("says a default was replaced only for the selection the prompt runs with", () =>
  Effect.gen(function* () {
    const wrapperPath = yield* Effect.promise(() =>
      makeMockDroidWrapper({ T3_ACP_DROID_EFFORT_REPLACEMENT: "minimal=low" }),
    );
    yield* Effect.addFinalizer(() =>
      Effect.promise(() =>
        NodeFSP.rm(NodePath.dirname(wrapperPath), { recursive: true, force: true }),
      ),
    );
    const sent: Array<{ readonly model: unknown; readonly effort: unknown }> = [];
    const adapter = yield* makeTestAdapter(wrapperPath, {
      makeAcpRuntime: (input) =>
        Effect.gen(function* () {
          const runtime = yield* makeDroidAcpRuntime({
            ...input,
            resolveConfigOptions: (options) =>
              options.map((option) =>
                option.id === "reasoning_effort" && option.type === "select"
                  ? {
                      ...option,
                      options: ["minimal", "low", "medium", "high"].map((value) => ({
                        value,
                        name: value,
                      })),
                    }
                  : option,
              ),
          });
          return {
            ...runtime,
            // Only the Scient model has metadata; the other one is Droid's own.
            getReasoningMetadata: (model: string) =>
              model === "custom:Ox-Alpha-0"
                ? {
                    status: "known" as const,
                    supported: true,
                    mode: "effort" as const,
                    levels: ["minimal", "low", "medium", "high"] as const,
                    defaultLevel: "medium" as const,
                  }
                : undefined,
            getDefaultReasoningLevel: () => "minimal",
            prompt: (...args: Parameters<typeof runtime.prompt>) =>
              Effect.gen(function* () {
                const options = yield* runtime.getConfigOptions;
                sent.push({
                  model: options.find((option) => option.id === "model")?.currentValue,
                  effort: options.find((option) => option.id === "reasoning_effort")?.currentValue,
                });
                return yield* runtime.prompt(...args);
              }),
          };
        }),
    });
    const instanceId = ProviderInstanceId.make("droid");
    const scient = { instanceId, model: "custom:Ox-Alpha-0" };
    const configuredDefault = { ...scient, options: [{ id: "reasoningEffort", value: "minimal" }] };
    const notice = "Droid uses Low for this model instead of the configured default Minimal.";
    // Each thread starts with one selection and sends its first message with another.
    const cases = [
      {
        name: "another level picked before the first message",
        start: configuredDefault,
        send: { ...scient, options: [{ id: "reasoningEffort", value: "high" }] },
        sent: { model: "custom:Ox-Alpha-0", effort: "high" },
        warnings: [],
      },
      {
        name: "another model picked before the first message",
        start: configuredDefault,
        send: { instanceId, model: "composer-2" },
        sent: { model: "composer-2", effort: undefined },
        warnings: [],
      },
      {
        name: "the model with the replaced default picked with the first message",
        start: undefined,
        send: configuredDefault,
        sent: { model: "custom:Ox-Alpha-0", effort: "low" },
        warnings: [notice],
      },
    ];
    for (const [index, entry] of cases.entries()) {
      const threadId = ThreadId.make(`droid-superseded-notice-${index}`);
      yield* adapter.startSession({
        threadId,
        cwd: process.cwd(),
        runtimeMode: "full-access",
        ...(entry.start ? { modelSelection: entry.start } : {}),
      });
      const completed = yield* adapter.streamEvents.pipe(
        Stream.takeUntil((event) => event.type === "turn.completed"),
        Stream.runCollect,
        Effect.forkChild,
      );
      yield* adapter.sendTurn({
        threadId,
        input: "hello",
        attachments: [],
        modelSelection: entry.send,
      });
      const events = yield* Fiber.join(completed);
      assert.deepEqual(sent.at(-1), entry.sent, entry.name);
      assert.deepEqual(
        events.flatMap((event) =>
          event.type === "runtime.warning" ? [event.payload.message] : [],
        ),
        entry.warnings,
        entry.name,
      );
      yield* adapter.stopSession(threadId);
    }
  }).pipe(Effect.scoped, Effect.provide(droidAdapterTestLayer)),
);

it.effect("sends nothing when the report that replaces the default also names another model", () =>
  Effect.gen(function* () {
    const wrapperPath = yield* Effect.promise(() =>
      makeMockDroidWrapper({ T3_ACP_DROID_EFFORT_REPLACEMENT: "minimal=low" }),
    );
    yield* Effect.addFinalizer(() =>
      Effect.promise(() =>
        NodeFSP.rm(NodePath.dirname(wrapperPath), { recursive: true, force: true }),
      ),
    );
    let prompts = 0;
    let reportsOtherModel = false;
    const adapter = yield* makeTestAdapter(wrapperPath, {
      makeAcpRuntime: (input) =>
        Effect.gen(function* () {
          const runtime = yield* makeDroidAcpRuntime({
            ...input,
            resolveConfigOptions: (options) =>
              options.map((option) =>
                option.id === "reasoning_effort" && option.type === "select"
                  ? {
                      ...option,
                      options: ["minimal", "low", "medium", "high"].map((value) => ({
                        value,
                        name: value,
                      })),
                    }
                  : // Droid's report of the effort write names another model as current.
                    option.id === "model" && option.type === "select" && reportsOtherModel
                    ? { ...option, currentValue: "composer-2" }
                    : option,
              ),
          });
          return {
            ...runtime,
            // Only the Scient model has metadata; the other one is Droid's own.
            getReasoningMetadata: (model: string) =>
              model === "custom:Ox-Alpha-0"
                ? {
                    status: "known" as const,
                    supported: true,
                    mode: "effort" as const,
                    levels: ["minimal", "low", "medium", "high"] as const,
                    defaultLevel: "medium" as const,
                  }
                : undefined,
            getDefaultReasoningLevel: () => "minimal",
            setConfigOption: (...args: Parameters<typeof runtime.setConfigOption>) =>
              runtime.setConfigOption(...args).pipe(
                Effect.ensuring(
                  Effect.sync(() => {
                    if (args[0] === "reasoning_effort") reportsOtherModel = true;
                  }),
                ),
              ),
            prompt: (...args: Parameters<typeof runtime.prompt>) => {
              prompts += 1;
              return runtime.prompt(...args);
            },
          };
        }),
    });
    const threadId = ThreadId.make("droid-replaced-default-other-model");
    yield* adapter.startSession({ threadId, cwd: process.cwd(), runtimeMode: "full-access" });
    const sent = yield* adapter
      .sendTurn({
        threadId,
        input: "hello",
        attachments: [],
        modelSelection: {
          instanceId: ProviderInstanceId.make("droid"),
          model: "custom:Ox-Alpha-0",
          options: [{ id: "reasoningEffort", value: "minimal" }],
        },
      })
      .pipe(Effect.exit);
    assert.equal(prompts, 0);
    assert.include(
      Exit.isFailure(sent) ? String(Cause.squash(sent.cause)) : "sent",
      'Droid reported the model "composer-2" instead of "custom:Ox-Alpha-0" after the reasoning effort was set, so the message was not sent.',
    );
  }).pipe(Effect.scoped, Effect.provide(droidAdapterTestLayer)),
);

it.effect("rejects inherited metadata conflicts before prompting an unchanged model", () =>
  Effect.gen(function* () {
    const wrapperPath = yield* Effect.promise(() => makeMockDroidWrapper());
    yield* Effect.addFinalizer(() =>
      Effect.promise(() =>
        NodeFSP.rm(NodePath.dirname(wrapperPath), { recursive: true, force: true }),
      ),
    );
    let known = false;
    let prompts = 0;
    const adapter = yield* makeTestAdapter(wrapperPath, {
      makeAcpRuntime: (input) =>
        Effect.gen(function* () {
          const runtime = yield* makeDroidAcpRuntime(input);
          return {
            ...runtime,
            getReasoningMetadata: () =>
              known
                ? {
                    status: "known" as const,
                    supported: true,
                    levels: ["high" as const],
                    source: "provider" as const,
                    checkedAt: "2026-09-06T00:00:00Z",
                    stale: true,
                  }
                : null,
            prompt: (...args: Parameters<typeof runtime.prompt>) => {
              prompts += 1;
              return runtime.prompt(...args);
            },
          };
        }),
    });
    const threadId = ThreadId.make("droid-inherited-metadata-conflict");
    yield* adapter.startSession({
      threadId,
      cwd: process.cwd(),
      runtimeMode: "full-access",
      modelSelection: { instanceId: ProviderInstanceId.make("droid"), model: "custom:Ox-Alpha-0" },
    });
    known = true;
    const result = yield* Effect.exit(
      adapter.sendTurn({ threadId, input: "hello", attachments: [] }),
    );
    assert.equal(result._tag, "Failure");
    assert.equal(prompts, 0);
  }).pipe(Effect.scoped, Effect.provide(droidAdapterTestLayer)),
);

it.effect("says once per turn that Droid is retrying a custom model's endpoint", () =>
  Effect.gen(function* () {
    const wrapperPath = yield* Effect.promise(() => makeMockDroidWrapper());
    yield* Effect.addFinalizer(() =>
      Effect.promise(() =>
        NodeFSP.rm(NodePath.dirname(wrapperPath), { recursive: true, force: true }),
      ),
    );
    const adapter = yield* makeTestAdapter(wrapperPath, {
      makeAcpRuntime: (input) =>
        makeDroidAcpRuntime(input).pipe(
          // The endpoint answered 429 while the prompt runs (Droid keeps retrying).
          Effect.map((runtime) => ({ ...runtime, upstreamRetrying: Effect.succeed(429) })),
        ),
    });
    const threadId = ThreadId.make("droid-upstream-retry");
    yield* adapter.startSession({ threadId, cwd: process.cwd(), runtimeMode: "full-access" });
    const events = yield* adapter.streamEvents.pipe(
      Stream.takeUntil((event) => event.type === "turn.completed"),
      Stream.runCollect,
      Effect.forkChild,
    );
    yield* adapter.sendTurn({ threadId, input: "hello", attachments: [] });
    const warnings = (yield* Fiber.join(events)).filter(
      (event) => event.type === "runtime.warning",
    );
    assert.deepEqual(
      warnings.map((event) => event.payload.message),
      [
        "The model endpoint answered HTTP 429 (rate limited). Droid is retrying it, which can take a few minutes.",
      ],
    );
  }).pipe(Effect.scoped, Effect.provide(droidAdapterTestLayer)),
);

it.effect("starts a custom-model request budget for each new turn", () =>
  Effect.gen(function* () {
    const wrapperPath = yield* Effect.promise(() => makeMockDroidWrapper());
    yield* Effect.addFinalizer(() =>
      Effect.promise(() =>
        NodeFSP.rm(NodePath.dirname(wrapperPath), { recursive: true, force: true }),
      ),
    );
    let budgets = 0;
    const adapter = yield* makeTestAdapter(wrapperPath, {
      makeAcpRuntime: (input) =>
        makeDroidAcpRuntime(input).pipe(
          Effect.map((runtime) => ({
            ...runtime,
            beginTurn: Effect.sync(() => {
              budgets++;
            }),
          })),
        ),
    });
    const threadId = ThreadId.make("droid-turn-budget");
    yield* adapter.startSession({ threadId, cwd: process.cwd(), runtimeMode: "full-access" });
    for (const input of ["one", "two"]) {
      const completed = yield* adapter.streamEvents.pipe(
        Stream.takeUntil((event) => event.type === "turn.completed"),
        Stream.runCollect,
        Effect.forkChild,
      );
      yield* adapter.sendTurn({ threadId, input, attachments: [] });
      yield* Fiber.join(completed);
    }
    assert.equal(budgets, 2);
  }).pipe(Effect.scoped, Effect.provide(droidAdapterTestLayer)),
);

it.effect(
  "ends a turn stopped at the custom-model request limit and starts over next time",
  () =>
    Effect.gen(function* () {
      const wrapperPath = yield* Effect.promise(() => makeMockDroidWrapper());
      yield* Effect.addFinalizer(() =>
        Effect.promise(() =>
          NodeFSP.rm(NodePath.dirname(wrapperPath), { recursive: true, force: true }),
        ),
      );
      const breach = {
        reason: "truncated-responses" as const,
        message: "The model stopped at its output limit 5 times in a row.",
      };
      const adapter = yield* makeTestAdapter(wrapperPath, {
        makeAcpRuntime: (input) =>
          Effect.gen(function* () {
            const runtime = yield* makeDroidAcpRuntime(input);
            let breached: typeof breach | undefined;
            return {
              ...runtime,
              requestLimitBreach: () => breached,
              prompt: (...args: Parameters<typeof runtime.prompt>) =>
                runtime.prompt(...args).pipe(
                  Effect.map(() => {
                    breached = breach;
                    return { stopReason: "max_tokens" as const };
                  }),
                ),
            };
          }),
      });
      const threadId = ThreadId.make("droid-request-limit");
      yield* adapter.startSession({ threadId, cwd: process.cwd(), runtimeMode: "full-access" });
      const collected = yield* adapter.streamEvents.pipe(
        Stream.takeUntil((event) => event.type === "session.exited"),
        Stream.runCollect,
        Effect.forkChild,
      );
      yield* adapter.sendTurn({ threadId, input: "loop", attachments: [] });
      const events = Array.from(yield* Fiber.join(collected));
      const kinds = events.map((event) => event.type);
      assert.deepEqual(
        kinds.filter((kind) =>
          ["runtime.warning", "turn.completed", "session.exited"].includes(kind),
        ),
        ["runtime.warning", "turn.completed", "session.exited"],
      );
      const warning = events.find((event) => event.type === "runtime.warning");
      assert.equal(warning?.type === "runtime.warning" && warning.payload.message, breach.message);
      const terminal = events.find((event) => event.type === "turn.completed");
      assert.equal(terminal?.turnId, warning?.turnId);
      assert.equal(
        terminal?.type === "turn.completed" && terminal.payload.stopReason,
        "max_tokens",
      );
      // Droid may still be winding down its loop: the next message starts a fresh process.
      assert.equal(yield* adapter.hasSession(threadId), false);
    }).pipe(Effect.scoped, Effect.provide(droidAdapterTestLayer)),
  20_000,
);

for (const partial of ["", "Preserved partial answer"]) {
  it.effect(
    `reports a token limit and recovers on the same Droid session (${partial || "empty"})`,
    () =>
      Effect.gen(function* () {
        const wrapperPath = yield* Effect.promise(() =>
          makeMockDroidWrapper({
            T3_ACP_TOKEN_LIMIT_FIRST: "1",
            T3_ACP_TOKEN_LIMIT_TEXT: partial,
          }),
        );
        yield* Effect.addFinalizer(() =>
          Effect.promise(() =>
            NodeFSP.rm(NodePath.dirname(wrapperPath), { recursive: true, force: true }),
          ),
        );
        const adapter = yield* makeTestAdapter(wrapperPath);
        const threadId = ThreadId.make("droid-token-limit");
        yield* adapter.startSession({ threadId, cwd: process.cwd(), runtimeMode: "full-access" });
        for (const limited of [true, false]) {
          const collected = yield* adapter.streamEvents.pipe(
            Stream.takeUntil((event) => event.type === "turn.completed"),
            Stream.runCollect,
            Effect.forkChild,
          );
          yield* adapter.sendTurn({
            threadId,
            input: limited ? `token-limit:${partial}` : "recover",
            attachments: [],
          });
          const events = Array.from(yield* Fiber.join(collected));
          const terminal = events.find((event) => event.type === "turn.completed");
          assert.equal(terminal?.payload.state, "completed");
          assert.equal(terminal?.payload.stopReason, limited ? "max_tokens" : "end_turn");
          assert.equal(
            events.some((event) => event.type === "runtime.error"),
            false,
          );
          assert.equal(events.filter((event) => event.type === "turn.completed").length, 1);
          assert.equal(
            events
              .flatMap((event) =>
                event.type === "content.delta" && event.payload.streamKind === "assistant_text"
                  ? [event.payload.delta]
                  : [],
              )
              .join(""),
            limited ? partial : "hello from mock",
          );
          const session = (yield* adapter.listSessions()).find(
            (session) => session.threadId === threadId,
          );
          assert.equal(session?.status, "ready");
          assert.isUndefined(session?.activeTurnId);
        }
      }).pipe(Effect.scoped, Effect.provide(droidAdapterTestLayer)),
  );
}

it.effect(
  "excludes a retired model runtime from reusable sessions and cold-starts its replacement",
  () =>
    Effect.gen(function* () {
      const wrapperPath = yield* Effect.promise(() => makeMockDroidWrapper());
      let generation = 0;
      const adapter = yield* makeTestAdapter(wrapperPath, {
        makeAcpRuntime: (input) =>
          Effect.gen(function* () {
            const startedGeneration = generation;
            const runtime = yield* makeDroidAcpRuntime(input);
            return { ...runtime, isConfigurationCurrent: () => generation === startedGeneration };
          }),
      });
      const threadId = ThreadId.make("droid-retired-custom-model");
      const input = { threadId, cwd: process.cwd(), runtimeMode: "full-access" as const };
      const original = yield* adapter.startSession(input);
      assert.isTrue(yield* adapter.hasSession(threadId));
      generation++;
      assert.isFalse(yield* adapter.hasSession(threadId));
      assert.isEmpty(yield* adapter.listSessions());
      yield* adapter.startSession({ ...input, resumeCursor: original.resumeCursor });
      assert.isTrue(yield* adapter.hasSession(threadId));
      yield* adapter.sendTurn({ threadId, input: "hello again", attachments: [] });
    }).pipe(Effect.scoped, Effect.provide(droidAdapterTestLayer)),
);

it("maps runtime modes onto Droid's graduated autonomy ladder", () => {
  assert.equal(resolveDroidAutonomyModeId("approval-required"), "normal");
  assert.equal(resolveDroidAutonomyModeId("auto-accept-edits"), "auto-low");
  assert.equal(resolveDroidAutonomyModeId("auto"), "auto-medium");
  assert.equal(resolveDroidAutonomyModeId("full-access"), "auto-high");
});

it("detects nested Task tool calls for watchdog extension", () => {
  assert.isTrue(isDroidNestedTaskToolCall({ title: "Task", rawInput: undefined }));
  assert.isTrue(
    isDroidNestedTaskToolCall({
      title: "Anything",
      rawInput: { subagent_type: "worker" },
    }),
  );
  assert.isFalse(isDroidNestedTaskToolCall({ title: "Read file", rawInput: {} }));
  assert.isFalse(isDroidNestedTaskToolCall({ title: null, rawInput: undefined }));
});

it("resolves the configured Droid binary or delegates to PATH", () => {
  assert.equal(resolveDroidCliBinaryPath("/opt/droid"), "/opt/droid");
  assert.equal(resolveDroidCliBinaryPath("  /opt/droid  "), "/opt/droid");
  assert.equal(resolveDroidCliBinaryPath(undefined), "droid");
  assert.equal(resolveDroidCliBinaryPath(""), "droid");
});

it("builds the model inventory from config options with the current ladder", () => {
  const models = buildDroidModelsFromConfigOptions([
    {
      id: "model",
      name: "Model",
      category: "model",
      type: "select",
      currentValue: "gpt-5.6-sol",
      options: [
        { value: "gpt-5.6-sol", name: "GPT-5.6 Sol" },
        { value: "claude-opus-5", name: "Opus 5" },
      ],
    },
    {
      id: "reasoning_effort",
      name: "Reasoning",
      category: "thought_level",
      type: "select",
      currentValue: "high",
      options: [
        { value: "none", name: "None" },
        { value: "medium", name: "Medium" },
        { value: "high", name: "High" },
      ],
    },
  ] as never);
  assert.equal(models.length, 2);
  // The snapshot's effort ladder describes the *selected* model only; Droid
  // validates efforts per model, so other entries must stay ladderless.
  assert.equal(models[0]?.slug, "gpt-5.6-sol");
  assert.equal(models[0]?.capabilitiesObserved, true);
  assert.equal(models[0]?.currentEffortValue, "high");
  assert.deepEqual(
    models[0]?.efforts.map((effort) => effort.value),
    ["none", "medium", "high"],
  );
  assert.equal(models[1]?.slug, "claude-opus-5");
  assert.equal(models[1]?.capabilitiesObserved, false);
  assert.equal(models[1]?.currentEffortValue, undefined);
  assert.deepEqual(models[1]?.efforts, []);
});

it.layer(droidAdapterTestLayer)("DroidAdapterLive", (it) => {
  it.effect("starts a session and settles a prompt turn over the mock ACP agent", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("droid-mock-thread");
      // The async-refresh knob mirrors the real @factory/cli behavior:
      // inventory is refreshed through config-option notifications.
      const wrapperPath = yield* Effect.promise(() =>
        makeMockDroidWrapper({ T3_ACP_DROID_ASYNC_CONFIG_REFRESH: "1" }),
      );
      const adapter = yield* makeTestAdapter(wrapperPath);

      const runtimeEvents: ProviderRuntimeEvent[] = [];
      const turnCompleted = yield* Deferred.make<void>();
      const eventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.sync(() => {
          runtimeEvents.push(event);
          if (event.type === "turn.completed") {
            void event;
          }
        }).pipe(
          Effect.andThen(
            event.type === "turn.completed"
              ? Deferred.succeed(turnCompleted, undefined)
              : Effect.void,
          ),
        ),
      ).pipe(Effect.forkChild);

      const session = yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("droid"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
        modelSelection: {
          instanceId: ProviderInstanceId.make("droid"),
          model: "composer-2",
        },
      });

      assert.equal(session.provider, "droid");
      assert.equal(session.model, "composer-2");
      assert.deepStrictEqual(session.resumeCursor, {
        schemaVersion: 1,
        sessionId: "mock-session-1",
      });

      yield* adapter.sendTurn({
        threadId,
        input: "hello droid",
        attachments: [],
      });

      yield* Deferred.await(turnCompleted);
      yield* Fiber.interrupt(eventsFiber);

      const types = runtimeEvents.map((event) => event.type);
      assert.includeMembers(types, [
        "session.started",
        "session.state.changed",
        "thread.started",
        "turn.started",
        "content.delta",
        "turn.completed",
      ] as const);

      const completed = runtimeEvents.findLast((event) => event.type === "turn.completed") as
        | { payload: { state: string } }
        | undefined;
      assert.equal(completed?.payload.state, "completed");

      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("advertises and completes standard ACP form elicitation", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("droid-mock-elicitation-thread");
      const requestLogDir = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "droid-acp-elicitation-")),
      );
      const requestLogPath = NodePath.join(requestLogDir, "requests.ndjson");
      const wrapperPath = yield* Effect.promise(() =>
        makeMockDroidWrapper({
          T3_ACP_EMIT_ELICITATION: "1",
          T3_ACP_REQUEST_LOG_PATH: requestLogPath,
        }),
      );
      const adapter = yield* makeTestAdapter(wrapperPath);
      const requested =
        yield* Deferred.make<Extract<ProviderRuntimeEvent, { type: "user-input.requested" }>>();
      const resolved =
        yield* Deferred.make<Extract<ProviderRuntimeEvent, { type: "user-input.resolved" }>>();

      const eventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) => {
        if (String(event.threadId) !== String(threadId)) {
          return Effect.void;
        }
        if (event.type === "user-input.requested") {
          return Deferred.succeed(requested, event).pipe(Effect.ignore);
        }
        if (event.type === "user-input.resolved") {
          return Deferred.succeed(resolved, event).pipe(Effect.ignore);
        }
        return Effect.void;
      }).pipe(Effect.forkChild);

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("droid"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });

      const sendTurnFiber = yield* adapter
        .sendTurn({ threadId, input: "ask before continuing", attachments: [] })
        .pipe(Effect.forkChild);

      const requestedEvent = yield* Deferred.await(requested);
      assert.equal(requestedEvent.payload.questions.length, 1);
      assert.deepEqual(requestedEvent.payload.questions[0], {
        id: "scope",
        header: "Scope",
        question: "Which scope should Droid use?",
        options: [
          { label: "workspace", description: "Workspace" },
          { label: "session", description: "Session" },
        ],
      });
      assert.equal(requestedEvent.raw?.method, "session/elicitation");

      yield* adapter.respondToUserInput(
        threadId,
        ApprovalRequestId.make(String(requestedEvent.requestId)),
        { scope: "workspace" },
      );

      const resolvedEvent = yield* Deferred.await(resolved);
      assert.deepEqual(resolvedEvent.payload.answers, { scope: "workspace" });
      yield* Fiber.join(sendTurnFiber);

      const requests = (yield* Effect.promise(() => NodeFSP.readFile(requestLogPath, "utf8")))
        .trim()
        .split("\n")
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line) as { method?: string; params?: unknown });
      const initializeRequest = requests.find((request) => request.method === "initialize") as
        | {
            params?: {
              clientCapabilities?: { elicitation?: { form?: Record<string, unknown> } };
            };
          }
        | undefined;
      assert.deepEqual(initializeRequest?.params?.clientCapabilities?.elicitation?.form, {});

      yield* Fiber.interrupt(eventsFiber);
      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("applies a changed model before the next turn and retains it on the session", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("droid-mock-model-switch-thread");
      const wrapperPath = yield* Effect.promise(() =>
        makeMockDroidWrapper({ T3_ACP_DROID_ASYNC_CONFIG_REFRESH: "1" }),
      );
      const adapter = yield* makeTestAdapter(wrapperPath);

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("droid"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
        modelSelection: {
          instanceId: ProviderInstanceId.make("droid"),
          model: "composer-2",
        },
      });

      yield* adapter.sendTurn({
        threadId,
        input: "use the newly selected model",
        attachments: [],
        modelSelection: {
          instanceId: ProviderInstanceId.make("droid"),
          model: "composer-2[fast=true]",
        },
      });

      const session = (yield* adapter.listSessions()).find(
        (candidate) => candidate.threadId === threadId,
      );
      assert.equal(session?.model, "composer-2[fast=true]");
      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("switches to a custom model and applies its advertised reasoning effort", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("droid-mock-custom-model-switch-thread");
      const requestLogDir = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "droid-acp-custom-effort-")),
      );
      const requestLogPath = NodePath.join(requestLogDir, "requests.ndjson");
      const wrapperPath = yield* Effect.promise(() =>
        makeMockDroidWrapper({
          T3_ACP_DROID_ASYNC_CONFIG_REFRESH: "1",
          T3_ACP_REQUEST_LOG_PATH: requestLogPath,
        }),
      );
      const adapter = yield* makeTestAdapter(wrapperPath);

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("droid"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
        modelSelection: {
          instanceId: ProviderInstanceId.make("droid"),
          model: "composer-2",
        },
      });

      yield* adapter.sendTurn({
        threadId,
        input: "use the custom model",
        attachments: [],
        modelSelection: {
          instanceId: ProviderInstanceId.make("droid"),
          model: "custom:Ox-Alpha-0",
          options: [{ id: "reasoningEffort", value: "high" }],
        },
      });

      const session = (yield* adapter.listSessions()).find(
        (candidate) => candidate.threadId === threadId,
      );
      assert.equal(session?.model, "custom:Ox-Alpha-0");
      yield* adapter.stopSession(threadId);

      const requests = (yield* Effect.promise(() => NodeFSP.readFile(requestLogPath, "utf8")))
        .trim()
        .split("\n")
        .filter((line) => line.length > 0)
        .map(
          (line) =>
            JSON.parse(line) as {
              method?: string;
              params?: { configId?: string; value?: unknown };
            },
        );
      assert.isTrue(
        requests.some(
          (request) =>
            request.method === "session/set_config_option" &&
            request.params?.configId === "reasoning_effort" &&
            request.params.value === "high",
        ),
      );
    }),
  );

  it.effect("interrupts an in-flight hung turn and tears the session down", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("droid-mock-hang-thread");
      // The mock agent's hang knob keeps every prompt open forever.
      const wrapperPath = yield* Effect.promise(() =>
        makeMockDroidWrapper({ T3_ACP_HANG_PROMPT_FOREVER: "1" }),
      );
      const adapter = yield* makeTestAdapter(wrapperPath);

      const runtimeEvents: ProviderRuntimeEvent[] = [];
      const eventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.sync(() => {
          runtimeEvents.push(event);
        }),
      ).pipe(Effect.forkChild);

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("droid"),
        cwd: process.cwd(),
        runtimeMode: "approval-required",
      });

      // Fork the interrupt with a delay so sendTurn is already blocked in the
      // prompt RPC when Stop lands (the proven Grok test shape).
      yield* Effect.gen(function* () {
        yield* Effect.sleep("500 millis");
        yield* adapter.interruptTurn(threadId);
      }).pipe(Effect.forkChild({ startImmediately: true }));

      yield* adapter
        .sendTurn({
          threadId,
          input: "this will hang",
          attachments: [],
        })
        .pipe(Effect.ignore);
      for (let yieldAttempt = 0; yieldAttempt < 8; yieldAttempt += 1) {
        yield* Effect.yieldNow;
      }

      const cancelledEvents = runtimeEvents.filter(
        (event): event is Extract<ProviderRuntimeEvent, { type: "turn.completed" }> =>
          event.type === "turn.completed" && String(event.threadId) === String(threadId),
      );
      assert.lengthOf(cancelledEvents, 1);
      assert.equal(cancelledEvents[0]?.payload.state, "cancelled");
      // Cancel-always-teardown: the session must be gone afterwards.
      assert.isFalse(yield* adapter.hasSession(threadId));
      yield* Fiber.interrupt(eventsFiber);
    }).pipe(TestClock.withLive),
  );

  it.effect("fails the turn, not the send, when the prompt RPC errors after the turn started", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("droid-mock-failprompt-thread");
      const wrapperPath = yield* Effect.promise(() =>
        makeMockDroidWrapper({ T3_ACP_FAIL_PROMPT: "1" }),
      );
      const adapter = yield* makeTestAdapter(wrapperPath);

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("droid"),
        cwd: process.cwd(),
        runtimeMode: "approval-required",
      });
      assert.isTrue(yield* adapter.hasSession(threadId));

      const completed = yield* adapter.streamEvents.pipe(
        Stream.takeUntil((event) => event.type === "turn.completed"),
        Stream.runCollect,
        Effect.forkChild,
      );
      yield* adapter.sendTurn({ threadId, input: "boom", attachments: [] });
      const terminal = Array.from(yield* Fiber.join(completed)).find(
        (event) => event.type === "turn.completed",
      );
      assert.equal(terminal?.payload.state, "failed");
      assert.equal(terminal?.payload.errorMessage, "Mock prompt failure");
      // Agent-level request error keeps the session alive for retry.
      assert.isTrue(yield* adapter.hasSession(threadId));

      yield* adapter.stopSession(threadId);
    }),
  );
});

// it.live: the watchdog compares real wall-clock deadlines against a real
// child process; under it.effect's TestClock the clock never advances. This
// test sits outside the it.layer block because the layered `it` has no .live.
it.live("DroidAdapterLive watchdog fails a turn whose child stays silent", () =>
  Effect.gen(function* () {
    const threadId = ThreadId.make("droid-mock-watchdog-thread");
    const wrapperPath = yield* Effect.promise(() =>
      makeMockDroidWrapper({ T3_ACP_HANG_PROMPT_FOREVER: "1" }),
    );
    // Short idle window so the watchdog fires quickly; ticks run at a
    // quarter of the window.
    const previousIdle = process.env.SCIENT_DROID_TURN_IDLE_TIMEOUT_MS;
    process.env.SCIENT_DROID_TURN_IDLE_TIMEOUT_MS = "400";
    try {
      const adapter = yield* makeTestAdapter(wrapperPath);
      const runtimeEvents: ProviderRuntimeEvent[] = [];
      const eventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.sync(() => {
          runtimeEvents.push(event);
        }),
      ).pipe(Effect.forkChild);

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("droid"),
        cwd: process.cwd(),
        runtimeMode: "approval-required",
      });

      yield* adapter
        .sendTurn({
          threadId,
          input: "silent forever",
          attachments: [],
        })
        .pipe(Effect.ignore);
      for (let yieldAttempt = 0; yieldAttempt < 8; yieldAttempt += 1) {
        yield* Effect.yieldNow;
      }

      const failedEvents = runtimeEvents.filter(
        (event): event is Extract<ProviderRuntimeEvent, { type: "turn.completed" }> =>
          event.type === "turn.completed" && String(event.threadId) === String(threadId),
      );
      assert.lengthOf(failedEvents, 1);
      assert.equal(failedEvents[0]?.payload.state, "failed");
      // Cancel-always-teardown: watchdog force-settle also tears down.
      assert.isFalse(yield* adapter.hasSession(threadId));
      yield* Fiber.interrupt(eventsFiber);
    } finally {
      if (previousIdle === undefined) {
        delete process.env.SCIENT_DROID_TURN_IDLE_TIMEOUT_MS;
      } else {
        process.env.SCIENT_DROID_TURN_IDLE_TIMEOUT_MS = previousIdle;
      }
    }
  }).pipe(Effect.provide(droidAdapterTestLayer)),
);

// ── Thread runtime reliability ───────────────────────────────────────────

/** Collects every adapter event; `until` polls the real clock. */
const recordEvents = (adapter: { readonly streamEvents: Stream.Stream<ProviderRuntimeEvent> }) =>
  Effect.gen(function* () {
    const events: Array<ProviderRuntimeEvent> = [];
    yield* Stream.runForEach(adapter.streamEvents, (event) =>
      Effect.sync(() => void events.push(event)),
    ).pipe(Effect.forkScoped);
    yield* Effect.yieldNow;
    const until = (predicate: (events: ReadonlyArray<ProviderRuntimeEvent>) => boolean) =>
      Effect.gen(function* () {
        while (!predicate(events)) yield* Effect.sleep("10 millis");
      }).pipe(Effect.timeout("8 seconds"), Effect.orDie);
    return { events, until };
  });

const terminals = (events: ReadonlyArray<ProviderRuntimeEvent>) =>
  events.flatMap((event) => (event.type === "turn.completed" ? [event] : []));
const sessionExits = (events: ReadonlyArray<ProviderRuntimeEvent>) =>
  events.flatMap((event) => (event.type === "session.exited" ? [event.payload] : []));
/** Every start and end of a turn, in order. */
const turnEvents = (events: ReadonlyArray<ProviderRuntimeEvent>) =>
  events.flatMap((event) =>
    event.type === "turn.started"
      ? [event.type]
      : event.type === "turn.completed"
        ? [`${event.type}:${event.payload.state}`]
        : [],
  );

const liveAdapterTest = <A, E>(
  name: string,
  body: () => Effect.Effect<A, E, Scope.Scope | Layer.Success<typeof droidAdapterTestLayer>>,
  timeout = 30_000,
) =>
  it.live(name, () => body().pipe(Effect.scoped, Effect.provide(droidAdapterTestLayer)), timeout);

const hangingPrompt = `
const pending = [];
function onPrompt(message) {
  update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "working " } });
  pending.push(message);
}
onCancel = () => { for (const message of pending.splice(0)) reply(message, { stopReason: "end_turn" }); };
`;

liveAdapterTest("fails the running turn once and drops the session when Droid dies mid-turn", () =>
  Effect.gen(function* () {
    const droid = yield* scriptedDroid(`
function onPrompt() {
  update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "partial" } });
  setTimeout(() => { process.stderr.write("fatal: fixture crash\\n"); process.exit(3); }, 50);
}`);
    const adapter = yield* makeTestAdapter(droid.binaryPath);
    const { events, until } = yield* recordEvents(adapter);
    const threadId = ThreadId.make("droid-dies-mid-turn");
    yield* adapter.startSession({ threadId, cwd: process.cwd(), runtimeMode: "full-access" });
    const sent = yield* adapter
      .sendTurn({ threadId, input: "go", attachments: [] })
      .pipe(Effect.exit);
    yield* until((all) => all.some((event) => event.type === "session.exited"));
    // The turn's failure is carried by its terminal event, not by a turn-start error.
    assert.equal(sent._tag, "Success");
    const ended = terminals(events);
    assert.lengthOf(ended, 1);
    assert.equal(ended[0]?.payload.state, "failed");
    assert.include(ended[0]?.payload.errorMessage ?? "", "fixture crash");
    const exited = events.find((event) => event.type === "session.exited");
    assert.equal(exited?.type === "session.exited" && exited.payload.exitKind, "error");
    assert.isFalse(yield* adapter.hasSession(threadId));
    assert.isEmpty(yield* adapter.listSessions());
  }),
);

liveAdapterTest("drops the session when an idle Droid dies, so the next send starts fresh", () =>
  Effect.gen(function* () {
    const droid = yield* scriptedDroid(`
function onPrompt(message) {
  reply(message, { stopReason: "end_turn" });
  setTimeout(() => process.exit(4), 100);
}`);
    const adapter = yield* makeTestAdapter(droid.binaryPath);
    const { events, until } = yield* recordEvents(adapter);
    const threadId = ThreadId.make("droid-dies-idle");
    const input = { threadId, cwd: process.cwd(), runtimeMode: "full-access" as const };
    const session = yield* adapter.startSession(input);
    yield* adapter.sendTurn({ threadId, input: "one", attachments: [] });
    yield* until((all) => all.some((event) => event.type === "session.exited"));
    assert.lengthOf(terminals(events), 1);
    assert.equal(terminals(events)[0]?.payload.state, "completed");
    assert.isFalse(yield* adapter.hasSession(threadId));
    yield* adapter.startSession({ ...input, resumeCursor: session.resumeCursor });
    assert.isTrue(yield* adapter.hasSession(threadId));
  }),
);

// A settings change Droid answered but never reported leaves its settings
// unknown, so its process is closed and the conversation resumes in a new one.
const UNREPORTED = 'unreported = (message) => message.params.value === "droid-other";';
const UNREPORTED_MESSAGE =
  'The agent answered the change of model to "droid-other" but did not report the applied value within 0.3 s, so its session was closed.';
const quickToGiveUp = {
  makeAcpRuntime: (input: Parameters<typeof makeDroidAcpRuntime>[0]) =>
    makeDroidAcpRuntime({ ...input, configOptionSettleTimeout: "300 millis" }),
};
const toOtherModel = {
  instanceId: ProviderInstanceId.make("droid"),
  model: "droid-other",
};

liveAdapterTest(
  "ends the session when Droid does not report a settings change, so the next send starts fresh",
  () =>
    Effect.gen(function* () {
      const droid = yield* scriptedDroid(`
function onPrompt(message) { reply(message, { stopReason: "end_turn" }); }
${UNREPORTED}`);
      const adapter = yield* makeTestAdapter(droid.binaryPath, quickToGiveUp);
      const { events, until } = yield* recordEvents(adapter);
      const threadId = ThreadId.make("droid-unreported-change");
      const input = { threadId, cwd: process.cwd(), runtimeMode: "full-access" as const };
      const session = yield* adapter.startSession(input);
      yield* adapter.sendTurn({ threadId, input: "one", attachments: [] });
      yield* until((all) => terminals(all).length === 1);

      const refused = yield* adapter
        .sendTurn({ threadId, input: "two", attachments: [], modelSelection: toOtherModel })
        .pipe(Effect.flip);
      assert.include(refused.message, UNREPORTED_MESSAGE);
      yield* until((all) => all.some((event) => event.type === "session.exited"));
      const exited = events.filter((event) => event.type === "session.exited");
      assert.deepEqual(
        exited.map((event) => event.payload),
        [
          {
            exitKind: "error",
            reason: UNREPORTED_MESSAGE,
            recoverable: true,
          },
        ],
      );
      // The message that was not sent started no turn.
      assert.lengthOf(terminals(events), 1);
      assert.isFalse(yield* adapter.hasSession(threadId));

      yield* adapter.startSession({ ...input, resumeCursor: session.resumeCursor });
      yield* adapter.sendTurn({ threadId, input: "three", attachments: [] });
      yield* until((all) => terminals(all).length === 2);
      assert.equal(terminals(events)[1]?.payload.state, "completed");
      const inbound = yield* droid.readLog();
      // A new process: the closed one got nothing after the unreported change.
      assert.deepEqual(
        inbound.flatMap((message) =>
          message.method === "initialize" ||
          message.method === "session/prompt" ||
          (message.method === "session/set_config_option" && message.params?.configId === "model")
            ? [message.method]
            : [],
        ),
        [
          "initialize",
          "session/prompt",
          "session/set_config_option",
          "initialize",
          "session/prompt",
        ],
      );
    }),
);

liveAdapterTest(
  "fails the running turn once when a follow-up's settings change is not reported",
  () =>
    Effect.gen(function* () {
      const droid = yield* scriptedDroid(`${hangingPrompt}\n${UNREPORTED}`);
      const adapter = yield* makeTestAdapter(droid.binaryPath, quickToGiveUp);
      const { events, until } = yield* recordEvents(adapter);
      const threadId = ThreadId.make("droid-unreported-change-mid-turn");
      yield* adapter.startSession({ threadId, cwd: process.cwd(), runtimeMode: "full-access" });
      yield* adapter
        .sendTurn({ threadId, input: "one", attachments: [] })
        .pipe(Effect.ignore, Effect.forkScoped);
      yield* until((all) => all.some((event) => event.type === "turn.started"));

      const refused = yield* adapter
        .sendTurn({ threadId, input: "two", attachments: [], modelSelection: toOtherModel })
        .pipe(Effect.flip);
      assert.include(refused.message, UNREPORTED_MESSAGE);
      yield* until((all) => all.some((event) => event.type === "session.exited"));
      yield* Effect.sleep("300 millis");
      assert.deepEqual(
        terminals(events).map((event) => event.payload),
        [
          {
            state: "failed",
            errorMessage: UNREPORTED_MESSAGE,
          },
        ],
      );
      assert.lengthOf(
        events.filter((event) => event.type === "session.exited"),
        1,
      );
      assert.isFalse(yield* adapter.hasSession(threadId));
      assert.lengthOf(
        (yield* droid.readLog()).filter((message) => message.method === "session/prompt"),
        1,
      );
    }),
);

it.effect("declares that Droid conversations cannot be rewound", () =>
  Effect.gen(function* () {
    const adapter = yield* makeTestAdapter("droid");
    assert.isFalse(adapter.capabilities.supportsConversationRollback);
  }).pipe(Effect.scoped, Effect.provide(droidAdapterTestLayer)),
);

const withIdleTimeout = (millis: string) =>
  Effect.acquireRelease(
    Effect.sync(() => {
      const previous = process.env.SCIENT_DROID_TURN_IDLE_TIMEOUT_MS;
      process.env.SCIENT_DROID_TURN_IDLE_TIMEOUT_MS = millis;
      return previous;
    }),
    (previous) =>
      Effect.sync(() => {
        if (previous === undefined) delete process.env.SCIENT_DROID_TURN_IDLE_TIMEOUT_MS;
        else process.env.SCIENT_DROID_TURN_IDLE_TIMEOUT_MS = previous;
      }),
  );

liveAdapterTest("keeps the idle watchdog paused while a request waits for the user", () =>
  Effect.gen(function* () {
    yield* withIdleTimeout("300");
    const droid = yield* scriptedDroid(`
async function onPrompt(message) {
  const answer = await request("session/request_permission", {
    toolCall: { toolCallId: "edit", title: "Edit file", kind: "edit", status: "pending" },
    options: [{ optionId: "yes", name: "Allow", kind: "allow_once" }, { optionId: "no", name: "Reject", kind: "reject_once" }],
  });
  reply(message, { stopReason: answer.result?.outcome?.optionId === "yes" ? "end_turn" : "cancelled" });
}`);
    const adapter = yield* makeTestAdapter(droid.binaryPath);
    const { events, until } = yield* recordEvents(adapter);
    const threadId = ThreadId.make("droid-watchdog-waits-for-user");
    yield* adapter.startSession({ threadId, cwd: process.cwd(), runtimeMode: "approval-required" });
    const turn = yield* adapter
      .sendTurn({ threadId, input: "edit", attachments: [] })
      .pipe(Effect.forkScoped);
    yield* until((all) => all.some((event) => event.type === "request.opened"));
    // Four idle windows pass while the user decides.
    yield* Effect.sleep("1200 millis");
    const opened = events.find((event) => event.type === "request.opened");
    assert.lengthOf(terminals(events), 0);
    yield* adapter.respondToRequest(
      threadId,
      ApprovalRequestId.make(String(opened?.requestId)),
      "accept",
    );
    yield* Fiber.join(turn);
    assert.deepEqual(
      terminals(events).map((event) => event.payload.state),
      ["completed"],
    );
  }),
);

liveAdapterTest("states the configured idle window and forgets unfinished Tasks at turn end", () =>
  Effect.gen(function* () {
    yield* withIdleTimeout("300");
    const droid = yield* scriptedDroid(`
function onPrompt(message) {
  if (state.prompts === 1) {
    // A nested Task Droid never reports finished.
    update({ sessionUpdate: "tool_call", toolCallId: "task-1", title: "Task", kind: "other", status: "in_progress",
      rawInput: { subagent_type: "worker" } });
    return reply(message, { stopReason: "end_turn" });
  }
  // Silent from here on.
}`);
    const adapter = yield* makeTestAdapter(droid.binaryPath);
    const { events, until } = yield* recordEvents(adapter);
    const threadId = ThreadId.make("droid-watchdog-task-reset");
    yield* adapter.startSession({ threadId, cwd: process.cwd(), runtimeMode: "full-access" });
    yield* adapter.sendTurn({ threadId, input: "one", attachments: [] });
    yield* adapter
      .sendTurn({ threadId, input: "two", attachments: [] })
      .pipe(Effect.ignore, Effect.forkScoped);
    yield* until((all) => terminals(all).length === 2);
    const stalled = terminals(events)[1];
    assert.equal(stalled?.payload.state, "failed");
    assert.equal(stalled?.payload.errorMessage, "Droid turn exceeded the idle timeout (300ms).");
  }),
);

liveAdapterTest("steers by stopping the running prompt, then sending the follow-up", () =>
  Effect.gen(function* () {
    const droid = yield* scriptedDroid(`
const pending = [];
function onPrompt(message) {
  if (state.prompts === 1) return void pending.push(message);
  reply(message, { stopReason: "end_turn" });
}
onCancel = () => { for (const message of pending.splice(0)) reply(message, { stopReason: "end_turn" }); };
`);
    const adapter = yield* makeTestAdapter(droid.binaryPath);
    const { events, until } = yield* recordEvents(adapter);
    const threadId = ThreadId.make("droid-steer");
    yield* adapter.startSession({ threadId, cwd: process.cwd(), runtimeMode: "full-access" });
    const first = yield* adapter
      .sendTurn({ threadId, input: "first", attachments: [] })
      .pipe(Effect.forkScoped);
    yield* until((all) => all.some((event) => event.type === "turn.started"));
    const second = yield* adapter.sendTurn({ threadId, input: "follow-up", attachments: [] });
    const firstResult = yield* Fiber.join(first);
    assert.equal(second.turnId, firstResult.turnId);
    const methods = (yield* droid.readLog())
      .map((message) => message.method)
      .filter((method) => method === "session/prompt" || method === "session/cancel");
    assert.deepEqual(methods, ["session/prompt", "session/cancel", "session/prompt"]);
    yield* until((all) => terminals(all).length === 1);
    assert.equal(terminals(events)[0]?.payload.state, "completed");
    assert.equal(events.filter((event) => event.type === "turn.started").length, 1);
  }),
);

liveAdapterTest(
  "lets the follow-up's result decide the turn even if the stopped prompt returns last",
  () =>
    Effect.gen(function* () {
      const droid = yield* scriptedDroid(`
const pending = [];
function onPrompt(message) {
  if (state.prompts === 1) return void pending.push(message);
  reply(message, { stopReason: "end_turn" });
}
onCancel = () => { for (const message of pending.splice(0)) reply(message, { stopReason: "end_turn" }); };
`);
      let prompts = 0;
      const adapter = yield* makeTestAdapter(droid.binaryPath, {
        makeAcpRuntime: (input) =>
          makeDroidAcpRuntime(input).pipe(
            Effect.map((runtime) => ({
              ...runtime,
              prompt: (...args: Parameters<typeof runtime.prompt>) =>
                ++prompts === 1
                  ? runtime.prompt(...args).pipe(Effect.tap(() => Effect.sleep("300 millis")))
                  : runtime.prompt(...args),
            })),
          ),
      });
      const { events, until } = yield* recordEvents(adapter);
      const threadId = ThreadId.make("droid-steer-late-original");
      yield* adapter.startSession({ threadId, cwd: process.cwd(), runtimeMode: "full-access" });
      yield* adapter
        .sendTurn({ threadId, input: "first", attachments: [] })
        .pipe(Effect.forkScoped);
      yield* until((all) => all.some((event) => event.type === "turn.started"));
      yield* adapter.sendTurn({ threadId, input: "follow-up", attachments: [] });
      yield* until((all) => terminals(all).length === 1);
      assert.equal(terminals(events)[0]?.payload.state, "completed");
      assert.equal(terminals(events)[0]?.payload.stopReason, "end_turn");
    }),
);

// A follow-up cancels the running prompt and, with it, what that prompt has
// running. While a tool call or a sub-agent runs, the follow-up waits instead.
const HELD_NOTICE =
  "Your message will be delivered when the current step finishes. Stop interrupts now.";
const NOT_DELIVERED_NOTICE = "Your waiting message was not delivered. Send it again to continue.";
const notices = (events: ReadonlyArray<ProviderRuntimeEvent>) =>
  events.flatMap((event) => (event.type === "runtime.warning" ? [event.payload.message] : []));
/** What reached Droid, in order: each prompt's text, and each cancel. */
const delivered = (droid: { readonly readLog: () => Effect.Effect<ReadonlyArray<unknown>> }) =>
  droid.readLog().pipe(
    Effect.map((log) =>
      (
        log as ReadonlyArray<{
          readonly method?: string;
          readonly params?: { readonly prompt?: ReadonlyArray<{ readonly text?: string }> };
        }>
      ).flatMap((message) =>
        message.method === "session/prompt"
          ? [message.params?.prompt?.[0]?.text]
          : message.method === "session/cancel"
            ? ["cancel"]
            : [],
      ),
    ),
  );
/** The first prompt runs a command; `end` is what Droid does after announcing it. */
const runningStep = (end: string) => `
const pending = [];
const step = (sessionUpdate, status) => update({ sessionUpdate, toolCallId: "run", title: "Run the tests", kind: "execute", status });
function onPrompt(message) {
  if (state.prompts > 1) return reply(message, { stopReason: "end_turn" });
  step("tool_call", "pending");
  pending.push(message);
  ${end}
}
onCancel = () => { for (const message of pending.splice(0)) reply(message, { stopReason: "cancelled" }); };`;
const stepStarted = (events: ReadonlyArray<ProviderRuntimeEvent>) =>
  events.some((event) => event.type === "item.updated" || event.type === "item.started");

liveAdapterTest("holds a follow-up while a step runs and sends it once the step is done", () =>
  Effect.gen(function* () {
    const droid = yield* scriptedDroid(
      runningStep(`setTimeout(() => step("tool_call_update", "completed"), 700);`),
    );
    const adapter = yield* makeTestAdapter(droid.binaryPath);
    const { events, until } = yield* recordEvents(adapter);
    const threadId = ThreadId.make("droid-held-follow-up");
    yield* adapter.startSession({ threadId, cwd: process.cwd(), runtimeMode: "full-access" });
    const first = yield* adapter
      .sendTurn({ threadId, input: "first", attachments: [] })
      .pipe(Effect.forkScoped);
    yield* until(stepStarted);
    const followUp = yield* adapter
      .sendTurn({ threadId, input: "follow-up", attachments: [] })
      .pipe(Effect.forkScoped);
    yield* until((all) => notices(all).length > 0);
    // The step is still running: nothing was cancelled and nothing more was sent.
    assert.deepEqual(notices(events), [HELD_NOTICE]);
    assert.deepEqual(yield* delivered(droid), ["first"]);

    yield* until((all) => terminals(all).length === 1);
    assert.deepEqual(yield* delivered(droid), ["first", "cancel", "follow-up"]);
    // The step finished; it was not cut off.
    const step = events.findLast(
      (event) => event.type === "item.completed" && String(event.itemId) === "run",
    );
    assert.equal(step?.type === "item.completed" && step.payload.status, "completed");
    assert.deepEqual(notices(events), [HELD_NOTICE]);
    assert.deepEqual(turnEvents(events), ["turn.started", "turn.completed:completed"]);
    assert.equal((yield* Fiber.join(followUp)).turnId, (yield* Fiber.join(first)).turnId);
  }),
);

liveAdapterTest("keeps holding a follow-up when the next step starts as the last one ends", () =>
  Effect.gen(function* () {
    // One step ends and the next begins in the same breath (one write, so Scient
    // has both when it looks again); the second ends later.
    const droid = yield* scriptedDroid(`
const pending = [];
const wire = (toolCallId, sessionUpdate, status) => JSON.stringify({ jsonrpc: "2.0", method: "session/update",
  params: { sessionId: "scripted", update: { sessionUpdate, toolCallId, title: "Run " + toolCallId, kind: "execute", status } } }) + "\\n";
const step = (...calls) => process.stdout.write(calls.map((call) => wire(...call)).join(""));
function onPrompt(message) {
  if (state.prompts > 1) return reply(message, { stopReason: "end_turn" });
  step(["run", "tool_call", "pending"]);
  pending.push(message);
  setTimeout(() => step(["run", "tool_call_update", "completed"], ["next", "tool_call", "pending"]), 400);
  setTimeout(() => step(["next", "tool_call_update", "completed"]), 1100);
}
onCancel = () => {
  // A cancel while the second step runs cuts it off.
  if (pending.length > 0) step(["next", "tool_call_update", "failed"]);
  for (const message of pending.splice(0)) reply(message, { stopReason: "cancelled" });
};`);
    const adapter = yield* makeTestAdapter(droid.binaryPath);
    const { events, until } = yield* recordEvents(adapter);
    const threadId = ThreadId.make("droid-held-follow-up-next-step");
    yield* adapter.startSession({ threadId, cwd: process.cwd(), runtimeMode: "full-access" });
    yield* adapter
      .sendTurn({ threadId, input: "first", attachments: [] })
      .pipe(Effect.ignore, Effect.forkScoped);
    yield* until(stepStarted);
    yield* adapter.sendTurn({ threadId, input: "follow-up", attachments: [] });
    yield* until((all) => terminals(all).length === 1);
    const ended = events.flatMap((event) =>
      event.type === "item.completed" && event.payload.itemType !== "assistant_message"
        ? [`${String(event.itemId)}: ${event.payload.status}`]
        : [],
    );
    // The second step ran to its end before the follow-up was sent.
    assert.deepEqual(ended, ["run: completed", "next: completed"]);
    assert.deepEqual(yield* delivered(droid), ["first", "cancel", "follow-up"]);
    // Held twice, said once.
    assert.deepEqual(notices(events), [HELD_NOTICE]);
  }),
);

// The prompt ends on its own with the step never reported finished; the follow-up
// is the turn's next prompt, and the step's row is still that turn's.
for (const [outcome, followUp, row, turn] of [
  ["completes", `reply(message, { stopReason: "end_turn" });`, "inProgress", "completed"],
  [
    "fails",
    `fail(message, { code: -32603, message: "Internal error", data: "boom" });`,
    "failed",
    "failed",
  ],
  ["is stopped", ``, "failed", "cancelled"],
] as const)
  liveAdapterTest(
    `sends a held follow-up as the next prompt when the running prompt ends (it ${outcome})`,
    () =>
      Effect.gen(function* () {
        const droid = yield* scriptedDroid(`
const pending = [];
function onPrompt(message) {
  if (state.prompts > 1) { ${followUp} return; }
  update({ sessionUpdate: "tool_call", toolCallId: "run", title: "Run the tests", kind: "execute", status: "pending" });
  setTimeout(() => reply(message, { stopReason: "end_turn" }), 500);
}`);
        const adapter = yield* makeTestAdapter(droid.binaryPath);
        const { events, until } = yield* recordEvents(adapter);
        const threadId = ThreadId.make("droid-held-follow-up-next-prompt");
        yield* adapter.startSession({ threadId, cwd: process.cwd(), runtimeMode: "full-access" });
        yield* adapter
          .sendTurn({ threadId, input: "first", attachments: [] })
          .pipe(Effect.ignore, Effect.forkScoped);
        yield* until(stepStarted);
        yield* adapter
          .sendTurn({ threadId, input: "follow-up", attachments: [] })
          .pipe(Effect.ignore, Effect.forkScoped);
        if (outcome === "is stopped") {
          while ((yield* delivered(droid)).length < 2) yield* Effect.sleep("20 millis");
          yield* adapter.interruptTurn(threadId);
        }
        yield* until((all) => terminals(all).length === 1);
        // Nothing was running any more, so nothing was cancelled to send it.
        assert.deepEqual((yield* delivered(droid)).slice(0, 2), ["first", "follow-up"]);
        assert.deepEqual(notices(events), [HELD_NOTICE]);
        // A turn that does not complete leaves no row of its own in progress.
        const rows = events.flatMap((event) =>
          (event.type === "item.updated" || event.type === "item.completed") &&
          String(event.itemId) === "run"
            ? [event.payload.status]
            : event.type === "turn.completed"
              ? [`turn ${event.payload.state}`]
              : [],
        );
        assert.deepEqual(rows, [
          "inProgress",
          ...(row === "failed" ? ["failed"] : []),
          `turn ${turn}`,
        ]);
      }),
  );

// A step the first prompt left open is not work of the prompt that follows, so a
// later follow-up is sent at once: whether the step's last update arrives with
// the first prompt's end and is taken in late (notifications are logged before
// they are handled), or Droid reports on the step again during the next prompt.
for (const [what, atEnd, inNext, first = `step("run", "tool_call", "pending");`] of [
  ["a step it had announced", `step("run", "tool_call_update", "in_progress");`, ``],
  ["a step it announces as it ends", `step("late", "tool_call", "pending");`, ``],
  ["a step Droid reports on again later", ``, `step("run", "tool_call_update", "in_progress");`],
  [
    "a foreground sub-agent it never reported finished",
    ``,
    ``,
    `update({ sessionUpdate: "tool_call", toolCallId: "task", title: "Task", kind: "other", status: "pending",
      rawInput: { subagent_type: "explorer", description: "Audit", prompt: "Audit it.", await: true } });`,
  ],
] as const)
  liveAdapterTest(`holds no follow-up for ${what} once the prompt that made it returned`, () =>
    Effect.gen(function* () {
      const droid = yield* scriptedDroid(`
const pending = [];
const step = (toolCallId, sessionUpdate, status) => update({ sessionUpdate, toolCallId, title: "Run the tests", kind: "execute", status });
function onPrompt(message) {
  if (state.prompts > 2) return reply(message, { stopReason: "end_turn" });
  // The second prompt runs no step of its own and stays open.
  if (state.prompts === 2) { ${inNext} return pending.push(message); }
  ${first}
  setTimeout(() => { ${atEnd} reply(message, { stopReason: "end_turn" }); }, 500);
}
onCancel = () => { for (const message of pending.splice(0)) reply(message, { stopReason: "cancelled" }); };`);
      const adapter = yield* makeTestAdapter(droid.binaryPath, {
        nativeEventLogger: {
          filePath: "memory",
          write: (entry) =>
            (entry as { readonly event?: { readonly method?: string } }).event?.method ===
            "session/update"
              ? Effect.sleep("200 millis")
              : Effect.void,
          close: () => Effect.void,
        },
      });
      const { events, until } = yield* recordEvents(adapter);
      const threadId = ThreadId.make("droid-follow-up-after-returned-prompt");
      yield* adapter.startSession({ threadId, cwd: process.cwd(), runtimeMode: "full-access" });
      yield* adapter
        .sendTurn({ threadId, input: "first", attachments: [] })
        .pipe(Effect.ignore, Effect.forkScoped);
      yield* until((all) => stepStarted(all) || all.some((event) => event.type === "task.started"));
      yield* adapter
        .sendTurn({ threadId, input: "follow-up", attachments: [] })
        .pipe(Effect.ignore, Effect.forkScoped);
      while ((yield* delivered(droid)).length < 2) yield* Effect.sleep("20 millis");
      // Every update sent so far has been taken in by now.
      yield* Effect.sleep("500 millis");
      yield* adapter.sendTurn({ threadId, input: "third", attachments: [] });
      yield* until((all) => terminals(all).length === 1);
      assert.deepEqual(yield* delivered(droid), ["first", "follow-up", "cancel", "third"]);
      assert.deepEqual(notices(events), [HELD_NOTICE]);
      assert.deepEqual(turnEvents(events), ["turn.started", "turn.completed:completed"]);
    }),
  );

liveAdapterTest("holds a follow-up while a background sub-agent is not known finished", () =>
  Effect.gen(function* () {
    const droid = yield* scriptedDroid(`
const pending = [];
const result = (toolCallId, text) => update({ sessionUpdate: "tool_call_update", toolCallId, status: "completed",
  content: [{ type: "content", content: { type: "text", text } }], rawOutput: { text } });
function onPrompt(message) {
  if (state.prompts > 1) return reply(message, { stopReason: "end_turn" });
  update({ sessionUpdate: "tool_call", toolCallId: "task", title: "Task", kind: "other", status: "pending",
    rawInput: { subagent_type: "explorer", description: "Review the host", prompt: "Review it." } });
  result("task", "Task launched in background.\\ntask_id: t-1\\nsession_id: t-1");
  pending.push(message);
  // The main agent is only writing now; the sub-agent reports later.
  setTimeout(() => {
    update({ sessionUpdate: "tool_call", toolCallId: "wait", title: "TaskOutput", kind: "other", status: "pending", rawInput: { task_id: "t-1", block: true, timeout: 600000 } });
    result("wait", "Task ID: t-1\\nDescription: Review the host\\nStatus: completed\\nDuration: 1s\\n\\nThe host is sound.");
  }, 700);
}
onCancel = () => { for (const message of pending.splice(0)) reply(message, { stopReason: "cancelled" }); };`);
    const adapter = yield* makeTestAdapter(droid.binaryPath);
    const { events, until } = yield* recordEvents(adapter);
    const threadId = ThreadId.make("droid-held-follow-up-background");
    yield* adapter.startSession({ threadId, cwd: process.cwd(), runtimeMode: "full-access" });
    yield* adapter
      .sendTurn({ threadId, input: "first", attachments: [] })
      .pipe(Effect.ignore, Effect.forkScoped);
    yield* until((all) =>
      all.some(
        (event) => event.type === "task.progress" && /background/.test(event.payload.summary ?? ""),
      ),
    );
    const followUp = yield* adapter
      .sendTurn({ threadId, input: "follow-up", attachments: [] })
      .pipe(Effect.forkScoped);
    yield* until((all) => notices(all).length > 0);
    assert.deepEqual(yield* delivered(droid), ["first"]);
    yield* Fiber.join(followUp);
    assert.deepEqual(yield* delivered(droid), ["first", "cancel", "follow-up"]);
    // The sub-agent was left to finish: Droid's own report ended it.
    assert.include(subagentFlow(events), "completed task: completed | The host is sound.");
    assert.notInclude(subagentFlow(events).join("\n"), "cancelled");
  }),
);

liveAdapterTest("never delivers a held follow-up after Stop, and says so", () =>
  Effect.gen(function* () {
    const droid = yield* scriptedDroid(runningStep(""));
    const adapter = yield* makeTestAdapter(droid.binaryPath);
    const { events, until } = yield* recordEvents(adapter);
    const threadId = ThreadId.make("droid-held-follow-up-stop");
    yield* adapter.startSession({ threadId, cwd: process.cwd(), runtimeMode: "full-access" });
    yield* adapter
      .sendTurn({ threadId, input: "first", attachments: [] })
      .pipe(Effect.ignore, Effect.forkScoped);
    yield* until(stepStarted);
    const followUp = yield* adapter
      .sendTurn({ threadId, input: "follow-up", attachments: [] })
      .pipe(Effect.exit, Effect.forkScoped);
    yield* until((all) => notices(all).length > 0);
    yield* adapter.interruptTurn(threadId);
    const sent = yield* Fiber.join(followUp);
    // Not delivered, and not a failure either.
    assert.isTrue(Exit.isFailure(sent) && Cause.hasInterruptsOnly(sent.cause), String(sent));
    yield* until((all) => all.some((event) => event.type === "session.exited"));
    assert.deepEqual(yield* delivered(droid), ["first", "cancel"]);
    assert.deepEqual(notices(events), [HELD_NOTICE, NOT_DELIVERED_NOTICE]);
    // Said in the turn, before it ends.
    const kinds = events.flatMap((event) =>
      event.type === "runtime.warning" || event.type === "turn.completed" ? [event.type] : [],
    );
    assert.deepEqual(kinds, ["runtime.warning", "runtime.warning", "turn.completed"]);
    assert.deepEqual(
      terminals(events).map((event) => event.payload.state),
      ["cancelled"],
    );
  }),
);

liveAdapterTest("replaces a held follow-up with a newer one", () =>
  Effect.gen(function* () {
    const droid = yield* scriptedDroid(
      runningStep(`setTimeout(() => step("tool_call_update", "completed"), 700);`),
    );
    const adapter = yield* makeTestAdapter(droid.binaryPath);
    const { events, until } = yield* recordEvents(adapter);
    const threadId = ThreadId.make("droid-held-follow-up-replaced");
    yield* adapter.startSession({ threadId, cwd: process.cwd(), runtimeMode: "full-access" });
    yield* adapter
      .sendTurn({ threadId, input: "first", attachments: [] })
      .pipe(Effect.ignore, Effect.forkScoped);
    yield* until(stepStarted);
    const older = yield* adapter
      .sendTurn({ threadId, input: "older", attachments: [] })
      .pipe(Effect.exit, Effect.forkScoped);
    yield* until((all) => notices(all).length > 0);
    yield* adapter.sendTurn({ threadId, input: "newer", attachments: [] });
    const replaced = yield* Fiber.join(older);
    assert.isTrue(Exit.isFailure(replaced) && Cause.hasInterruptsOnly(replaced.cause));
    yield* until((all) => terminals(all).length === 1);
    assert.deepEqual(yield* delivered(droid), ["first", "cancel", "newer"]);
    // One notice for the wait, however many messages took the place.
    assert.deepEqual(notices(events), [HELD_NOTICE]);
  }),
);

liveAdapterTest("Stop never releases a queued follow-up to Droid", () =>
  Effect.gen(function* () {
    const droid = yield* scriptedDroid(hangingPrompt);
    // Hold the first cancel so Stop lands while the follow-up is still queued.
    const entered = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    let cancels = 0;
    const adapter = yield* makeTestAdapter(droid.binaryPath, {
      makeAcpRuntime: (input) =>
        makeDroidAcpRuntime(input).pipe(
          Effect.map((runtime) => ({
            ...runtime,
            cancel: Effect.suspend(() =>
              ++cancels === 1
                ? Deferred.succeed(entered, undefined).pipe(
                    Effect.andThen(Deferred.await(release)),
                    Effect.andThen(runtime.cancel),
                  )
                : runtime.cancel,
            ),
          })),
        ),
    });
    const { events, until } = yield* recordEvents(adapter);
    const threadId = ThreadId.make("droid-stop-queued");
    yield* adapter.startSession({ threadId, cwd: process.cwd(), runtimeMode: "full-access" });
    yield* adapter
      .sendTurn({ threadId, input: "first", attachments: [] })
      .pipe(Effect.ignore, Effect.forkScoped);
    yield* until((all) => all.some((event) => event.type === "turn.started"));
    yield* adapter
      .sendTurn({ threadId, input: "follow-up", attachments: [] })
      .pipe(Effect.ignore, Effect.forkScoped);
    // Old behavior queued the follow-up behind the running prompt without a cancel.
    yield* Deferred.await(entered).pipe(Effect.timeout("1 second"), Effect.ignore);
    const stop = yield* adapter.interruptTurn(threadId).pipe(Effect.forkScoped);
    yield* Effect.sleep("100 millis");
    yield* Deferred.succeed(release, undefined);
    yield* Fiber.join(stop);
    yield* until((all) => all.some((event) => event.type === "session.exited"));
    const prompts = (yield* droid.readLog()).filter(
      (message) => message.method === "session/prompt",
    );
    assert.lengthOf(prompts, 1);
    assert.deepEqual(
      terminals(events).map((event) => event.payload.state),
      ["cancelled"],
    );
  }),
);

liveAdapterTest("Stop keeps what Droid sends on its way out", () =>
  Effect.gen(function* () {
    // Droid 0.213.0 and 0.231.0 answer a cancelled prompt 20 to 60 ms after the
    // cancel, having first sent the text they had buffered and the final tool states.
    const droid = yield* scriptedDroid(`
const pending = [];
function onPrompt(message) {
  update({ sessionUpdate: "tool_call", toolCallId: "run", title: "Run the tests", kind: "execute", status: "pending" });
  pending.push(message);
}
const failed = () => update({ sessionUpdate: "tool_call_update", toolCallId: "run", status: "failed", rawOutput: { text: "Error: Tool execution cancelled by user" } });
onCancel = () => setTimeout(() => {
  failed();
  // Droid 0.213.0 announces the call it cancelled again, untitled, and fails it again.
  update({ sessionUpdate: "tool_call", toolCallId: "run", title: "Tool call", kind: "other", status: "pending", rawInput: {} });
  failed();
  update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "The answer so far" } });
  for (const message of pending.splice(0)) reply(message, { stopReason: "cancelled" });
}, 60);`);
    const adapter = yield* makeTestAdapter(droid.binaryPath);
    const { events, until } = yield* recordEvents(adapter);
    const threadId = ThreadId.make("droid-stop-keeps-answer");
    yield* adapter.startSession({ threadId, cwd: process.cwd(), runtimeMode: "full-access" });
    const turn = yield* adapter
      .sendTurn({ threadId, input: "work", attachments: [] })
      .pipe(Effect.exit, Effect.forkScoped);
    yield* until(stepStarted);
    const startedAt = yield* Clock.currentTimeMillis;
    yield* adapter.interruptTurn(threadId);
    // As soon as Droid answered, not after the longest Scient would wait.
    assert.isBelow((yield* Clock.currentTimeMillis) - startedAt, 1_000);
    assert.equal((yield* Fiber.join(turn))._tag, "Success");
    const story = events.flatMap((event) =>
      event.type === "content.delta"
        ? [`text: ${event.payload.delta}`]
        : (event.type === "item.updated" || event.type === "item.completed") &&
            String(event.itemId) === "run"
          ? [`step: ${event.payload.title} ${event.payload.status}`]
          : event.type === "turn.completed"
            ? [`turn: ${event.payload.state}`]
            : event.type === "session.exited"
              ? ["session exited"]
              : [],
    );
    // The partial answer and the step's end belong to the turn: they come before it
    // ends. The step ends once, under its own name.
    assert.deepEqual(story, [
      "step: Ran command inProgress",
      "step: Ran command failed",
      "text: The answer so far",
      "turn: cancelled",
      "session exited",
    ]);
    assert.isFalse(yield* adapter.hasSession(threadId));
  }),
);

for (const [how, onCancel] of [
  [
    "answers the cancel without reporting it",
    `for (const message of pending.splice(0)) reply(message, { stopReason: "cancelled" });`,
  ],
  ["never answers the cancel", ""],
] as const)
  liveAdapterTest(`Stop ends the row of a command Droid ${how}`, () =>
    Effect.gen(function* () {
      const droid = yield* scriptedDroid(`
const pending = [];
function onPrompt(message) {
  update({ sessionUpdate: "tool_call", toolCallId: "run", title: "Run the tests", kind: "execute", status: "pending" });
  update({ sessionUpdate: "tool_call", toolCallId: "wait", title: "TaskOutput", kind: "other", status: "pending", rawInput: { task_id: "t-1", block: true, timeout: 600000 } });
  pending.push(message);
}
onCancel = () => { ${onCancel} };`);
      const adapter = yield* makeTestAdapter(droid.binaryPath);
      const { events, until } = yield* recordEvents(adapter);
      const threadId = ThreadId.make("droid-stop-unreported-command");
      yield* adapter.startSession({ threadId, cwd: process.cwd(), runtimeMode: "full-access" });
      yield* adapter
        .sendTurn({ threadId, input: "work", attachments: [] })
        .pipe(Effect.ignore, Effect.forkScoped);
      yield* until((all) => subagentFlow(all).length === 2);
      yield* adapter.interruptTurn(threadId);
      yield* until((all) => all.some((event) => event.type === "session.exited"));
      // Each row ends, under its own name, before the turn does.
      assert.deepEqual(
        [...subagentFlow(events), ...turnEvents(events).slice(1)],
        [
          "row run: command_execution inProgress | Ran command | undefined",
          "row wait: collab_agent_tool_call inProgress | Waiting for a sub-agent (up to 10 min) | undefined",
          "row run: command_execution failed | Ran command | undefined",
          "row wait: collab_agent_tool_call failed | Waiting for a sub-agent (up to 10 min) | undefined",
          "turn.completed:cancelled",
        ],
      );
      const order = events.flatMap((event) =>
        event.type === "item.completed" || event.type === "turn.completed" ? [event.type] : [],
      );
      assert.deepEqual(order, ["item.completed", "item.completed", "turn.completed"]);
    }),
  );

liveAdapterTest("ends the row of a step Droid announced just before it failed the prompt", () =>
  Effect.gen(function* () {
    // The step's announcement and the prompt's failure arrive together.
    const droid = yield* scriptedDroid(`
function onPrompt(message) {
  update({ sessionUpdate: "tool_call", toolCallId: "run", title: "Run the tests", kind: "execute", status: "pending" });
  fail(message, { code: -32603, message: "Internal error: Agent error", data: "500 upstream error" });
}`);
    // Notifications are logged before they are handled; a slow log write lets the
    // prompt's failure get ahead of the step's announcement.
    const adapter = yield* makeTestAdapter(droid.binaryPath, {
      nativeEventLogger: {
        filePath: "memory",
        write: (entry) =>
          (entry as { readonly event?: { readonly method?: string } }).event?.method ===
          "session/update"
            ? Effect.sleep("200 millis")
            : Effect.void,
        close: () => Effect.void,
      },
    });
    const { events, until } = yield* recordEvents(adapter);
    const threadId = ThreadId.make("droid-step-then-failure");
    yield* adapter.startSession({ threadId, cwd: process.cwd(), runtimeMode: "full-access" });
    yield* adapter.sendTurn({ threadId, input: "work", attachments: [] }).pipe(Effect.exit);
    yield* until((all) => terminals(all).length === 1);
    const rows = events.flatMap((event) =>
      (event.type === "item.updated" || event.type === "item.completed") &&
      String(event.itemId) === "run"
        ? [event.payload.status]
        : event.type === "turn.completed"
          ? [`turn ${event.payload.state}`]
          : [],
    );
    assert.deepEqual(rows, ["inProgress", "failed", "turn failed"]);
  }),
);

liveAdapterTest("Stop ends a turn promptly without failing its send", () =>
  Effect.gen(function* () {
    // Like Droid with nested workers still running: cancel is acknowledged, the prompt stays open.
    const droid = yield* scriptedDroid(
      `const pending = []; function onPrompt(message) { pending.push(message); }`,
    );
    const adapter = yield* makeTestAdapter(droid.binaryPath);
    const { events, until } = yield* recordEvents(adapter);
    const threadId = ThreadId.make("droid-stop-prompt");
    yield* adapter.startSession({ threadId, cwd: process.cwd(), runtimeMode: "full-access" });
    const turn = yield* adapter
      .sendTurn({ threadId, input: "work", attachments: [] })
      .pipe(Effect.exit, Effect.forkScoped);
    yield* until((all) => all.some((event) => event.type === "turn.started"));
    const startedAt = yield* Clock.currentTimeMillis;
    yield* adapter.interruptTurn(threadId);
    // Scient waits two seconds for Droid's answer to the cancel, and no longer.
    assert.isBelow((yield* Clock.currentTimeMillis) - startedAt, 3_500);
    const sent = yield* Fiber.join(turn);
    assert.equal(sent._tag, "Success");
    assert.deepEqual(
      terminals(events).map((event) => event.payload.state),
      ["cancelled"],
    );
    assert.isFalse(yield* adapter.hasSession(threadId));
  }),
);

liveAdapterTest("Stop during a follow-up's preparation still ends the turn exactly once", () =>
  Effect.gen(function* () {
    const droid = yield* scriptedDroid(hangingPrompt);
    const gate = yield* Deferred.make<void>();
    const entered = yield* Deferred.make<void>();
    const adapter = yield* makeTestAdapter(droid.binaryPath, {
      makeAcpRuntime: (input) =>
        makeDroidAcpRuntime(input).pipe(
          Effect.map((runtime) => ({
            ...runtime,
            setModel: (model: string) =>
              model === "droid-other"
                ? Deferred.succeed(entered, undefined).pipe(
                    Effect.andThen(Deferred.await(gate)),
                    Effect.andThen(runtime.setModel(model)),
                  )
                : runtime.setModel(model),
          })),
        ),
    });
    const { events, until } = yield* recordEvents(adapter);
    const threadId = ThreadId.make("droid-stop-during-steer");
    yield* adapter.startSession({ threadId, cwd: process.cwd(), runtimeMode: "full-access" });
    yield* adapter
      .sendTurn({ threadId, input: "first", attachments: [] })
      .pipe(Effect.ignore, Effect.forkScoped);
    yield* until((all) => all.some((event) => event.type === "turn.started"));
    yield* adapter
      .sendTurn({
        threadId,
        input: "follow-up",
        attachments: [],
        modelSelection: { instanceId: ProviderInstanceId.make("droid"), model: "droid-other" },
      })
      .pipe(Effect.ignore, Effect.forkScoped);
    yield* Deferred.await(entered);
    const stop = yield* adapter.interruptTurn(threadId).pipe(Effect.forkScoped);
    yield* Effect.sleep("50 millis");
    yield* Deferred.succeed(gate, undefined);
    yield* Fiber.join(stop);
    yield* until((all) => all.some((event) => event.type === "session.exited"));
    assert.deepEqual(
      terminals(events).map((event) => event.payload.state),
      ["cancelled"],
    );
  }),
);

liveAdapterTest("accepts for the session with allow-once when Droid offers no allow-always", () =>
  Effect.gen(function* () {
    const droid = yield* scriptedDroid(`
async function onPrompt(message) {
  const answer = await request("session/request_permission", {
    toolCall: { toolCallId: "run", title: "Run", kind: "execute", status: "pending" },
    options: [{ optionId: "once", name: "Allow", kind: "allow_once" }, { optionId: "no", name: "Reject", kind: "reject_once" }],
  });
  reply(message, { stopReason: "end_turn" });
}`);
    const adapter = yield* makeTestAdapter(droid.binaryPath);
    const { events, until } = yield* recordEvents(adapter);
    const threadId = ThreadId.make("droid-accept-session-once");
    yield* adapter.startSession({ threadId, cwd: process.cwd(), runtimeMode: "approval-required" });
    const turn = yield* adapter
      .sendTurn({ threadId, input: "run", attachments: [] })
      .pipe(Effect.forkScoped);
    yield* until((all) => all.some((event) => event.type === "request.opened"));
    const opened = events.find((event) => event.type === "request.opened");
    yield* adapter.respondToRequest(
      threadId,
      ApprovalRequestId.make(String(opened?.requestId)),
      "acceptForSession",
    );
    yield* Fiber.join(turn);
    const answers = (yield* droid.readLog()).filter((message) => message.result?.outcome);
    assert.deepEqual(
      answers.map((message) => message.result?.outcome),
      [{ outcome: "selected", optionId: "once" }],
    );
  }),
);

liveAdapterTest("captures Stop for the running turn and confirms it ended", () =>
  Effect.gen(function* () {
    const droid = yield* scriptedDroid(hangingPrompt);
    const adapter = yield* makeTestAdapter(droid.binaryPath);
    const { events, until } = yield* recordEvents(adapter);
    const threadId = ThreadId.make("droid-capture-stop");
    // Before the session exists, Stop is reported as undeliverable, not silently dropped.
    const early = yield* adapter.captureTurnStop!(threadId).pipe(Effect.flip);
    assert.equal(early._tag, "ProviderAdapterSessionNotFoundError");
    yield* adapter.startSession({ threadId, cwd: process.cwd(), runtimeMode: "full-access" });
    yield* adapter
      .sendTurn({ threadId, input: "work", attachments: [] })
      .pipe(Effect.ignore, Effect.forkScoped);
    yield* until((all) => all.some((event) => event.type === "turn.started"));
    const stop = yield* adapter.captureTurnStop!(threadId);
    assert.equal(yield* stop.confirm, "active");
    yield* stop.interrupt;
    assert.equal(yield* stop.confirm, "ended");
    assert.deepEqual(
      terminals(events).map((event) => event.payload.state),
      ["cancelled"],
    );
    assert.isFalse(yield* stop.stop());
  }),
);

liveAdapterTest("re-applies plan autonomy before every turn after Droid leaves spec mode", () =>
  Effect.gen(function* () {
    const droid = yield* scriptedDroid(`
function onPrompt(message) {
  // Droid exits spec mode on its own once the user approves a plan.
  state.autonomy = "normal";
  publish();
  reply(message, { stopReason: "end_turn" });
}`);
    const adapter = yield* makeTestAdapter(droid.binaryPath);
    const threadId = ThreadId.make("droid-plan-reapplied");
    yield* adapter.startSession({ threadId, cwd: process.cwd(), runtimeMode: "full-access" });
    for (const input of ["plan one", "plan two"])
      yield* adapter.sendTurn({ threadId, input, attachments: [], interactionMode: "plan" });
    const log = yield* droid.readLog();
    const writesBeforePrompt = log
      .filter(
        (message) =>
          message.method === "session/prompt" ||
          (message.method === "session/set_config_option" &&
            message.params?.configId === "autonomy_level"),
      )
      .map((message) =>
        message.method === "session/prompt" ? "prompt" : String(message.params?.value),
      );
    assert.deepEqual(writesBeforePrompt, ["auto-high", "spec", "prompt", "spec", "prompt"]);
  }),
);

for (const [name, env] of [
  ["offers no autonomy selector", { AUTONOMY: "none" }],
  ["does not report the requested autonomy", { AUTONOMY_LOCKED: "1" }],
] as const) {
  liveAdapterTest(`fails the turn without prompting when Droid ${name}`, () =>
    Effect.gen(function* () {
      const droid = yield* scriptedDroid(
        `function onPrompt(message) { reply(message, { stopReason: "end_turn" }); }`,
        env,
      );
      const adapter = yield* makeTestAdapter(droid.binaryPath);
      const threadId = ThreadId.make(`droid-autonomy-fail-closed-${name.length}`);
      yield* adapter.startSession({
        threadId,
        cwd: process.cwd(),
        runtimeMode: "approval-required",
      });
      const sent = yield* adapter
        .sendTurn({ threadId, input: "plan", attachments: [], interactionMode: "plan" })
        .pipe(Effect.flip);
      assert.match(sent.message, /autonomy/i);
      assert.isFalse(
        (yield* droid.readLog()).some((message) => message.method === "session/prompt"),
      );
    }),
  );
}

liveAdapterTest("asks the user to approve a plan even in full access", () =>
  Effect.gen(function* () {
    const droid = yield* scriptedDroid(`
async function onPrompt(message) {
  const answer = await request("session/request_permission", {
    toolCall: { toolCallId: "call_exit", title: "Approve Spec", kind: "other", rawInput: { plan: "1. do it" } },
    options: [
      { optionId: "proceed_once", name: "Allow", kind: "allow_once" },
      { optionId: "proceed_auto_run_low", name: "Allow & auto-run (low risk)", kind: "allow_always" },
      { optionId: "cancel", name: "No, keep iterating on spec", kind: "reject_once" },
    ],
  });
  reply(message, { stopReason: "end_turn" });
}`);
    const adapter = yield* makeTestAdapter(droid.binaryPath);
    const { events, until } = yield* recordEvents(adapter);
    const threadId = ThreadId.make("droid-plan-approval");
    yield* adapter.startSession({ threadId, cwd: process.cwd(), runtimeMode: "full-access" });
    const turn = yield* adapter
      .sendTurn({ threadId, input: "plan", attachments: [], interactionMode: "plan" })
      .pipe(Effect.forkScoped);
    yield* until((all) => all.some((event) => event.type === "request.opened"));
    const opened = events.find((event) => event.type === "request.opened");
    yield* adapter.respondToRequest(
      threadId,
      ApprovalRequestId.make(String(opened?.requestId)),
      "decline",
    );
    yield* Fiber.join(turn);
    const answers = (yield* droid.readLog()).filter((message) => message.result?.outcome);
    assert.deepEqual(
      answers.map((message) => message.result?.outcome),
      [{ outcome: "selected", optionId: "cancel" }],
    );
  }),
);

for (const [name, script, expected] of [
  [
    "an agent error with the upstream text",
    `fail(message, { code: -32603, message: "Internal error: Agent error", data: "429 Too many requests, retry later" });`,
    "429 Too many requests, retry later",
  ],
  [
    "a refusal stop",
    `reply(message, { stopReason: "refusal" });`,
    "Droid ended the turn because its agent reported an error.",
  ],
] as const) {
  liveAdapterTest(`reports ${name} as a failed turn`, () =>
    Effect.gen(function* () {
      const droid = yield* scriptedDroid(`function onPrompt(message) { ${script} }`);
      const adapter = yield* makeTestAdapter(droid.binaryPath);
      const { events, until } = yield* recordEvents(adapter);
      const threadId = ThreadId.make(`droid-failed-turn-${name.length}`);
      yield* adapter.startSession({ threadId, cwd: process.cwd(), runtimeMode: "full-access" });
      yield* adapter.sendTurn({ threadId, input: "go", attachments: [] }).pipe(Effect.exit);
      yield* until((all) => terminals(all).length > 0);
      const [ended] = terminals(events);
      assert.equal(ended?.payload.state, "failed");
      assert.equal(ended?.payload.errorMessage, expected);
    }),
  );
}

liveAdapterTest("reports Factory rejecting the account as an authentication problem", () =>
  Effect.gen(function* () {
    const droid = yield* scriptedDroid(`
function onPrompt(message) {
  fail(message, { code: -32603, message: "Internal error: Agent error", data: "401 Invalid API key" });
}`);
    const rejected: Array<string> = [];
    const adapter = yield* makeTestAdapter(droid.binaryPath, {
      onAuthenticationRejected: (message) => Effect.sync(() => void rejected.push(message)),
    });
    const threadId = ThreadId.make("droid-auth-rejected");
    yield* adapter.startSession({ threadId, cwd: process.cwd(), runtimeMode: "full-access" });
    yield* adapter.sendTurn({ threadId, input: "native", attachments: [] }).pipe(Effect.exit);
    // A custom model's own key is not the Factory account.
    yield* adapter
      .sendTurn({
        threadId,
        input: "custom",
        attachments: [],
        modelSelection: {
          instanceId: ProviderInstanceId.make("droid"),
          model: "custom:scient-fixture",
        },
      })
      .pipe(Effect.exit);
    assert.deepEqual(rejected, ["401 Invalid API key"]);
  }),
);

liveAdapterTest("takes the instance's credentials out of what Droid's errors say", () =>
  Effect.gen(function* () {
    const key = "fk-live-0123456789abcdef";
    const token = "gateway-token-0123456789";
    const droid = yield* scriptedDroid(`
function onPrompt(message) {
  // Droid prints the error as its own text before it fails the prompt.
  if (state.prompts === 1) {
    update({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "The key ${key} was refused." } });
    update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Error: 401 Invalid API key Bearer ${key}" } });
    return fail(message, { code: -32603, message: "Internal error: Agent error", data: "401 Invalid API key ${key} (proxy ${token})" });
  }
  process.stderr.write("fatal: could not refresh ${key}\\n");
  setTimeout(() => process.exit(3), 50);
}`);
    const rejected: Array<string> = [];
    const adapter = yield* makeTestAdapter(droid.binaryPath, {
      environment: { ...process.env, FACTORY_API_KEY: key },
      sensitiveEnvironmentValues: [token],
      onAuthenticationRejected: (message) => Effect.sync(() => void rejected.push(message)),
    });
    const { events, until } = yield* recordEvents(adapter);
    const threadId = ThreadId.make("droid-error-credentials");
    yield* adapter.startSession({ threadId, cwd: process.cwd(), runtimeMode: "full-access" });
    yield* adapter.sendTurn({ threadId, input: "one", attachments: [] }).pipe(Effect.exit);
    yield* adapter.sendTurn({ threadId, input: "two", attachments: [] }).pipe(Effect.exit);
    yield* until((all) => all.some((event) => event.type === "session.exited"));
    const written = events.flatMap((event) =>
      event.type === "content.delta" ? [event.payload.delta] : [],
    );
    // Droid's own words, with the key taken out of each piece of them.
    assert.deepEqual(written, [
      "The key [redacted] was refused.",
      "Error: 401 Invalid API key Bearer [redacted]",
    ]);
    const shown = [
      ...written,
      ...terminals(events).map((event) => event.payload.errorMessage ?? ""),
      ...sessionExits(events).map((exit) => ("reason" in exit ? String(exit.reason) : "")),
      ...rejected,
    ];
    // What the turn, the session's end and the provider status are told.
    assert.equal(shown[2], "401 Invalid API key [redacted] (proxy [redacted])");
    assert.include(shown[3], "could not refresh [redacted]");
    assert.deepEqual(rejected, ["401 Invalid API key [redacted] (proxy [redacted])"]);
    for (const text of shown) {
      assert.notInclude(text, key);
      assert.notInclude(text, token);
    }
  }),
);

liveAdapterTest("streams Droid's thinking as reasoning", () =>
  Effect.gen(function* () {
    const droid = yield* scriptedDroid(`
function onPrompt(message) {
  update({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "considering" } });
  update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "answer" } });
  reply(message, { stopReason: "end_turn" });
}`);
    const adapter = yield* makeTestAdapter(droid.binaryPath);
    const { events, until } = yield* recordEvents(adapter);
    const threadId = ThreadId.make("droid-reasoning");
    yield* adapter.startSession({ threadId, cwd: process.cwd(), runtimeMode: "full-access" });
    yield* adapter.sendTurn({ threadId, input: "think", attachments: [] });
    yield* until((all) => terminals(all).length > 0);
    const deltas = events.flatMap((event) =>
      event.type === "content.delta" ? [[event.payload.streamKind, event.payload.delta]] : [],
    );
    assert.deepEqual(deltas, [
      ["reasoning_text", "considering"],
      ["assistant_text", "answer"],
    ]);
  }),
);

/** What the work log is told about sub-agents and tool rows, in order. */
const subagentFlow = (events: ReadonlyArray<ProviderRuntimeEvent>) =>
  events.flatMap((event) => {
    switch (event.type) {
      case "task.started":
        return [
          `started ${event.payload.taskId}: ${event.payload.title} [${event.payload.role}] ${event.payload.taskType} tool=${event.payload.toolUseId}`,
        ];
      case "task.progress":
        return [
          `progress ${event.payload.taskId}: ${event.payload.status} | ${event.payload.summary}`,
        ];
      case "task.updated":
        return [
          `updated ${event.payload.taskId}: ${event.payload.status} | ${event.payload.error ?? event.payload.description}`,
        ];
      case "task.completed":
        return [
          `completed ${event.payload.taskId}: ${event.payload.status} | ${event.payload.summary}`,
        ];
      case "item.updated":
      case "item.completed":
        return event.payload.itemType === "assistant_message"
          ? []
          : [
              `row ${String(event.itemId)}: ${event.payload.itemType} ${event.payload.status} | ${event.payload.title} | ${event.payload.detail}`,
            ];
      default:
        return [];
    }
  });
const STEPS_NOTE = "Droid reports a sub-agent's steps only when it finishes.";

// Two foreground Tasks as in the owner's thread on Droid 0.231.0, with a follow-up sent
// while one still runs: it waits for the sub-agent instead of cancelling it.
liveAdapterTest(
  "shows each Droid Task as one sub-agent that says what it is and how it ended",
  () =>
    Effect.gen(function* () {
      const droid = yield* scriptedDroid(`
const task = (toolCallId, description) => update({ sessionUpdate: "tool_call", toolCallId, title: "Task", kind: "other",
  status: "pending", rawInput: { subagent_type: "explorer", description, prompt: "Audit it.", await: true } });
const result = (toolCallId, status, text) => update({ sessionUpdate: "tool_call_update", toolCallId, status,
  content: [{ type: "content", content: { type: "text", text } }], rawOutput: { text } });
const pending = [];
function onPrompt(message) {
  if (state.prompts === 1) {
    task("task-code", "Audit scient-desktop code smells");
    task("task-ci", "Audit build, CI, and release pipeline");
    result("task-ci", "completed", "The pipeline is sound.");
    setTimeout(() => result("task-code", "completed", "Three smells."), 500);
    return void pending.push(message);
  }
  task("task-again", "Audit scient-desktop code smells");
  result("task-again", "failed", "Error: The sub-agent ran out of context.");
  reply(message, { stopReason: "end_turn" });
}
onCancel = () => { for (const message of pending.splice(0)) reply(message, { stopReason: "cancelled" }); };`);
      const adapter = yield* makeTestAdapter(droid.binaryPath);
      const { events, until } = yield* recordEvents(adapter);
      const threadId = ThreadId.make("droid-task-rows");
      yield* adapter.startSession({ threadId, cwd: process.cwd(), runtimeMode: "full-access" });
      yield* adapter
        .sendTurn({ threadId, input: "audit", attachments: [] })
        .pipe(Effect.ignore, Effect.forkScoped);
      yield* until((all) => all.some((event) => event.type === "task.completed"));
      yield* adapter.sendTurn({ threadId, input: "whats going on?", attachments: [] });
      yield* until((all) => terminals(all).length === 1);
      assert.deepEqual(subagentFlow(events), [
        "started task-code: Audit scient-desktop code smells [explorer] subagent tool=task-code",
        `progress task-code: running | ${STEPS_NOTE}`,
        "started task-ci: Audit build, CI, and release pipeline [explorer] subagent tool=task-ci",
        `progress task-ci: running | ${STEPS_NOTE}`,
        "completed task-ci: completed | The pipeline is sound.",
        // The follow-up waited for the sub-agent still running.
        "completed task-code: completed | Three smells.",
        "started task-again: Audit scient-desktop code smells [explorer] subagent tool=task-again",
        `progress task-again: running | ${STEPS_NOTE}`,
        "completed task-again: failed | The sub-agent ran out of context.",
      ]);
    }),
);

// A background Task returns at once; the main agent then reads it with TaskOutput.
liveAdapterTest(
  "follows a background Droid sub-agent through TaskOutput and says what is waited for",
  () =>
    Effect.gen(function* () {
      const droid = yield* scriptedDroid(`
const call = (toolCallId, title, rawInput) => update({ sessionUpdate: "tool_call", toolCallId, title, kind: "other", status: "pending", rawInput });
const result = (toolCallId, text) => update({ sessionUpdate: "tool_call_update", toolCallId, status: "completed",
  content: [{ type: "content", content: { type: "text", text } }], rawOutput: { text } });
const report = (status, rest) => "Task ID: t-1\\nSubagent Type: Explorer\\nDescription: Review OMP host integration\\nStatus: " + status + "\\nDuration: 85.1s\\n\\n" + rest;
function onPrompt(message) {
  if (state.prompts === 2) return reply(message, { stopReason: "end_turn" });
  call("task-omp", "Task", { subagent_type: "explorer", description: "Review OMP host integration", complexity: "heavy", prompt: "Review it." });
  result("task-omp", "Task launched in background.\\ntask_id: t-1\\nsession_id: t-1\\nsubagent_type: explorer\\ndescription: Review OMP host integration\\nThe task is running in a subagent session.");
  call("peek", "TaskOutput", { task_id: "t-1", block: false });
  result("peek", report("running", "Latest progress: reading the adapter"));
  call("wait", "TaskOutput", { task_id: "t-1", block: true, timeout: 600000 });
  result("wait", report("completed", "The host integration is sound."));
  call("task-tests", "Task", { subagent_type: "explorer", description: "Audit OMP tests", prompt: "Audit them." });
  result("task-tests", "Task launched in background.\\ntask_id: t-2\\nsession_id: t-2");
  call("other", "TaskOutput", { task_id: "t-unknown", block: true });
  reply(message, { stopReason: "end_turn" });
}`);
      const adapter = yield* makeTestAdapter(droid.binaryPath);
      const { events, until } = yield* recordEvents(adapter);
      const threadId = ThreadId.make("droid-background-task");
      yield* adapter.startSession({ threadId, cwd: process.cwd(), runtimeMode: "full-access" });
      yield* adapter.sendTurn({ threadId, input: "review", attachments: [] });
      yield* until((all) => terminals(all).length === 1);
      assert.deepEqual(subagentFlow(events), [
        "started task-omp: Review OMP host integration [explorer] subagent tool=task-omp",
        `progress task-omp: running | ${STEPS_NOTE}`,
        "progress task-omp: running | Running in the background. Droid reports on it only when it finishes or the main agent checks.",
        "row peek: collab_agent_tool_call inProgress | Checking sub-agent · Review OMP host integration | undefined",
        "progress task-omp: running | reading the adapter",
        "row peek: collab_agent_tool_call completed | Checked sub-agent · Review OMP host integration | undefined",
        "row wait: collab_agent_tool_call inProgress | Waiting for sub-agent · Review OMP host integration (up to 10 min) | undefined",
        "completed task-omp: completed | The host integration is sound.",
        "row wait: collab_agent_tool_call completed | Waited for sub-agent · Review OMP host integration | undefined",
        "started task-tests: Audit OMP tests [explorer] subagent tool=task-tests",
        `progress task-tests: running | ${STEPS_NOTE}`,
        "progress task-tests: running | Running in the background. Droid reports on it only when it finishes or the main agent checks.",
        "row other: collab_agent_tool_call inProgress | Waiting for a sub-agent | undefined",
        // The turn ended with one sub-agent unreported: it is not left reading as working.
        "updated task-tests: idle | The turn ended. Droid has not reported this sub-agent's result.",
      ]);
    }),
);

// The idle watchdog on the test clock: Droid is silent while a sub-agent works or
// while it waits for one, and a healthy turn must not be failed for that.
const realPause = (millis: number) => TestClock.withLive(Effect.sleep(millis));
for (const scenario of [
  {
    name: "one sub-agent that works for longer than the ordinary idle window",
    announce: `update({ sessionUpdate: "tool_call", toolCallId: "task-1", title: "Task", kind: "other", status: "pending",
      rawInput: { subagent_type: "explorer", description: "Audit", prompt: "Audit it.", await: true } });`,
    // Within the sub-agent allowance (60 min), then past it.
    quietFor: "11 minutes",
    thenFailsAfter: "50 minutes",
    failure: "Droid turn exceeded the idle timeout (60m) while executing 1 subagent task(s).",
  },
  {
    name: "a wait Droid announced as up to ten minutes",
    announce: `update({ sessionUpdate: "tool_call", toolCallId: "wait-1", title: "TaskOutput", kind: "other", status: "pending",
      rawInput: { task_id: "launched-earlier", block: true, timeout: 600000 } });`,
    // Droid's own limit is exactly the ordinary window: allow it, and a minute for its answer.
    quietFor: "630 seconds",
    thenFailsAfter: "1 minute",
    failure: "Droid turn exceeded the idle timeout (11m) while waiting for a sub-agent.",
  },
  {
    name: "nothing pending: a silent turn",
    announce: `update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "On it." } });`,
    quietFor: "570 seconds",
    thenFailsAfter: "1 minute",
    failure: "Droid turn exceeded the idle timeout (10m).",
  },
] as const)
  it.effect(`gives the idle watchdog the right window for ${scenario.name}`, () =>
    Effect.gen(function* () {
      const droid = yield* scriptedDroid(`function onPrompt() { ${scenario.announce} }`);
      const adapter = yield* makeTestAdapter(droid.binaryPath);
      const events: Array<ProviderRuntimeEvent> = [];
      yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.sync(() => void events.push(event)),
      ).pipe(Effect.forkScoped);
      const threadId = ThreadId.make("droid-watchdog-window");
      yield* adapter.startSession({ threadId, cwd: process.cwd(), runtimeMode: "full-access" });
      yield* adapter
        .sendTurn({ threadId, input: "go", attachments: [] })
        .pipe(Effect.ignore, Effect.forkScoped);
      const announced = (event: ProviderRuntimeEvent) =>
        event.type === "task.started" ||
        event.type === "item.updated" ||
        event.type === "content.delta";
      while (!events.some(announced)) yield* realPause(10);
      yield* realPause(50);

      yield* TestClock.adjust(scenario.quietFor);
      yield* realPause(300);
      assert.deepEqual(terminals(events), [], "failed a healthy turn");
      assert.isTrue(yield* adapter.hasSession(threadId));

      yield* TestClock.adjust(scenario.thenFailsAfter);
      while (terminals(events).length === 0) yield* realPause(10);
      assert.deepEqual(
        terminals(events).map((event) => event.payload),
        [{ state: "failed", errorMessage: scenario.failure }],
      );
    }).pipe(Effect.scoped, Effect.provide(droidAdapterTestLayer)),
  );

liveAdapterTest("starts a new assistant message for text that follows a thought", () =>
  Effect.gen(function* () {
    // Droid 0.231.0, after a follow-up: closing words, a thought, then the answer to the follow-up.
    const droid = yield* scriptedDroid(`
const text = (value) => update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: value } });
const thought = (value) => update({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: value } });
function onPrompt(message) {
  text("I'll go straight to verification.");
  thought("The user asks what is going on.");
  text("I was running two parallel deep-dive audits.");
  thought("Now the second audit.");
  reply(message, { stopReason: "end_turn" });
}`);
    const adapter = yield* makeTestAdapter(droid.binaryPath);
    const { events, until } = yield* recordEvents(adapter);
    const threadId = ThreadId.make("droid-text-thought-text");
    yield* adapter.startSession({ threadId, cwd: process.cwd(), runtimeMode: "full-access" });
    yield* adapter.sendTurn({ threadId, input: "what is going on?", attachments: [] });
    yield* until((all) => terminals(all).length > 0);
    // Each assistant message is its own item, closed before the thought that follows it.
    const items = new Map<string, string>();
    const flow = events.flatMap((event) => {
      if (event.type === "content.delta") {
        if (event.payload.streamKind === "reasoning_text")
          return [`thought: ${event.payload.delta}`];
        const item = String(event.itemId);
        if (!items.has(item)) items.set(item, `message ${items.size + 1}`);
        return [`${items.get(item)}: ${event.payload.delta}`];
      }
      if (event.type === "item.completed" && event.payload.itemType === "assistant_message")
        return [`${items.get(String(event.itemId))} ends`];
      return [];
    });
    assert.deepEqual(flow, [
      "message 1: I'll go straight to verification.",
      "message 1 ends",
      "thought: The user asks what is going on.",
      "message 2: I was running two parallel deep-dive audits.",
      "message 2 ends",
      "thought: Now the second audit.",
    ]);
  }),
);

liveAdapterTest(
  "reports a loaded custom model's context window and leaves native models unknown",
  () =>
    Effect.gen(function* () {
      const droid = yield* scriptedDroid(
        `function onPrompt(message) { reply(message, { stopReason: "end_turn" }); }`,
      );
      const adapter = yield* makeTestAdapter(droid.binaryPath, {
        makeAcpRuntime: (input) =>
          makeDroidAcpRuntime(input).pipe(
            Effect.map((runtime) => ({
              ...runtime,
              getContextWindow: (model: string) =>
                model === "custom:scient-fixture" ? 128_000 : undefined,
            })),
          ),
      });
      const threadId = ThreadId.make("droid-context-window");
      const instanceId = ProviderInstanceId.make("droid");
      assert.isUndefined(
        yield* adapter.getModelContextWindow!({
          threadId,
          modelSelection: { instanceId, model: "custom:scient-fixture" },
        }),
      );
      yield* adapter.startSession({ threadId, cwd: process.cwd(), runtimeMode: "full-access" });
      assert.equal(
        yield* adapter.getModelContextWindow!({
          threadId,
          modelSelection: { instanceId, model: "custom:scient-fixture" },
        }),
        128_000,
      );
      assert.isUndefined(
        yield* adapter.getModelContextWindow!({
          threadId,
          modelSelection: { instanceId, model: "droid-native" },
        }),
      );
    }),
);

liveAdapterTest("keeps no image data in the thread snapshot after sending it", () =>
  Effect.gen(function* () {
    const droid = yield* scriptedDroid(
      `function onPrompt(message) { reply(message, { stopReason: "end_turn" }); }`,
    );
    const config = yield* ServerConfig;
    const attachment = {
      type: "image" as const,
      id: "droid-image-1234",
      name: "image.png",
      mimeType: "image/png",
      sizeBytes: 4,
    };
    yield* Effect.promise(async () => {
      await NodeFSP.mkdir(config.attachmentsDir, { recursive: true });
      await NodeFSP.writeFile(NodePath.join(config.attachmentsDir, `${attachment.id}.png`), "PNG!");
    });
    const adapter = yield* makeTestAdapter(droid.binaryPath);
    const threadId = ThreadId.make("droid-image-memory");
    yield* adapter.startSession({ threadId, cwd: process.cwd(), runtimeMode: "full-access" });
    yield* adapter.sendTurn({ threadId, input: "look", attachments: [attachment] });
    const sent = (yield* droid.readLog()).find((message) => message.method === "session/prompt");
    assert.include(yield* encodeUnknownJson(sent), Buffer.from("PNG!").toString("base64"));
    const snapshot = yield* encodeUnknownJson((yield* adapter.readThread(threadId)).turns);
    assert.notInclude(snapshot, Buffer.from("PNG!").toString("base64"));
    assert.include(snapshot, "image/png");
  }),
);

// A send that never reached Droid must not look delivered: forked-thread
// context is only settled as delivered when the send succeeds.
liveAdapterTest("ends a send stopped before its prompt reached Droid as not delivered", () =>
  Effect.gen(function* () {
    const droid = yield* scriptedDroid(hangingPrompt);
    const gate = yield* Deferred.make<void>();
    const entered = yield* Deferred.make<void>();
    const adapter = yield* makeTestAdapter(droid.binaryPath, {
      makeAcpRuntime: (input) =>
        makeDroidAcpRuntime(input).pipe(
          Effect.map((runtime) => ({
            ...runtime,
            setModel: (model: string) =>
              model === "droid-other"
                ? Deferred.succeed(entered, undefined).pipe(
                    Effect.andThen(Deferred.await(gate)),
                    Effect.andThen(runtime.setModel(model)),
                  )
                : runtime.setModel(model),
          })),
        ),
    });
    const { events, until } = yield* recordEvents(adapter);
    const threadId = ThreadId.make("droid-stop-before-prompt");
    yield* adapter.startSession({ threadId, cwd: process.cwd(), runtimeMode: "full-access" });
    const send = yield* adapter
      .sendTurn({
        threadId,
        input: "first message of a fork",
        attachments: [],
        modelSelection: { instanceId: ProviderInstanceId.make("droid"), model: "droid-other" },
      })
      .pipe(Effect.exit, Effect.forkScoped);
    yield* Deferred.await(entered);
    const stop = yield* adapter.interruptTurn(threadId).pipe(Effect.forkScoped);
    yield* Effect.sleep("50 millis");
    yield* Deferred.succeed(gate, undefined);
    yield* Fiber.join(stop);
    const sent = yield* Fiber.join(send);
    assert.isTrue(Exit.isFailure(sent) && Cause.hasInterruptsOnly(sent.cause));
    assert.isFalse((yield* droid.readLog()).some((message) => message.method === "session/prompt"));
    yield* until((all) => all.some((event) => event.type === "session.exited"));
    // A turn Droid never received is not a turn: nothing says it started.
    assert.deepEqual(turnEvents(events), []);
  }),
);

liveAdapterTest("ends a send stopped before its prompt was written as not delivered", () =>
  Effect.gen(function* () {
    const droid = yield* scriptedDroid(hangingPrompt);
    // The prompt request is registered, but its log flush has not returned: nothing is written.
    const logging = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const adapter = yield* makeTestAdapter(droid.binaryPath, {
      makeAcpRuntime: (input) =>
        makeDroidAcpRuntime({
          ...input,
          requestLogger: (event) =>
            event.method === "session/prompt" && event.status === "started"
              ? Deferred.succeed(logging, undefined).pipe(Effect.andThen(Deferred.await(release)))
              : Effect.void,
        }),
    });
    const { events } = yield* recordEvents(adapter);
    const threadId = ThreadId.make("droid-stop-before-write");
    yield* adapter.startSession({ threadId, cwd: process.cwd(), runtimeMode: "full-access" });
    const send = yield* adapter
      .sendTurn({ threadId, input: "first message of a fork", attachments: [] })
      .pipe(Effect.exit, Effect.forkScoped);
    yield* Deferred.await(logging);
    yield* adapter.interruptTurn(threadId);
    const sent = yield* Fiber.join(send);
    assert.isFalse((yield* droid.readLog()).some((message) => message.method === "session/prompt"));
    assert.isTrue(Exit.isFailure(sent) && Cause.hasInterruptsOnly(sent.cause), String(sent));
    assert.deepEqual(turnEvents(events), []);
    // The user stopped it: nothing failed, so nothing is reported.
    assert.deepEqual(sessionExits(events), [{ exitKind: "graceful" }]);
  }),
);

liveAdapterTest("never writes a prompt that was not yet written when Stop arrived", () =>
  Effect.gen(function* () {
    const droid = yield* scriptedDroid(hangingPrompt);
    // The prompt is registered and its log flush is slow: it returns while Stop still
    // waits for Droid's answer to the cancel.
    const logging = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const adapter = yield* makeTestAdapter(droid.binaryPath, {
      makeAcpRuntime: (input) =>
        makeDroidAcpRuntime({
          ...input,
          requestLogger: (event) =>
            event.method === "session/prompt" && event.status === "started"
              ? Deferred.succeed(logging, undefined).pipe(Effect.andThen(Deferred.await(release)))
              : Effect.void,
        }),
    });
    const { events } = yield* recordEvents(adapter);
    const threadId = ThreadId.make("droid-stop-then-log-returns");
    yield* adapter.startSession({ threadId, cwd: process.cwd(), runtimeMode: "full-access" });
    const send = yield* adapter
      .sendTurn({ threadId, input: "must not be sent", attachments: [] })
      .pipe(Effect.exit, Effect.forkScoped);
    yield* Deferred.await(logging);
    const stop = yield* adapter.interruptTurn(threadId).pipe(Effect.forkScoped);
    yield* Effect.sleep("150 millis");
    yield* Deferred.succeed(release, undefined);
    yield* Fiber.join(stop);
    const sent = yield* Fiber.join(send);
    yield* Effect.sleep("150 millis");
    // Nothing follows the cancel (the process may be closed before it logs the cancel).
    assert.notInclude(yield* delivered(droid), "must not be sent");
    assert.isTrue(Exit.isFailure(sent) && Cause.hasInterruptsOnly(sent.cause), String(sent));
    assert.deepEqual(turnEvents(events), []);
  }),
);

liveAdapterTest(
  "says why a prompt that was never written ended when the idle watchdog ends it",
  () =>
    Effect.gen(function* () {
      yield* withIdleTimeout("300");
      const droid = yield* scriptedDroid(hangingPrompt);
      // The prompt request is registered, but its log flush never returns: nothing is written.
      const logging = yield* Deferred.make<void>();
      const adapter = yield* makeTestAdapter(droid.binaryPath, {
        makeAcpRuntime: (input) =>
          makeDroidAcpRuntime({
            ...input,
            requestLogger: (event) =>
              event.method === "session/prompt" && event.status === "started"
                ? Deferred.succeed(logging, undefined).pipe(Effect.andThen(Effect.never))
                : Effect.void,
          }),
      });
      const { events, until } = yield* recordEvents(adapter);
      const threadId = ThreadId.make("droid-idle-before-write");
      yield* adapter.startSession({ threadId, cwd: process.cwd(), runtimeMode: "full-access" });
      const send = yield* adapter
        .sendTurn({ threadId, input: "never written", attachments: [] })
        .pipe(Effect.exit, Effect.forkScoped);
      yield* Deferred.await(logging);
      yield* until((all) => all.some((event) => event.type === "session.exited"));
      const sent = yield* Fiber.join(send);
      assert.isFalse(
        (yield* droid.readLog()).some((message) => message.method === "session/prompt"),
      );
      assert.isTrue(Exit.isFailure(sent) && Cause.hasInterruptsOnly(sent.cause), String(sent));
      // No turn started, so the session's end is what says the message went nowhere, and why.
      assert.deepEqual(turnEvents(events), []);
      assert.deepEqual(sessionExits(events), [
        {
          exitKind: "error",
          reason: "Droid turn exceeded the idle timeout (300ms).",
          recoverable: true,
        },
      ]);
      assert.isFalse(yield* adapter.hasSession(threadId));
    }),
);

liveAdapterTest(
  "ends a send as not delivered when Droid fails before the prompt is registered",
  () =>
    Effect.gen(function* () {
      const droid = yield* scriptedDroid(hangingPrompt);
      const adapter = yield* makeTestAdapter(droid.binaryPath, {
        makeAcpRuntime: (input) =>
          makeDroidAcpRuntime(input).pipe(
            Effect.map((runtime) => ({
              ...runtime,
              prompt: () => Effect.fail(new EffectAcpErrors.AcpProcessExitedError({ code: 9 })),
            })),
          ),
      });
      const { events, until } = yield* recordEvents(adapter);
      const threadId = ThreadId.make("droid-dies-before-prompt");
      yield* adapter.startSession({ threadId, cwd: process.cwd(), runtimeMode: "full-access" });
      const sent = yield* adapter
        .sendTurn({ threadId, input: "go", attachments: [] })
        .pipe(Effect.exit);
      assert.isTrue(Exit.isFailure(sent) && Cause.hasInterruptsOnly(sent.cause));
      // No turn started; the session's end says why the message went nowhere.
      yield* until((all) => all.some((event) => event.type === "session.exited"));
      assert.deepEqual(turnEvents(events), []);
      const exited = events.find((event) => event.type === "session.exited");
      assert.deepInclude(exited?.type === "session.exited" ? exited.payload : {}, {
        exitKind: "error",
        recoverable: true,
      });
      assert.include(
        exited?.type === "session.exited" ? exited.payload.reason : "",
        "Droid stopped unexpectedly.",
      );
    }),
);

liveAdapterTest("keeps a follow-up in its turn's custom-model request budget", () =>
  Effect.gen(function* () {
    const droid = yield* scriptedDroid(`
const pending = [];
function onPrompt(message) {
  if (state.prompts === 1) return void pending.push(message);
  reply(message, { stopReason: "end_turn" });
}
onCancel = () => { for (const message of pending.splice(0)) reply(message, { stopReason: "end_turn" }); };
`);
    let budgets = 0;
    const adapter = yield* makeTestAdapter(droid.binaryPath, {
      makeAcpRuntime: (input) =>
        makeDroidAcpRuntime(input).pipe(
          Effect.map((runtime) => ({
            ...runtime,
            beginTurn: Effect.sync(() => {
              budgets++;
            }),
          })),
        ),
    });
    const { until } = yield* recordEvents(adapter);
    const threadId = ThreadId.make("droid-steer-budget");
    yield* adapter.startSession({ threadId, cwd: process.cwd(), runtimeMode: "full-access" });
    yield* adapter
      .sendTurn({ threadId, input: "first", attachments: [] })
      .pipe(Effect.ignore, Effect.forkScoped);
    yield* until((all) => all.some((event) => event.type === "turn.started"));
    yield* adapter.sendTurn({ threadId, input: "follow-up", attachments: [] });
    assert.equal(budgets, 1);
  }),
);

it.effect(
  "does not fail a new message for the silence before it",
  () =>
    Effect.gen(function* () {
      yield* withIdleTimeout("60000");
      const droid = yield* scriptedDroid(
        `function onPrompt(message) { reply(message, { stopReason: "end_turn" }); }`,
      );
      const gate = yield* Deferred.make<void>();
      const entered = yield* Deferred.make<void>();
      const adapter = yield* makeTestAdapter(droid.binaryPath, {
        makeAcpRuntime: (input) =>
          makeDroidAcpRuntime(input).pipe(
            Effect.map((runtime) => ({
              ...runtime,
              setModel: (model: string) =>
                model === "droid-other"
                  ? Deferred.succeed(entered, undefined).pipe(
                      Effect.andThen(Deferred.await(gate)),
                      Effect.andThen(runtime.setModel(model)),
                    )
                  : runtime.setModel(model),
            })),
          ),
      });
      const events: Array<ProviderRuntimeEvent> = [];
      yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.sync(() => void events.push(event)),
      ).pipe(Effect.forkScoped);
      // Fake time stands still; real time lets the child process answer.
      const settle = (predicate: () => boolean) =>
        Effect.gen(function* () {
          for (let attempt = 0; attempt < 1_000 && !predicate(); attempt++)
            yield* Effect.sleep("5 millis").pipe(TestClock.withLive);
        });
      const threadId = ThreadId.make("droid-watchdog-stale-deadline");
      yield* adapter.startSession({ threadId, cwd: process.cwd(), runtimeMode: "full-access" });
      yield* adapter.sendTurn({ threadId, input: "one", attachments: [] });
      // Two minutes of silence between messages.
      yield* TestClock.adjust("2 minutes");
      const second = yield* adapter
        .sendTurn({
          threadId,
          input: "two",
          attachments: [],
          modelSelection: { instanceId: ProviderInstanceId.make("droid"), model: "droid-other" },
        })
        .pipe(Effect.exit, Effect.forkScoped);
      yield* Deferred.await(entered);
      // A watchdog tick lands while the message is being prepared.
      yield* TestClock.adjust("20 seconds");
      yield* Effect.sleep("100 millis").pipe(TestClock.withLive);
      yield* Deferred.succeed(gate, undefined);
      yield* Fiber.join(second);
      yield* settle(() => terminals(events).length === 2);
      assert.deepEqual(
        terminals(events).map((event) => event.payload.state),
        ["completed", "completed"],
      );
    }).pipe(Effect.scoped, Effect.provide(droidAdapterTestLayer)),
  30_000,
);

liveAdapterTest("does not blame the Factory account for a custom model Droid selected itself", () =>
  Effect.gen(function* () {
    // The user's own Droid default is a BYOK model; Scient selected nothing.
    const droid = yield* scriptedDroid(
      `function onPrompt(message) {
        fail(message, { code: -32603, message: "Internal error: Agent error", data: "401 Incorrect API key" });
      }`,
      { MODEL: "custom:scient-fixture" },
    );
    const rejected: Array<string> = [];
    const adapter = yield* makeTestAdapter(droid.binaryPath, {
      onAuthenticationRejected: (message) => Effect.sync(() => void rejected.push(message)),
    });
    const threadId = ThreadId.make("droid-auth-own-byok-default");
    yield* adapter.startSession({ threadId, cwd: process.cwd(), runtimeMode: "full-access" });
    yield* adapter.sendTurn({ threadId, input: "go", attachments: [] }).pipe(Effect.exit);
    assert.deepEqual(rejected, []);
  }),
);

for (const [running, followUp, blamed] of [
  ["custom:scient-fixture", "droid-native", false],
  ["droid-native", "custom:scient-fixture", true],
] as const)
  liveAdapterTest(
    `attributes a 401 to the model its prompt ran with (${running}), not a follow-up's (${followUp})`,
    () =>
      Effect.gen(function* () {
        // The running prompt fails while the follow-up, holding the thread
        // lock, has already switched Droid to another model.
        const droid = yield* scriptedDroid(
          `const pending = [];
function onPrompt(message) {
  if (state.prompts === 1) return void pending.push(message);
  reply(message, { stopReason: "end_turn" });
}
onConfig = (message) => {
  if (message.params.configId !== "model" || message.params.value !== "${followUp}") return;
  for (const prompt of pending.splice(0))
    fail(prompt, { code: -32603, message: "Internal error: Agent error", data: "401 Unauthorized" });
};`,
          { MODEL: running },
        );
        const rejected: Array<string> = [];
        const adapter = yield* makeTestAdapter(droid.binaryPath, {
          onAuthenticationRejected: (message) => Effect.sync(() => void rejected.push(message)),
        });
        const { until } = yield* recordEvents(adapter);
        const threadId = ThreadId.make(`droid-auth-interleaved-${followUp}`);
        yield* adapter.startSession({ threadId, cwd: process.cwd(), runtimeMode: "full-access" });
        yield* adapter
          .sendTurn({ threadId, input: "first", attachments: [] })
          .pipe(Effect.ignore, Effect.forkScoped);
        yield* until((all) => all.some((event) => event.type === "turn.started"));
        yield* adapter.sendTurn({
          threadId,
          input: "follow-up",
          attachments: [],
          modelSelection: { instanceId: ProviderInstanceId.make("droid"), model: followUp },
        });
        yield* until((all) => terminals(all).length === 1);
        assert.deepEqual(rejected, blamed ? ["401 Unauthorized"] : []);
      }),
  );

liveAdapterTest("honours a Stop that arrives before its send has a turn", () =>
  Effect.gen(function* () {
    const droid = yield* scriptedDroid(
      `function onPrompt(message) { reply(message, { stopReason: "end_turn" }); }`,
    );
    const adapter = yield* makeTestAdapter(droid.binaryPath);
    const { events, until } = yield* recordEvents(adapter);
    const threadId = ThreadId.make("droid-stop-before-turn");
    yield* adapter.startSession({ threadId, cwd: process.cwd(), runtimeMode: "full-access" });
    // The thread is starting: the send is still on its way to the adapter.
    const stop = yield* adapter.captureTurnStop!(threadId);
    yield* stop.interrupt;
    assert.equal(yield* stop.confirm, "active");
    const sent = yield* adapter
      .sendTurn({ threadId, input: "go", attachments: [] })
      .pipe(Effect.exit);
    assert.isTrue(Exit.isFailure(sent) && Cause.hasInterruptsOnly(sent.cause));
    assert.isFalse((yield* droid.readLog()).some((message) => message.method === "session/prompt"));
    assert.equal(yield* stop.confirm, "ended");
    // A turn Droid never received is not a turn: nothing says it started.
    assert.deepEqual(turnEvents(events), []);
    // The Stop is used up: the next message runs.
    yield* adapter.sendTurn({ threadId, input: "again", attachments: [] });
    yield* until((all) => terminals(all).length === 1);
    assert.deepEqual(turnEvents(events), ["turn.started", "turn.completed:completed"]);
  }),
);

liveAdapterTest("ends a follow-up that raced Stop's teardown as interrupted", () =>
  Effect.gen(function* () {
    const droid = yield* scriptedDroid(hangingPrompt);
    // Hold Stop inside its teardown while the follow-up waits for the thread.
    const entered = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const adapter = yield* makeTestAdapter(droid.binaryPath, {
      makeAcpRuntime: (input) =>
        makeDroidAcpRuntime(input).pipe(
          Effect.map((runtime) => ({
            ...runtime,
            cancelAndAwaitPrompt: (timeout: Parameters<typeof runtime.cancelAndAwaitPrompt>[0]) =>
              Deferred.succeed(entered, undefined).pipe(
                Effect.andThen(Deferred.await(release)),
                Effect.andThen(runtime.cancelAndAwaitPrompt(timeout)),
              ),
          })),
        ),
    });
    const { until } = yield* recordEvents(adapter);
    const threadId = ThreadId.make("droid-follow-up-after-stop");
    yield* adapter.startSession({ threadId, cwd: process.cwd(), runtimeMode: "full-access" });
    yield* adapter
      .sendTurn({ threadId, input: "first", attachments: [] })
      .pipe(Effect.ignore, Effect.forkScoped);
    yield* until((all) => all.some((event) => event.type === "turn.started"));
    const stop = yield* adapter.interruptTurn(threadId).pipe(Effect.forkScoped);
    yield* Deferred.await(entered);
    const followUp = yield* adapter
      .sendTurn({ threadId, input: "follow-up", attachments: [] })
      .pipe(Effect.exit, Effect.forkScoped);
    yield* Effect.sleep("50 millis");
    yield* Deferred.succeed(release, undefined);
    yield* Fiber.join(stop);
    const sent = yield* Fiber.join(followUp);
    assert.isTrue(Exit.isFailure(sent) && Cause.hasInterruptsOnly(sent.cause), String(sent));
  }),
);

liveAdapterTest("leaves the session alone when Stop targets a turn that already ended", () =>
  Effect.gen(function* () {
    const droid = yield* scriptedDroid(
      `function onPrompt(message) { reply(message, { stopReason: "end_turn" }); }`,
    );
    const adapter = yield* makeTestAdapter(droid.binaryPath);
    const { events } = yield* recordEvents(adapter);
    const threadId = ThreadId.make("droid-stop-ended-turn");
    yield* adapter.startSession({ threadId, cwd: process.cwd(), runtimeMode: "full-access" });
    const { turnId } = yield* adapter.sendTurn({ threadId, input: "done", attachments: [] });
    yield* adapter.interruptTurn(threadId, turnId);
    assert.isTrue(yield* adapter.hasSession(threadId));
    assert.isFalse(events.some((event) => event.type === "session.exited"));
    assert.isFalse((yield* droid.readLog()).some((message) => message.method === "session/cancel"));
  }),
);

liveAdapterTest("keeps a captured Stop from touching the turn that started after its own", () =>
  Effect.gen(function* () {
    const droid = yield* scriptedDroid(`
const pending = [];
function onPrompt(message) {
  // The first turn finishes on its own; the next one keeps running.
  if (state.prompts === 1) return void setTimeout(() => reply(message, { stopReason: "end_turn" }), 300);
  pending.push(message);
}`);
    const adapter = yield* makeTestAdapter(droid.binaryPath);
    const { events, until } = yield* recordEvents(adapter);
    const threadId = ThreadId.make("droid-stop-captured-turn");
    yield* adapter.startSession({ threadId, cwd: process.cwd(), runtimeMode: "full-access" });
    yield* adapter
      .sendTurn({ threadId, input: "first", attachments: [] })
      .pipe(Effect.ignore, Effect.forkScoped);
    yield* until((all) => all.some((event) => event.type === "turn.started"));
    const stop = yield* adapter.captureTurnStop!(threadId);
    yield* until((all) => terminals(all).length === 1);
    yield* adapter
      .sendTurn({ threadId, input: "second", attachments: [] })
      .pipe(Effect.ignore, Effect.forkScoped);
    yield* until((all) => all.filter((event) => event.type === "turn.started").length === 2);
    // The captured turn ended; the running one is not this Stop's.
    assert.equal(yield* stop.confirm, "ended");
    assert.isFalse(yield* stop.stop());
    assert.isTrue(yield* adapter.hasSession(threadId));
    assert.lengthOf(terminals(events), 1);
    assert.isFalse((yield* droid.readLog()).some((message) => message.method === "session/cancel"));
  }),
);
