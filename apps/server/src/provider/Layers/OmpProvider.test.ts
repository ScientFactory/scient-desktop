import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { OmpSettings } from "@t3tools/contracts";

import type { OmpRpcResponse } from "effect-omp-rpc/schema";

import type { OmpRpcProcess } from "../omp/OmpRpcProcess.ts";
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
  binaryPathFingerprint: "binary-test",
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
  setHostTools: () => Effect.succeed(response("set_host_tools")),
  setHostUriSchemes: () => Effect.succeed(response("set_host_uri_schemes")),
  extensionUiResponse: () => Effect.void,
  hostToolUpdate: () => Effect.void,
  hostToolResult: () => Effect.void,
  hostUriResult: () => Effect.void,
  close: () => Effect.void,
  shutdown: Effect.succeed({ code: 0, forced: false, stderrTail: "" }),
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
      expect(result.models.map((model) => model.slug)).toEqual(["anthropic/claude-test"]);
      expect(result.slashCommands?.map((command) => command.name)).toEqual(["help", "compact"]);
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
