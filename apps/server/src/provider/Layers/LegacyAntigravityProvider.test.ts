import { describe, expect, it } from "@effect/vitest";
import { NodePath } from "@effect/platform-node";
import type { ServerProviderModel } from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import {
  checkAntigravityProviderStatus,
  groupAntigravityModels,
  isAgyApiKeyModeConfigurationError,
  parseAgyModelsOutput,
} from "./LegacyAntigravityProvider.ts";

/** Deterministic Crypto for tests that never reach random UUID generation. */
const CryptoLayer = Layer.succeed(
  Crypto.Crypto,
  Crypto.make({
    randomBytes: (size) => new Uint8Array(size),
    digest: () => Effect.succeed(new Uint8Array(32)),
  }),
);

/** A spawner that must never be reached by short-circuiting code paths. */
const NeverSpawnerLayer = Layer.succeed(
  ChildProcessSpawner.ChildProcessSpawner,
  ChildProcessSpawner.make(() => Effect.die("test spawner must not be used")),
);

describe("parseAgyModelsOutput", () => {
  it("parses the verified tab-separated records from `agy models` stdout", () => {
    // Verified against agy 1.1.17: stdout carries only model records; the
    // "Fetching..." progress line goes to stderr and never reaches here.
    const output = [
      "gemini-3.7-flash-high\tGemini 3.7 Flash (High)",
      "gemini-3.7-flash-low\tGemini 3.7 Flash (Low)",
      "claude-opus-4-6-thinking\tClaude Opus 4.6 (Thinking)",
    ].join("\n");

    expect(parseAgyModelsOutput(output)).toEqual([
      "gemini-3.7-flash-high",
      "gemini-3.7-flash-low",
      "claude-opus-4-6-thinking",
    ]);
  });

  it("accepts bare slugs without a display name", () => {
    const output = "gemini-3.7-pro-medium\nclaude-sonnet-4-6\n";
    expect(parseAgyModelsOutput(output)).toEqual(["gemini-3.7-pro-medium", "claude-sonnet-4-6"]);
  });

  it("skips comments and blank lines", () => {
    expect(parseAgyModelsOutput("# comment\n\nmodel-a\tModel A\n")).toEqual(["model-a"]);
  });

  it("accepts a JSON array of strings defensively for forward compatibility", () => {
    expect(parseAgyModelsOutput('["m1"," m2 "]')).toEqual(["m1", "m2"]);
  });

  it("returns nothing for empty input", () => {
    expect(parseAgyModelsOutput("")).toEqual([]);
  });
});

describe("Antigravity account-mode diagnostics", () => {
  it("recognizes the provider's missing API-key error without matching unrelated text", () => {
    expect(isAgyApiKeyModeConfigurationError("GEMINI_API_KEY is not set")).toBe(true);
    expect(isAgyApiKeyModeConfigurationError("Missing required GEMINI_API_KEY")).toBe(true);
    expect(isAgyApiKeyModeConfigurationError("Please sign in with Google")).toBe(false);
  });
});

describe("groupAntigravityModels", () => {
  const reasoningValues = (models: ReadonlyArray<ServerProviderModel>): ReadonlyArray<string> => {
    const model = models[0];
    if (!model) throw new Error("expected a model");
    const capabilities = model.capabilities;
    if (!capabilities) throw new Error("expected capabilities");
    const reasoning = capabilities.optionDescriptors?.find((d) => d.id === "reasoning");
    if (reasoning?.type !== "select") throw new Error("expected a select reasoning descriptor");
    return reasoning.options.map((option) => option.id);
  };

  it("collapses effort-suffixed slugs into one model with reasoning options", () => {
    const models = groupAntigravityModels([
      "gemini-3.7-flash-high",
      "gemini-3.7-flash-low",
      "gemini-3.7-flash-medium",
    ]);

    expect(models.length).toBe(1);
    const model = models[0];
    expect(model?.slug).toBe("gemini-3.7-flash");
    expect(model?.name).toBe("Gemini 3.7 Flash");
    expect(model?.isDefault).toBe(true);
    expect(reasoningValues(models)).toEqual(["low", "medium", "high"]);
    const reasoning = model?.capabilities?.optionDescriptors?.find(
      (descriptor) => descriptor.id === "reasoning",
    );
    expect(reasoning?.currentValue).toBe("medium");
  });

  it("keeps effort ordering low→medium→high regardless of discovery order", () => {
    const models = groupAntigravityModels(["x-high", "x-medium", "x-low"]);
    expect(reasoningValues(models)).toEqual(["low", "medium", "high"]);
  });

  it("never splits non-effort suffixes like claude-opus-4-6-thinking", () => {
    const models = groupAntigravityModels([
      "claude-opus-4-6-thinking",
      "claude-sonnet-4-6",
      "gpt-5-codex",
    ]);

    expect(models.map((m) => m.slug)).toEqual([
      "claude-opus-4-6-thinking",
      "claude-sonnet-4-6",
      "gpt-5-codex",
    ]);
    for (const model of models) {
      expect(model.capabilities?.optionDescriptors ?? []).toEqual([]);
    }
  });

  it("groups only exact effort suffixes; sibling variants merge under one slug", () => {
    // "-thinking" is not an effort, but a hypothetical "foo-low" is.
    const models = groupAntigravityModels(["foo-low", "foo-high"]);
    expect(models.length).toBe(1);
    expect(models[0]?.slug).toBe("foo");
  });

  it("ignores blank entries and trims whitespace", () => {
    const models = groupAntigravityModels(["  gemini-3.7-flash-low  ", "", "   "]);
    expect(models.map((m) => m.slug)).toEqual(["gemini-3.7-flash"]);
  });
});

