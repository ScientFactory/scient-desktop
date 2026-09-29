import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { OmpSettings } from "@t3tools/contracts";

import { makeOmpRpcClient } from "effect-omp-rpc/client";
import {
  OmpRpcCommandError,
  OmpRpcFrameTooLargeError,
  type OmpRpcError,
} from "effect-omp-rpc/errors";
import type { OmpRpcResponse } from "effect-omp-rpc/schema";

import { makeOmpScriptedWire } from "../omp/OmpCaptureReplay.testFixtures.ts";
import { makeOmpRedaction, type OmpRpcProcess } from "../omp/OmpRpcProcess.ts";
import { checkOmpProviderStatus } from "./OmpProvider.ts";

const response = (command: string, data: unknown = {}): OmpRpcResponse => ({
  id: "status-request",
  type: "response",
  command,
  success: true,
  data,
});

const settings = Schema.decodeSync(OmpSettings)({
  enabled: true,
  binaryPath: "omp",
  homePath: "",
  profile: "",
});

const process = (overrides: Partial<OmpRpcProcess> = {}): OmpRpcProcess => ({
  version: "18.2.8",
  ready: Effect.succeed({
    type: "ready" as const,
    protocolVersion: 1,
    supportedProtocolVersions: [1, 2],
    maxFrameBytes: 1_048_576,
    maxReassembledFrameBytes: 67_108_864,
  }),
  events: Stream.empty,
  flushEvents: () => Effect.void,
  command: () => Effect.succeed(response("command")),
  prompt: () => Effect.succeed(response("prompt", { agentInvoked: true })),
  steer: () => Effect.succeed(response("steer")),
  followUp: () => Effect.succeed(response("follow_up")),
  abort: () => Effect.succeed(response("abort")),
  getState: () => Effect.succeed({ isStreaming: false, isCompacting: false }),
  getModels: () =>
    Effect.succeed({
      models: [
        {
          provider: "anthropic",
          id: "claude-test",
          name: "Claude Test",
          reasoning: true,
          thinkingLevels: ["high"],
          input: ["text", "image"],
        },
      ],
    }),
  getCommands: () =>
    Effect.succeed({
      commands: [
        { name: "help", description: "Help", source: "builtin" },
        { name: "compact", description: "Compact", source: "builtin" },
        { name: "new", description: "New", source: "builtin" },
        { name: "export", description: "Export", source: "builtin" },
      ],
    }),
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
  ...overrides,
});

