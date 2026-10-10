import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { ProviderInstanceId } from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";

import type * as Scope from "effect/Scope";

import { makeOmpRpcClient, type OmpRpcIo, type OmpRpcNotification } from "effect-omp-rpc/client";
import type { OmpRpcResponse } from "effect-omp-rpc/schema";

import { makeOmpTextGeneration } from "./OmpTextGeneration.ts";
import {
  makeOmpCaptureReplay,
  makeOmpScriptedWire,
} from "../provider/omp/OmpCaptureReplay.testFixtures.ts";
import { makeOmpRedaction, type OmpRpcProcess } from "../provider/omp/OmpRpcProcess.ts";
import { ompTarget } from "../provider/omp/OmpTarget.ts";

const toJson = Schema.encodeUnknownSync(Schema.fromJsonString(Schema.Unknown));

const response = (command: string, data: unknown = {}): OmpRpcResponse => ({
  id: "text-request",
  type: "response",
  command,
  success: true,
  data,
});

const makeClient = (events: ReadonlyArray<OmpRpcNotification>) =>
  ({
    version: "18.2.8",
    runtimeVersion: "18.2.8",
    ready: Effect.succeed({
      type: "ready" as const,
      protocolVersion: 1,
      supportedProtocolVersions: [1, 2],
      maxFrameBytes: 1_048_576,
      maxReassembledFrameBytes: 67_108_864,
    }),
    events: Stream.fromIterable(events),
    flushEvents: () => Effect.void,
    command: () => Effect.succeed(response("command")),
    prompt: () => Effect.succeed(response("prompt", { agentInvoked: true })),
    steer: () => Effect.succeed(response("steer")),
    followUp: () => Effect.succeed(response("follow_up")),
    abort: () => Effect.succeed(response("abort")),
    getState: () => Effect.succeed({ isStreaming: false, isCompacting: false }),
    getModels: () => Effect.succeed({ models: [] }),
    getCommands: () => Effect.succeed({ commands: [] }),
    setModel: () => Effect.succeed(response("set_model")),
    setThinkingLevel: () => Effect.succeed(response("set_thinking_level")),
    compact: () => Effect.succeed(response("compact")),
    switchSession: () => Effect.succeed({ cancelled: false }),
    setSubagentSubscription: () => Effect.succeed(response("set_subagent_subscription")),
    setEventFilter: (events) => Effect.succeed({ events: events === null ? null : [...events] }),
    limits: Effect.succeed({ maxFrameBytes: 1_048_576, maxReassembledFrameBytes: 67_108_864 }),
    setHostTools: () => Effect.succeed(response("set_host_tools")),
    setHostUriSchemes: () => Effect.succeed(response("set_host_uri_schemes")),
    extensionUiResponse: () => Effect.void,
    hostToolUpdate: () => Effect.void,
    hostToolResult: () => Effect.void,
    hostUriResult: () => Effect.void,
    close: () => Effect.void,
    shutdown: Effect.succeed({ code: 0, forced: false, stderrTail: "" }),
    redaction: makeOmpRedaction(undefined, []),
  }) satisfies OmpRpcProcess;

const settings = Schema.decodeSync(
  Schema.Struct({
    enabled: Schema.Boolean,
    binaryPath: Schema.String,
    customModels: Schema.Array(Schema.String),
    homePath: Schema.String,
    profile: Schema.String,
  }),
)({ enabled: true, binaryPath: "omp", customModels: [], homePath: "", profile: "" });

const modelSelection = createModelSelection(ProviderInstanceId.make("omp"), "anthropic/test-model");

