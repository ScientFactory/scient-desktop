import { describe, expect, it } from "@effect/vitest";

import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as EffectAcpErrors from "effect-acp/errors";

import {
  appendGrokAcpRules,
  applyGrokAcpModelSelection,
  buildGrokAcpSpawnInput,
  grokAcpSpawnArgs,
} from "./acpSupport.ts";

describe("appendGrokAcpRules", () => {
  it("preserves caller rules and appends Scient awareness", () => {
    expect(appendGrokAcpRules("Project rules", "Scient tool guidance")).toBe(
      "Project rules\n\nScient tool guidance",
    );
  });

  it("omits empty sections without emitting an empty CLI rules value", () => {
    expect(appendGrokAcpRules("  ", undefined)).toBeUndefined();
    expect(appendGrokAcpRules("Project rules", undefined)).toBe("Project rules");
  });
});

describe("grokAcpSpawnArgs", () => {
  it("inherits the Grok CLI config when no T3 runtime mode is set", () => {
    expect(grokAcpSpawnArgs()).toEqual(["agent", "stdio"]);
  });

  it("forces Grok to ask when T3 is Supervised", () => {
    expect(grokAcpSpawnArgs("approval-required")).toEqual([
      "--permission-mode",
      "default",
      "agent",
      "stdio",
    ]);
  });
});

describe("buildGrokAcpSpawnInput", () => {
  it("passes the Scient referrer without changing non-chat Grok argv", () => {
    const spawn = buildGrokAcpSpawnInput({ binaryPath: "/usr/local/bin/grok" }, "/tmp/project", {
      XAI_API_KEY: "secret",
      GROK_OAUTH2_REFERRER: "other-client",
    });

    expect(spawn).toEqual({
      command: "/usr/local/bin/grok",
      args: ["agent", "stdio"],
      cwd: "/tmp/project",
      env: {
        XAI_API_KEY: "secret",
        GROK_OAUTH2_REFERRER: "t3code",
      },
    });
  });

  it("adds presentation rules only when the interactive adapter requests them", () => {
    const rules = "## Scient\nUse Scient presentation tools when available.";
    const spawn = buildGrokAcpSpawnInput(
      { binaryPath: "/usr/local/bin/grok" },
      "/tmp/project",
      undefined,
      undefined,
      rules,
    );

    expect(spawn.args).toEqual(["--rules", rules, "agent", "stdio"]);
  });
});

describe("applyGrokAcpModelSelection", () => {
  const makeRecordingRuntime = (failure?: EffectAcpErrors.AcpError) => {
    const modelCalls: Array<{
      modelId: string;
      meta?: { readonly [key: string]: unknown } | null;
    }> = [];
    const runtime = {
      setSessionModel: (modelId: string, meta?: { readonly [key: string]: unknown } | null) =>
        Effect.gen(function* () {
          modelCalls.push(meta === undefined ? { modelId } : { modelId, meta });
          if (failure) return yield* failure;
          return {};
        }),
    };
    return { runtime, modelCalls };
  };

  it.effect("calls session/set_model when the requested model differs from current", () =>
    Effect.gen(function* () {
      const { runtime, modelCalls } = makeRecordingRuntime();
      const result = yield* applyGrokAcpModelSelection({
        runtime,
        currentModelId: "grok-build",
        requestedModelId: "grok-mock-alt",
        mapError: (cause) => cause.message,
      });
      expect(modelCalls).toEqual([{ modelId: "grok-mock-alt" }]);
      expect(result).toBe("grok-mock-alt");
    }),
  );

  it.effect("applies reasoning effort through session/set_model metadata", () =>
    Effect.gen(function* () {
      const { runtime, modelCalls } = makeRecordingRuntime();
      const result = yield* applyGrokAcpModelSelection({
        runtime,
        currentModelId: "grok-4.6",
        currentReasoningEffort: "high",
        requestedModelId: "grok-4.6",
        requestedReasoningEffort: "xhigh",
        mapError: (cause) => cause.message,
      });
      expect(modelCalls).toEqual([{ modelId: "grok-4.6", meta: { reasoningEffort: "xhigh" } }]);
      expect(result).toBe("grok-4.6");
    }),
  );

  it.effect("preserves an explicitly selected reasoning effort that is already active", () =>
    Effect.gen(function* () {
      const { runtime, modelCalls } = makeRecordingRuntime();
      const result = yield* applyGrokAcpModelSelection({
        runtime,
        currentModelId: "grok-4.6",
        currentReasoningEffort: "high",
        requestedModelId: "grok-build",
        requestedReasoningEffort: "high",
        mapError: (cause) => cause.message,
      });
      expect(modelCalls).toEqual([]);
      expect(result).toBe("grok-4.6");
    }),
  );

  it.effect("rejects malformed effort metadata instead of silently dropping it", () =>
    Effect.gen(function* () {
      const { runtime, modelCalls } = makeRecordingRuntime();
      const exit = yield* Effect.exit(
        applyGrokAcpModelSelection({
          runtime,
          currentModelId: "grok-4.6",
          currentReasoningEffort: "high",
          requestedModelId: "grok-4.6",
          requestedReasoningEffort: "not a token",
          mapError: (cause) => cause.message,
        }),
      );
      expect(exit).toEqual(Exit.fail("Grok cannot apply an invalid reasoning effort."));
      expect(modelCalls).toEqual([]);
    }),
  );

  it.effect("skips set_model when requested matches current", () =>
    Effect.gen(function* () {
      const { runtime, modelCalls } = makeRecordingRuntime();
      const result = yield* applyGrokAcpModelSelection({
        runtime,
        currentModelId: "grok-build",
        requestedModelId: "grok-build",
        mapError: (cause) => cause.message,
      });
      expect(modelCalls).toEqual([]);
      expect(result).toBe("grok-build");
    }),
  );

  it.effect("keeps the session's current model when the product slug is requested", () =>
    Effect.gen(function* () {
      const { runtime, modelCalls } = makeRecordingRuntime();
      const result = yield* applyGrokAcpModelSelection({
        runtime,
        currentModelId: "grok-4.6",
        requestedModelId: "grok-build",
        mapError: (cause) => cause.message,
      });
      expect(modelCalls).toEqual([]);
      expect(result).toBe("grok-4.6");
    }),
  );

  it.effect("applies reasoning to the current model when the product slug is requested", () =>
    Effect.gen(function* () {
      const { runtime, modelCalls } = makeRecordingRuntime();
      const result = yield* applyGrokAcpModelSelection({
        runtime,
        currentModelId: "grok-4.6",
        currentReasoningEffort: "high",
        requestedModelId: "grok-build",
        requestedReasoningEffort: "xhigh",
        mapError: (cause) => cause.message,
      });
      expect(modelCalls).toEqual([{ modelId: "grok-4.6", meta: { reasoningEffort: "xhigh" } }]);
      expect(result).toBe("grok-4.6");
    }),
  );
});