describe("Oh My Pi provider status", () => {
  it.effect("does not probe a disabled provider", () =>
    Effect.gen(function* () {
      let probes = 0;
      const result = yield* checkOmpProviderStatus({ ...settings, enabled: false }, {}, () =>
        Effect.sync(() => {
          probes += 1;
          return process();
        }),
      );
      expect(probes).toBe(0);
      expect(result.status).toBe("disabled");
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("reports models while hiding mutating and unsupported commands", () =>
    Effect.gen(function* () {
      const result = yield* checkOmpProviderStatus(settings, {}, () => Effect.succeed(process()));
      expect(result.status).toBe("ready");
      expect(result.auth).toEqual({ status: "unknown", required: false });
      expect(result.message).toBeUndefined();
      expect(result.models.map((model) => model.slug)).toEqual(["anthropic/claude-test"]);
      expect(result.slashCommands?.map((command) => command.name)).toEqual(["help", "compact"]);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  for (const contextWindow of [null, "invalid"] as const) {
    it.effect(
      `handles native context capacity ${String(contextWindow)} through the real RPC client`,
      () =>
        Effect.gen(function* () {
          const result = yield* checkOmpProviderStatus(settings, {}, () =>
            Effect.gen(function* () {
              const wire = yield* makeOmpScriptedWire((command) =>
                command.type === "get_available_models"
                  ? {
                      type: "response",
                      id: command.id,
                      command: command.type,
                      success: true,
                      data: {
                        models: [
                          {
                            provider: "native",
                            id: "unknown",
                            contextWindow,
                            input: ["text", "image"],
                          },
                          {
                            provider: "native",
                            id: "known",
                            contextWindow: 128000,
                            input: ["text"],
                          },
                        ],
                      },
                    }
                  : undefined,
              );
              const client = yield* makeOmpRpcClient(wire.io);
              return {
                ...client,
                version: "18.2.8",
                shutdown: Effect.succeed({ code: 0, forced: false, stderrTail: "" }),
                redaction: makeOmpRedaction(undefined, []),
              };
            }),
          );
          if (contextWindow === null) {
            expect(result.status).toBe("ready");
            expect(result.message).toBeUndefined();
            expect(result.models.map((model) => model.slug)).toEqual([
              "native/unknown",
              "native/known",
            ]);
          } else {
            expect(result.status).toBe("error");
            expect(result.message).toContain("Refresh the provider in Settings");
            expect(result.message).not.toContain("RPC");
          }
        }).pipe(Effect.provide(NodeServices.layer)),
    );
  }

  it.effect("labels custom-model providers with their connection name", () =>
    Effect.gen(function* () {
      const result = yield* checkOmpProviderStatus(settings, {}, () =>
        Effect.succeed(
          process({
            getModels: () =>
              Effect.succeed({
                models: [
                  { provider: "anthropic", id: "claude-test", name: "Claude Test" },
                  { provider: "scient_openrouter", id: "glm", name: "GLM" },
                ],
              }),
            modelProviderLabel: (provider) =>
              provider === "scient_openrouter" ? "OpenRouter" : undefined,
          }),
        ),
      );
      expect(result.models.map((model) => [model.slug, model.subProvider] as const)).toEqual([
        ["anthropic/claude-test", "anthropic"],
        ["scient_openrouter/glm", "OpenRouter"],
      ]);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("preserves custom-model readiness reported by the process wrapper", () =>
    Effect.gen(function* () {
      const result = yield* checkOmpProviderStatus(settings, {}, () =>
        Effect.succeed(
          process({
            assessModelConnections: () => [
              {
                connectionId: "fixture",
                modelId: "model",
                configurationKey: "fixture-key",
                state: "available",
                contextWindow: 128000,
                maxOutputTokens: 4096,
                source: "manual",
              },
            ],
          }),
        ),
      );
      expect(result.modelConnections).toEqual([
        {
          connectionId: "fixture",
          modelId: "model",
          configurationKey: "fixture-key",
          state: "available",
          contextWindow: 128000,
          maxOutputTokens: 4096,
          source: "manual",
        },
      ]);
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});

describe("Oh My Pi provider discovery errors", () => {
  const failingModels = (error: OmpRpcError) => () =>
    Effect.succeed(process({ getModels: () => Effect.fail(error) }));

  it.effect("names a command that timed out", () =>
    Effect.gen(function* () {
      const result = yield* checkOmpProviderStatus(
        settings,
        {},
        failingModels(
          new OmpRpcCommandError({
            command: "get_available_models",
            requestId: "2",
            code: "timeout",
            detail: "RPC command get_available_models timed out after 30000 ms.",
          }),
        ),
      );
      expect(result.message).toBe("Oh My Pi did not answer get_available_models in time.");
      expect(result.installed).toBe(true);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("names an outbound frame over the agent's limit", () =>
    Effect.gen(function* () {
      const result = yield* checkOmpProviderStatus(
        settings,
        {},
        failingModels(
          new OmpRpcFrameTooLargeError({
            frameType: "get_available_models",
            frameBytes: 2_000_000,
            limitBytes: 1_048_576,
          }),
        ),
      );
      expect(result.message).toContain("above the agent's 1048576 byte frame limit");
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("names a protocol violation read through the real client", () =>
    Effect.gen(function* () {
      const result = yield* checkOmpProviderStatus(settings, {}, () =>
        Effect.gen(function* () {
          // A second ready frame in place of the model list is fatal.
          const wire = yield* makeOmpScriptedWire((command) =>
            command.type === "get_available_models"
              ? {
                  type: "ready",
                  protocolVersion: 1,
                  supportedProtocolVersions: [1, 2],
                  maxFrameBytes: 1_048_576,
                  maxReassembledFrameBytes: 67_108_864,
                }
              : undefined,
          );
          const client = yield* makeOmpRpcClient(wire.io);
          return {
            ...client,
            version: "18.3.1",
            shutdown: Effect.succeed({ code: 0, forced: false, stderrTail: "" }),
            redaction: makeOmpRedaction(undefined, []),
          };
        }),
      );
      expect(result.message).toBe(
        "Oh My Pi sent output Scient could not read: RPC emitted a second ready frame.",
      );
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