describe("checkAntigravityProviderStatus wiring", () => {
  it.effect("short-circuits disabled providers before any probe runs", () =>
    Effect.gen(function* () {
      const settings = { enabled: false, binaryPath: "agy", customModels: [] };
      const draft = yield* checkAntigravityProviderStatus(settings, {}).pipe(
        Effect.provide(
          Layer.mergeAll(FileSystem.layerNoop({}), NodePath.layer, CryptoLayer, NeverSpawnerLayer),
        ),
      );
      expect(draft.enabled).toBe(false);
    }),
  );

  it("keeps ServerProviderModel shape stable for grouped output", () => {
    const [grouped] = groupAntigravityModels(["m-low"]);
    if (!grouped) throw new Error("expected a grouped model");
    const expected: ServerProviderModel = {
      slug: "m",
      name: grouped.name,
      isCustom: false,
      capabilities: grouped.capabilities,
    };
    expect(grouped).toEqual(expected);
  });

  function commandHandle(input: {
    readonly stdout?: string;
    readonly stderr?: string;
    readonly code: number;
  }) {
    return ChildProcessSpawner.makeHandle({
      pid: ChildProcessSpawner.ProcessId(1),
      exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(input.code)),
      isRunning: Effect.succeed(false),
      kill: () => Effect.void,
      unref: Effect.succeed(Effect.void),
      stdin: Sink.drain,
      stdout: Stream.encodeText(Stream.make(input.stdout ?? "")),
      stderr: Stream.encodeText(Stream.make(input.stderr ?? "")),
      all: Stream.empty,
      getInputFd: () => Sink.drain,
      getOutputFd: () => Stream.empty,
    });
  }

  function probeLayer(
    results: ReadonlyArray<{
      readonly stdout?: string;
      readonly stderr?: string;
      readonly code: number;
    }>,
    commands: ChildProcess.Command[],
  ) {
    let index = 0;
    const spawner = ChildProcessSpawner.make((command) =>
      Effect.sync(() => {
        commands.push(command);
        const result = results[index++];
        if (!result) throw new Error("unexpected probe command");
        return commandHandle(result);
      }),
    );
    return Layer.mergeAll(
      CryptoLayer,
      Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner),
    );
  }

  it.effect("uses provider-owned model discovery as the account and model truth", () =>
    Effect.gen(function* () {
      const commands: ChildProcess.Command[] = [];
      const draft = yield* checkAntigravityProviderStatus(
        { enabled: true, binaryPath: "/usr/local/bin/agy", customModels: [] },
        { PATH: "/usr/bin" },
      ).pipe(
        Effect.provide(
          probeLayer(
            [
              { stdout: "agy 1.1.17\n", code: 0 },
              {
                stdout: [
                  "gemini-3.7-flash-low\tGemini 3.7 Flash (Low)",
                  "gemini-3.7-flash-medium\tGemini 3.7 Flash (Medium)",
                  "gemini-3.7-flash-high\tGemini 3.7 Flash (High)",
                ].join("\n"),
                code: 0,
              },
            ],
            commands,
          ),
        ),
      );
      expect(draft.status).toBe("ready");
      expect(draft.auth.status).toBe("authenticated");
      expect(draft.version).toBe("1.1.17");
      expect(draft.models.map((model) => model.slug)).toEqual(["gemini-3.7-flash"]);
      expect(commands).toHaveLength(2);
      for (const command of commands) {
        if (command._tag !== "StandardCommand") throw new Error("expected standard command");
        expect(command.options.extendEnv).toBe(false);
        expect(command.options.stdin).toBe("ignore");
      }
    }),
  );

  it.effect("distinguishes an unauthenticated Google account from discovery failure", () =>
    Effect.gen(function* () {
      const draft = yield* checkAntigravityProviderStatus(
        { enabled: true, binaryPath: "/usr/local/bin/agy", customModels: [] },
        {},
      ).pipe(
        Effect.provide(
          probeLayer(
            [
              { stdout: "1.1.17\n", code: 0 },
              { stderr: "Please sign in with Google to continue.", code: 1 },
            ],
            [],
          ),
        ),
      );
      expect(draft.status).toBe("error");
      expect(draft.auth.status).toBe("unauthenticated");
      expect(draft.message).toContain("not authenticated");
    }),
  );

  it.effect("explains how to leave API-key mode instead of silently using it", () =>
    Effect.gen(function* () {
      const draft = yield* checkAntigravityProviderStatus(
        { enabled: true, binaryPath: "/usr/local/bin/agy", customModels: [] },
        {},
      ).pipe(
        Effect.provide(
          probeLayer(
            [
              { stdout: "1.1.17\n", code: 0 },
              { stderr: "GEMINI_API_KEY is not set", code: 1 },
            ],
            [],
          ),
        ),
      );
      expect(draft.status).toBe("error");
      expect(draft.auth.status).toBe("unauthenticated");
      expect(draft.message).toContain("API-key mode");
      expect(draft.message).toContain("modelProvider");
    }),
  );

  it.effect("does not treat a non-zero version probe as a healthy installation", () =>
    Effect.gen(function* () {
      const draft = yield* checkAntigravityProviderStatus(
        { enabled: true, binaryPath: "/usr/local/bin/agy", customModels: [] },
        {},
      ).pipe(Effect.provide(probeLayer([{ stderr: "broken install", code: 2 }], [])));
      expect(draft.status).toBe("error");
      expect(draft.message).toContain("--version` failed");
    }),
  );
});