describe("Oh My Pi text generation", () => {
  it.effect("reconciles a complete assistant message when deltas are absent", () =>
    Effect.gen(function* () {
      const service = yield* makeOmpTextGeneration(ompTarget, settings, {}, () =>
        Effect.succeed(
          makeClient([
            {
              _tag: "Event",
              event: {
                type: "message_end",
                message: {
                  role: "assistant",
                  content: '{"title":"Fallback title","needsRefinement":false}',
                },
              },
            },
            { _tag: "Event", event: { type: "agent_end", messages: [], isTerminal: true } },
          ]),
        ),
      );
      const result = yield* service.generateThreadTitle({
        cwd: process.cwd(),
        message: "Summarize this work",
        modelSelection,
      });
      expect(result.title).toBe("Fallback title");
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("keeps the model provider's error in the failure detail", () =>
    Effect.gen(function* () {
      for (const event of [
        {
          type: "notice",
          level: "error",
          message: "401 Unauthorized: invalid Anthropic API key",
        },
        {
          type: "auto_retry_end",
          success: false,
          finalError: "429 Too Many Requests: rate limit exceeded",
        },
      ]) {
        const service = yield* makeOmpTextGeneration(ompTarget, settings, {}, () =>
          Effect.succeed(
            makeClient([
              { _tag: "Event", event },
              { _tag: "Event", event: { type: "agent_end", messages: [], isTerminal: true } },
            ]),
          ),
        );
        const result = yield* service
          .generateThreadTitle({
            cwd: process.cwd(),
            message: "Summarize this work",
            modelSelection,
          })
          .pipe(Effect.flip);
        expect(result.message).toContain(
          event.type === "notice"
            ? "401 Unauthorized: invalid Anthropic API key"
            : "429 Too Many Requests: rate limit exceeded",
        );
        expect(result.message).not.toContain("without a model response");
        expect(result.message).not.toContain("returned empty output");
      }
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("settles a later local prompt_result instead of waiting for agent_end", () =>
    Effect.gen(function* () {
      const service = yield* makeOmpTextGeneration(ompTarget, settings, {}, () =>
        Effect.succeed(
          makeClient([{ _tag: "Event", event: { type: "prompt_result", agentInvoked: false } }]),
        ),
      );
      const result = yield* service
        .generateThreadTitle({
          cwd: process.cwd(),
          message: "This should be local only",
          modelSelection,
        })
        .pipe(Effect.flip);
      expect(result.message).toContain("without a model response");
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});

type Frame = Record<string, unknown>;

/** A text-generation process whose stdout is decoded by the real client. */
const wireProcess =
  (wire: Effect.Effect<{ readonly io: OmpRpcIo }>, secrets: ReadonlyArray<string> = []) =>
  (): Effect.Effect<OmpRpcProcess, never, Scope.Scope> =>
    Effect.gen(function* () {
      const { io } = yield* wire;
      const client = yield* makeOmpRpcClient(io);
      return {
        ...client,
        version: "18.3.1",
        runtimeVersion: "18.3.1",
        shutdown: Effect.succeed({ code: 0, forced: false, stderrTail: "" }),
        redaction: makeOmpRedaction(undefined, secrets),
      };
    });

/** Answers the prompt command, then writes the given turn frames. */
const scriptedTurn = (...frames: ReadonlyArray<Frame>) => scriptedTurnWith([], ...frames);

/** `scriptedTurn` from a process that also knows `secrets` (custom-model keys). */
const scriptedTurnWith = (secrets: ReadonlyArray<string>, ...frames: ReadonlyArray<Frame>) =>
  wireProcess(
    makeOmpScriptedWire(
      () => undefined,
      (command) => (command.type === "prompt" ? frames : []),
    ),
    secrets,
  );

const delta = (text: string) => ({
  type: "message_update",
  message: { role: "assistant", content: [] },
  assistantMessageEvent: { type: "text_delta", delta: text },
});

const assistantEnd = (message: Frame) => ({
  type: "message_end",
  message: { role: "assistant", content: [], ...message },
});

const agentEnd = { type: "agent_end", messages: [], isTerminal: true };

const generateTitle = (makeProcess: () => Effect.Effect<OmpRpcProcess, never, Scope.Scope>) =>
  makeOmpTextGeneration(ompTarget, settings, {}, makeProcess).pipe(
    Effect.flatMap((service) =>
      service.generateThreadTitle({ cwd: process.cwd(), message: "review", modelSelection }),
    ),
  );

describe("Oh My Pi text generation over the wire", () => {
  it.effect("review: a model error must reject even parseable partial output", () =>
    Effect.gen(function* () {
      const result = yield* generateTitle(
        scriptedTurn(
          { type: "agent_start" },
          delta('{"title":"Partial output"}'),
          assistantEnd({
            stopReason: "error",
            errorMessage: "401 provider failed",
            content: [{ type: "text", text: '{"title":"Partial output"}' }],
          }),
          agentEnd,
        ),
      ).pipe(Effect.flip);
      expect(result.message).toContain("401 provider failed");
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("review: preserve error assistant message details", () =>
    Effect.gen(function* () {
      const result = yield* generateTitle(
        scriptedTurn(
          { type: "agent_start" },
          assistantEnd({ stopReason: "error", errorMessage: "401 invalid API key" }),
          agentEnd,
        ),
      ).pipe(Effect.flip);
      expect(result.message).toContain("401 invalid API key");
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("keeps a custom-model key the provider echoed out of the failure detail", () =>
    Effect.gen(function* () {
      const key = "customlivekey-0123456789abcdef";
      for (const frames of [
        [assistantEnd({ stopReason: "error", errorMessage: `401 Incorrect API key: ${key}` })],
        [{ type: "auto_retry_end", success: false, finalError: `401 Incorrect API key: ${key}` }],
        [{ type: "extension_error", error: `401 Incorrect API key: ${key}` }],
      ]) {
        const result = yield* generateTitle(
          scriptedTurnWith([key], { type: "agent_start" }, ...frames, agentEnd),
        ).pipe(Effect.flip);
        expect(result.message).toContain("401 Incorrect API key: [REDACTED]");
        expect(toJson(result)).not.toContain(key);
      }
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("an error notice followed by a successful answer still succeeds", () =>
    Effect.gen(function* () {
      const result = yield* generateTitle(
        scriptedTurn(
          { type: "notice", level: "error", message: "A widget failed to refresh." },
          { type: "agent_start" },
          delta('{"title":"Fine title"}'),
          assistantEnd({ stopReason: "stop" }),
          agentEnd,
        ),
      );
      expect(result.title).toBe("Fine title");
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("a session retry discards the failed attempt's output", () =>
    Effect.gen(function* () {
      const result = yield* generateTitle(
        scriptedTurn(
          { type: "agent_start" },
          delta('{"title":"Stale title"}'),
          assistantEnd({ stopReason: "error", errorMessage: "socket closed" }),
          { type: "auto_retry_start", attempt: 1, maxAttempts: 2, delayMs: 100 },
          { type: "agent_start" },
          delta('{"title":"Fresh title"}'),
          assistantEnd({ stopReason: "stop" }),
          agentEnd,
        ),
      );
      expect(result.title).toBe("Fresh title");
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("a failed prompt_result fails with its error", () =>
    Effect.gen(function* () {
      const result = yield* generateTitle(
        scriptedTurn({
          type: "prompt_result",
          agentInvoked: true,
          status: "error",
          error: { message: "quota exceeded", retryable: false },
        }),
      ).pipe(Effect.flip);
      expect(result.message).toContain("quota exceeded");
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect.each(
    (
      [
        ["auth-401", "401 Incorrect API key provided"],
        ["retry-exhausted", "429 Rate limit reached"],
        ["stream-error-after-partial", "The socket connection was closed unexpectedly"],
      ] as const
    ).map(([name, detail]) => ({
      caseTitle: `recorded ${name} fails with the provider's error`,
      name,
      detail,
    })),
  )("$caseTitle", ({ name, detail }) =>
    Effect.gen(function* () {
      const result = yield* generateTitle(
        wireProcess(makeOmpCaptureReplay(name).pipe(Effect.map(({ io }) => ({ io })))),
      ).pipe(Effect.flip);
      expect(result.message).toContain(detail);
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
