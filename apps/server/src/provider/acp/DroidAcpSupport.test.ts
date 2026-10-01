import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import { ChildProcessSpawner } from "effect/unstable/process";
import * as Redacted from "effect/Redacted";
import * as EffectAcpErrors from "effect-acp/errors";
import { DROID_DEFAULT_MODEL, type ModelReasoningMetadata } from "@t3tools/contracts";
import type { CustomModelReasoning } from "../../customModelCapabilities.ts";
import { makeDroidKeyBroker } from "../droid/DroidKeyBroker.ts";
import {
  getProviderOptionDescriptors,
  getProviderOptionCurrentLabel,
  buildExplicitProviderOptionSelectionsFromDescriptors,
} from "@t3tools/shared/model";

import {
  applyDroidModelAndEffort,
  buildDroidAcpSpawnInput,
  buildDroidCapabilitiesFromEfforts,
  buildDroidModelsFromConfigOptions,
  discoverDroidModels,
  droidAccountCapabilitiesFromInitializeResult,
  droidCostMultiplierLabel,
  droidReplacedDefaultNotice,
  makeDroidCredentialRedactor,
  findDroidAutonomyOption,
  findSelectDroidConfigOption,
  hasDroidApiKeyEnvironment,
  makeDroidAcpRuntime,
  requestedDroidEffortFromSelection,
  resolveAdvertisedDroidAuthMethodId,
  resolveDroidAuthMethodId,
  resolveDroidCliBinaryPath,
} from "./DroidAcpSupport.ts";

const makeRuntime = (overrides?: {
  readonly configOptions?: Parameters<typeof findSelectDroidConfigOption>[0];
}) => {
  const calls: Array<{ readonly op: string; readonly arg: unknown }> = [];
  let currentModel = "auto";
  let appliedEffort: string | undefined;
  const runtime = {
    setModel: (modelId: string) =>
      Effect.sync(() => {
        calls.push({ op: "setModel", arg: modelId });
        currentModel = modelId;
      }),
    getConfigOptions: Effect.succeed(
      overrides?.configOptions ??
        ([
          {
            id: "model",
            name: "Model",
            category: "model",
            type: "select",
            currentValue: currentModel,
            options: [
              { value: "auto", name: "Auto" },
              { value: "gpt-5.6-sol", name: "GPT-5.6 Sol" },
            ],
          },
          {
            id: "reasoning_effort",
            name: "Reasoning",
            category: "thought_level",
            type: "select",
            currentValue: "none",
            options: [
              { value: "none", name: "None" },
              { value: "high", name: "High" },
            ],
          },
        ] as never),
    ).pipe(
      Effect.map((options) =>
        (options ?? []).map((option) =>
          option.type === "select" &&
          option.id === "reasoning_effort" &&
          appliedEffort !== undefined
            ? { ...option, currentValue: appliedEffort }
            : option,
        ),
      ),
    ),
    setConfigOption: (configId: string, value: string) =>
      Effect.sync(() => {
        calls.push({ op: "setConfigOption", arg: { configId, value } });
        if (configId === "model") currentModel = value;
        if (configId === "reasoning_effort") appliedEffort = value;
      }),
  };
  return { runtime, calls };
};

describe("resolveDroidCliBinaryPath", () => {
  it.effect("applies a supported preference only when no effort was explicitly selected", () =>
    Effect.gen(function* () {
      const { runtime, calls } = makeRuntime();
      const managed = {
        ...runtime,
        getReasoningMetadata: () => ({
          status: "known" as const,
          source: "provider" as const,
          stale: false,
          checkedAt: "2026-09-06T00:00:00Z",
          supported: true,
          levels: ["high"] as const,
          defaultLevel: "high" as const,
        }),
        getDefaultReasoningLevel: () => "high",
      };
      yield* applyDroidModelAndEffort({
        runtime: managed,
        requestedModel: undefined,
        requestedEffort: undefined,
      });
      expect(calls).toContainEqual({
        op: "setConfigOption",
        arg: { configId: "reasoning_effort", value: "high" },
      });
    }),
  );
  it.effect("applies the configured level after a switch even without a saved preference", () =>
    Effect.gen(function* () {
      // Droid keeps the previous model's effort across a model switch.
      const { runtime, calls } = makeRuntime();
      yield* applyDroidModelAndEffort({
        runtime: {
          ...runtime,
          getReasoningMetadata: () => ({
            status: "known" as const,
            supported: true,
            levels: ["high" as const],
            defaultLevel: "high" as const,
          }),
          getDefaultReasoningLevel: () => undefined,
        },
        requestedModel: "gpt-5.6-sol",
        requestedEffort: undefined,
      });
      expect(calls).toEqual([
        { op: "setModel", arg: "gpt-5.6-sol" },
        { op: "setConfigOption", arg: { configId: "reasoning_effort", value: "high" } },
      ]);
    }),
  );
  it("changes only the default badge, not Droid's available efforts", () => {
    const metadata: ModelReasoningMetadata = {
      status: "known",
      source: "provider",
      checkedAt: "2026-09-06T00:00:00Z",
      stale: false,
      supported: true,
      levels: ["low", "medium", "high"],
      defaultLevel: "medium",
    };
    const efforts = ["low", "medium", "high"].map((value) => ({ value, label: value }));
    const options = buildDroidCapabilitiesFromEfforts(efforts, metadata, "high")
      .optionDescriptors?.[0];
    expect(options?.type === "select" && options.options.map((o) => o.id)).toEqual([
      "low",
      "medium",
      "high",
    ]);
    expect(
      options?.type === "select" && options.options.filter((o) => o.isDefault).map((o) => o.id),
    ).toEqual(["high"]);
  });
  it("uses the configured path or the PATH-resolved droid command", () => {
    expect(resolveDroidCliBinaryPath("/opt/droid")).toBe("/opt/droid");
    expect(resolveDroidCliBinaryPath("  /opt/droid  ")).toBe("/opt/droid");
    expect(resolveDroidCliBinaryPath("   ")).toBe("droid");
    expect(resolveDroidCliBinaryPath(undefined)).toBe("droid");
  });
});

describe("makeDroidAcpRuntime", () => {
  it.effect(
    "refuses a runtime without tools before starting Droid: it has no hook to enforce it",
    () =>
      Effect.gen(function* () {
        let spawned = 0;
        const exit = yield* makeDroidAcpRuntime({
          droidSettings: { binaryPath: "droid" },
          childProcessSpawner: ChildProcessSpawner.make(() =>
            Effect.sync(() => void spawned++).pipe(Effect.andThen(Effect.die("spawned Droid"))),
          ),
          cwd: process.cwd(),
          clientInfo: { name: "test", version: "0" },
          modelTools: "disabled",
        }).pipe(
          Effect.flatMap((runtime) => runtime.start()),
          Effect.scoped,
          Effect.exit,
        );
        expect(spawned).toBe(0);
        expect(Exit.isFailure(exit)).toBe(true);
        expect(Exit.isFailure(exit) && String(exit.cause)).toContain(
          "cannot run Droid without tools in this process",
        );
      }).pipe(Effect.provide(NodeServices.layer)),
  );
});

describe("buildDroidAcpSpawnInput", () => {
  it("uses exec --output-format acp and never -m/-r", () => {
    const spawn = buildDroidAcpSpawnInput({ binaryPath: "/usr/local/bin/droid" }, "/tmp/project", {
      FACTORY_API_KEY: "secret",
    });
    expect(spawn.command).toBe("/usr/local/bin/droid");
    expect(spawn.args).toEqual(["exec", "--output-format", "acp"]);
    expect(spawn.cwd).toBe("/tmp/project");
    expect(JSON.stringify(spawn.args)).not.toContain("-m");
    expect(JSON.stringify(spawn.args)).not.toContain("-r");
  });

  it("uses Droid's native system-prompt append seam when awareness is supplied", () => {
    expect(
      buildDroidAcpSpawnInput(undefined, "/tmp/project", undefined, "exact awareness"),
    ).toEqual({
      command: "droid",
      args: ["exec", "--output-format", "acp", "--append-system-prompt", "exact awareness"],
      cwd: "/tmp/project",
    });
  });

  it("places a runtime settings overlay before the exec subcommand", () => {
    expect(
      buildDroidAcpSpawnInput(
        undefined,
        "/tmp/project",
        undefined,
        undefined,
        "/tmp/scient-droid/settings.json",
      ).args,
    ).toEqual(["--settings", "/tmp/scient-droid/settings.json", "exec", "--output-format", "acp"]);
  });
});

describe("auth resolution", () => {
  it("derives account actions only from advertised ACP capabilities", () => {
    expect(
      droidAccountCapabilitiesFromInitializeResult({
        protocolVersion: 1,
        authMethods: [{ id: "device-pairing", name: "Factory device pairing" }],
        agentCapabilities: { auth: { logout: {} } },
      }),
    ).toEqual({ devicePairing: true, logout: true });
    expect(
      droidAccountCapabilitiesFromInitializeResult({
        protocolVersion: 1,
        authMethods: [],
        agentCapabilities: { auth: { logout: null } },
      }),
    ).toEqual({ devicePairing: false, logout: false });
  });

  it("selects api-key only when the environment carries one", () => {
    expect(hasDroidApiKeyEnvironment({ FACTORY_API_KEY: "k" })).toBe(true);
    expect(hasDroidApiKeyEnvironment({ FACTORY_API_KEY: "  " })).toBe(false);
    expect(hasDroidApiKeyEnvironment({})).toBe(false);
    expect(resolveDroidAuthMethodId({ FACTORY_API_KEY: "k" })).toBe("factory-api-key");
    expect(resolveDroidAuthMethodId({})).toBe("device-pairing");
  });

  it("resolves against the advertised list and degrades honestly", () => {
    expect(
      resolveAdvertisedDroidAuthMethodId({
        environment: {},
        advertisedAuthMethods: ["factory-api-key", "device-pairing"],
      }),
    ).toBe("device-pairing");
    expect(
      resolveAdvertisedDroidAuthMethodId({
        environment: { FACTORY_API_KEY: "k" },
        advertisedAuthMethods: ["factory-api-key", "device-pairing"],
      }),
    ).toBe("factory-api-key");
    // Nothing advertised matches: undefined, not a guessed method id.
    expect(
      resolveAdvertisedDroidAuthMethodId({
        environment: {},
        advertisedAuthMethods: [],
      }),
    ).toBeUndefined();
  });
});

describe("config-option parsing", () => {
  const configOptions = [
    {
      id: "model",
      name: "Model",
      category: "model",
      type: "select",
      currentValue: "gpt-5.6-sol",
      options: [
        { value: "auto", name: "Auto" },
        {
          value: "gpt-5.6-sol",
          name: "GPT-5.6 Sol",
          description: "0.5x Factory token rate",
        },
        { value: "expensive", name: "Expensive", description: "12x Factory token rate" },
      ],
    },
    {
      id: "reasoning_effort",
      name: "Reasoning",
      category: "thought_level",
      type: "select",
      currentValue: "high",
      options: [{ value: "high", name: "High" }],
    },
    {
      id: "autonomy_level",
      name: "Autonomy",
      category: "mode",
      type: "select",
      currentValue: "normal",
      options: [{ value: "normal", name: "Normal" }],
    },
  ] as never;

  it("builds the model inventory from a snapshot", () => {
    const models = buildDroidModelsFromConfigOptions(configOptions);
    expect(models.map((model) => model.slug)).toEqual(["auto", "gpt-5.6-sol", "expensive"]);
    expect(models.map((model) => model.capabilitiesObserved)).toEqual([false, true, false]);
    expect(models[1]?.currentEffortValue).toBe("high");
  });

  it("advertises the selected custom model's live effort ladder", () => {
    const models = buildDroidModelsFromConfigOptions([
      {
        id: "model",
        name: "Model",
        category: "model",
        type: "select",
        currentValue: "custom:Ox-Alpha-0",
        options: [{ value: "custom:Ox-Alpha-0", name: "Ox Alpha" }],
      },
      {
        id: "reasoning_effort",
        name: "Reasoning",
        category: "thought_level",
        type: "select",
        currentValue: "none",
        options: [
          { value: "none", name: "None" },
          { value: "high", name: "High" },
        ],
      },
    ] as never);
    expect(models[0]?.capabilitiesObserved).toBe(true);
    expect(models[0]?.currentEffortValue).toBe("none");
    expect(models[0]?.efforts).toEqual([
      { value: "none", label: "None" },
      { value: "high", label: "High" },
    ]);
  });

  it("extracts cost multipliers from option descriptions", () => {
    const models = buildDroidModelsFromConfigOptions(configOptions);
    expect(models[0]?.providerCostLabel).toBeUndefined();
    expect(models[1]?.providerCostLabel).toBe("0.5×");
    expect(models[2]?.providerCostLabel).toBe("12×");
    // Only a *leading* multiplier counts as a cost label.
    expect(droidCostMultiplierLabel("Launch Pricing")).toBeUndefined();
    expect(droidCostMultiplierLabel(undefined)).toBeUndefined();
    expect(droidCostMultiplierLabel("  2x Factory token rate ")).toBe("2×");
    // Prose that merely mentions a rate is not a badge.
    expect(droidCostMultiplierLabel("Uses the standard rate, about 2x cheaper")).toBeUndefined();
  });

  it("finds select options by id or category case-insensitively", () => {
    expect(findSelectDroidConfigOption(configOptions, { id: "MODEL" })?.id).toBe("model");
    expect(findSelectDroidConfigOption(configOptions, { category: "Mode" })?.id).toBe(
      "autonomy_level",
    );
    expect(findSelectDroidConfigOption(configOptions, {})).toBeUndefined();
    expect(findSelectDroidConfigOption(undefined, { id: "model" })).toBeUndefined();
  });

  it("finds the autonomy option by id or mode category", () => {
    expect(findDroidAutonomyOption(configOptions)?.id).toBe("autonomy_level");
    expect(findDroidAutonomyOption([])).toBeUndefined();
  });
});

describe("composer capability + effort extraction", () => {
  const known: ModelReasoningMetadata = {
    status: "known",
    supported: true,
    levels: ["high", "max"],
    defaultLevel: "max",
    source: "provider",
    checkedAt: "2026-09-06T00:00:00Z",
    stale: true,
  };
  it("intersects stale known evidence exactly without inventing levels or defaults", () => {
    const result = buildDroidCapabilitiesFromEfforts(
      [
        { value: "none", label: "None", isDefault: true },
        { value: "high", label: "High" },
        { value: "xhigh", label: "Extra High" },
      ],
      known,
    );
    expect(result.optionDescriptors).toEqual([
      expect.objectContaining({
        id: "reasoningEffort",
        label: "Reasoning",
        type: "select",
        strictSelection: true,
        concreteReasoning: true,
        options: [{ id: "high", label: "High", isDefault: true }],
      }),
    ]);
  });
  it("offers no reasoning choice for a managed model whose overlay configures no effort", () => {
    // Droid 0.213.0 and 0.230.0 advertise off/low/medium/high/none for such a
    // model, report `none` after every write and send no reasoning parameter.
    const efforts = ["off", "low", "medium", "high", "none"].map((value) => ({
      value,
      label: value,
    }));
    for (const metadata of [
      null,
      { ...known, status: "unknown", supported: null, levels: [] },
      { ...known, status: "unknown", supported: true, levels: ["low", "high"] },
      { ...known, supported: false, levels: [] },
      { ...known, supported: true, levels: [] },
    ] satisfies ReadonlyArray<CustomModelReasoning | null>) {
      expect(buildDroidCapabilitiesFromEfforts(efforts, metadata).optionDescriptors).toEqual([
        expect.objectContaining({
          strictSelection: true,
          concreteReasoning: true,
          emptySelectionLabel: "Reasoning",
          options: [],
        }),
      ]);
    }
  });
  it("does not dispatch stale efforts when a managed model has no reasoning choices", () => {
    for (const metadata of [null, { ...known, supported: false, levels: [] }]) {
      const caps = buildDroidCapabilitiesFromEfforts(
        [{ value: "medium", label: "Medium", isDefault: true }],
        metadata,
      );
      const selections = [{ id: "reasoningEffort", value: "high" }];
      const descriptors = getProviderOptionDescriptors({ caps, selections });
      expect(getProviderOptionCurrentLabel(descriptors[0])).toBe("Reasoning");
      expect(
        buildExplicitProviderOptionSelectionsFromDescriptors(descriptors, selections),
      ).toBeUndefined();
      const empty = getProviderOptionDescriptors({ caps });
      expect(getProviderOptionCurrentLabel(empty[0])).toBe("Reasoning");
      expect(
        buildExplicitProviderOptionSelectionsFromDescriptors(empty, undefined),
      ).toBeUndefined();
    }
    expect(buildDroidCapabilitiesFromEfforts([]).optionDescriptors).toEqual([]);
  });
  it.effect("never writes an effort for a managed model whose overlay configures none", () =>
    Effect.gen(function* () {
      for (const metadata of [
        null,
        {
          ...known,
          status: "unknown" as const,
          source: "manual" as const,
          supported: true,
          levels: [],
          mode: "budget" as const,
        },
        { ...known, status: "unknown" as const, supported: null, levels: [] },
        { ...known, supported: false, levels: [] },
      ]) {
        const { runtime, calls } = makeRuntime();
        // A stale saved choice or an older client still sends a level.
        for (const requestedEffort of [undefined, "high", "none", "off"]) {
          yield* applyDroidModelAndEffort({
            runtime: {
              ...runtime,
              getReasoningMetadata: () => metadata,
              getDefaultReasoningLevel: () => "high",
            },
            requestedModel: "gpt-5.6-sol",
            requestedEffort,
          });
        }
        expect(calls.filter((call) => call.op !== "setModel")).toEqual([]);
      }
    }),
  );
  it.effect("rejects a managed effort write when the runtime silently retains another value", () =>
    Effect.gen(function* () {
      const { runtime } = makeRuntime();
      const result = yield* Effect.exit(
        applyDroidModelAndEffort({
          runtime: {
            ...runtime,
            getReasoningMetadata: () => known,
            setConfigOption: () => Effect.void,
          },
          requestedModel: undefined,
          requestedEffort: "high",
        }),
      );
      expect(result._tag).toBe("Failure");
    }),
  );
  it.effect("rejects explicit conflicts and replaces an inherited sentinel", () =>
    Effect.gen(function* () {
      const inherited = makeRuntime();
      yield* applyDroidModelAndEffort({
        runtime: { ...inherited.runtime, getReasoningMetadata: () => known },
        requestedModel: undefined,
        requestedEffort: undefined,
      });
      expect(inherited.calls).toEqual([
        { op: "setConfigOption", arg: { configId: "reasoning_effort", value: "high" } },
      ]);
      for (const requestedEffort of ["none", "max"]) {
        const { runtime, calls } = makeRuntime();
        const result = yield* Effect.exit(
          applyDroidModelAndEffort({
            runtime: { ...runtime, getReasoningMetadata: () => known },
            requestedModel: undefined,
            requestedEffort,
          }),
        );
        expect(result._tag).toBe("Failure");
        expect(calls).toEqual([]);
      }
      const { runtime, calls } = makeRuntime();
      yield* applyDroidModelAndEffort({
        runtime: { ...runtime, getReasoningMetadata: () => known },
        requestedModel: undefined,
        requestedEffort: "high",
      });
      expect(calls).toEqual([
        { op: "setConfigOption", arg: { configId: "reasoning_effort", value: "high" } },
      ]);
      yield* applyDroidModelAndEffort({
        runtime: { ...runtime, getReasoningMetadata: () => null },
        requestedModel: undefined,
        requestedEffort: undefined,
      });
    }),
  );
  it.effect(
    "offers and applies Off only for adaptive (Messages) thinking, where it disables it",
    () =>
      Effect.gen(function* () {
        const ladder = ["off", "low", "medium", "high"].map((value) => ({ value, label: value }));
        const options = (metadata: CustomModelReasoning) => {
          const descriptor = buildDroidCapabilitiesFromEfforts(ladder, metadata)
            .optionDescriptors?.[0];
          return descriptor?.type === "select" ? descriptor.options.map((option) => option.id) : [];
        };
        const adaptive = { ...known, levels: ["low", "high"], mode: "adaptive" } as const;
        const effort = { ...known, levels: ["low", "high"], mode: "effort" } as const;
        expect(options(adaptive)).toEqual(["off", "low", "high"]);
        // For effort APIs Droid then sends no parameter, which is the model's default, not off.
        expect(options(effort)).toEqual(["low", "high"]);
        const offLadder = makeRuntime({
          configOptions: [
            {
              id: "model",
              name: "Model",
              category: "model",
              type: "select",
              currentValue: "custom:scient-claude",
              options: [{ value: "custom:scient-claude", name: "Claude" }],
            },
            {
              id: "reasoning_effort",
              name: "Reasoning",
              category: "thought_level",
              type: "select",
              currentValue: "high",
              options: ladder.map(({ value }) => ({ value, name: value })),
            },
          ] as never,
        });
        yield* applyDroidModelAndEffort({
          runtime: { ...offLadder.runtime, getReasoningMetadata: () => adaptive },
          requestedModel: undefined,
          requestedEffort: "off",
        });
        expect(offLadder.calls).toEqual([
          { op: "setConfigOption", arg: { configId: "reasoning_effort", value: "off" } },
        ]);
        const refused = yield* Effect.exit(
          applyDroidModelAndEffort({
            runtime: { ...offLadder.runtime, getReasoningMetadata: () => effort },
            requestedModel: undefined,
            requestedEffort: "off",
          }),
        );
        expect(refused._tag).toBe("Failure");
      }),
  );

  it.effect("says which value Droid applied when it reports another effort", () =>
    Effect.gen(function* () {
      const { runtime } = makeRuntime();
      const result = yield* Effect.exit(
        applyDroidModelAndEffort({
          runtime: {
            ...runtime,
            getReasoningMetadata: () => known,
            setConfigOption: (configId: string, value: string) =>
              Effect.fail(
                new EffectAcpErrors.AcpRequestError({
                  code: -32603,
                  errorMessage: 'The agent applied reasoning_effort "none" instead of "high".',
                  data: { configId, requestedValue: value, appliedValue: "none" },
                }),
              ),
          },
          requestedModel: undefined,
          requestedEffort: "high",
        }),
      );
      expect(result._tag).toBe("Failure");
      expect(Exit.isFailure(result) && Cause.squash(result.cause)).toMatchObject({
        message:
          'Droid applied reasoning effort "none" instead of "high", so the message was not sent.',
      });
    }),
  );
  describe("a configured default Droid replaces", () => {
    // Droid 0.213.0 and 0.230.0 keep their own ladder for a model id they know:
    // gpt-5.2 configured with Minimal (or Max) runs at Low.
    const levels = ["minimal", "low", "medium", "high"] as const;
    const metadata = (defaultLevel: (typeof levels)[number]): CustomModelReasoning => ({
      status: "known",
      supported: true,
      mode: "effort",
      levels,
      defaultLevel,
    });
    const makeClampingRuntime = (replacement: string) => {
      const { runtime, calls } = makeRuntime({
        configOptions: [
          {
            id: "model",
            name: "Model",
            category: "model",
            type: "select",
            currentValue: "custom:scient-gpt",
            options: [{ value: "custom:scient-gpt", name: "GPT" }],
          },
          {
            id: "reasoning_effort",
            name: "Reasoning",
            category: "thought_level",
            type: "select",
            currentValue: "high",
            options: levels.map((value) => ({ value, name: value })),
          },
        ] as never,
      });
      return {
        calls,
        runtime: {
          ...runtime,
          // The confirmed transport: the write fails with what Droid reported.
          setConfigOption: (configId: string, value: string) =>
            value !== "minimal"
              ? runtime.setConfigOption(configId, value)
              : runtime.setConfigOption(configId, replacement).pipe(
                  Effect.andThen(
                    Effect.fail(
                      new EffectAcpErrors.AcpRequestError({
                        code: -32603,
                        errorMessage: `The agent applied reasoning_effort "${replacement}" instead of "minimal".`,
                        data: { configId, requestedValue: value, appliedValue: replacement },
                      }),
                    ),
                  ),
                ),
        },
      };
    };

    it.effect("runs at the level Droid applies and says which default it replaced", () =>
      Effect.gen(function* () {
        // The composer dispatches the default level like any other; none is the same wish.
        for (const requestedEffort of [undefined, "minimal"]) {
          const { runtime } = makeClampingRuntime("low");
          const replaced = yield* applyDroidModelAndEffort({
            runtime: {
              ...runtime,
              getReasoningMetadata: () => metadata("medium"),
              getDefaultReasoningLevel: () => "minimal",
            },
            requestedModel: undefined,
            requestedEffort,
          });
          expect(replaced, String(requestedEffort)).toEqual({
            configured: "minimal",
            applied: "low",
          });
          expect(droidReplacedDefaultNotice(replaced!)).toBe(
            "Droid uses Low for this model instead of the configured default Minimal.",
          );
        }
        const { runtime } = makeClampingRuntime("low");
        expect(
          yield* applyDroidModelAndEffort({
            runtime: {
              ...runtime,
              getReasoningMetadata: () => metadata("medium"),
              getDefaultReasoningLevel: () => "high",
            },
            requestedModel: undefined,
            requestedEffort: undefined,
          }),
        ).toBeUndefined();
      }),
    );

    it.effect("still refuses a level picked in the thread when Droid applies another", () =>
      Effect.gen(function* () {
        const { runtime } = makeClampingRuntime("low");
        const result = yield* Effect.exit(
          applyDroidModelAndEffort({
            runtime: {
              ...runtime,
              getReasoningMetadata: () => metadata("medium"),
              getDefaultReasoningLevel: () => "high",
            },
            requestedModel: undefined,
            requestedEffort: "minimal",
          }),
        );
        expect(Exit.isFailure(result) && Cause.squash(result.cause)).toMatchObject({
          message:
            'Droid applied reasoning effort "low" instead of "minimal", so the message was not sent.',
        });
      }),
    );

    it.effect("refuses a default Droid replaces with a level the model does not take", () =>
      Effect.gen(function* () {
        const { runtime } = makeClampingRuntime("none");
        const result = yield* Effect.exit(
          applyDroidModelAndEffort({
            runtime: {
              ...runtime,
              getReasoningMetadata: () => metadata("minimal"),
            },
            requestedModel: undefined,
            requestedEffort: undefined,
          }),
        );
        expect(Exit.isFailure(result) && Cause.squash(result.cause)).toMatchObject({
          message:
            'Droid applied reasoning effort "none" instead of "minimal", so the message was not sent.',
        });
      }),
    );

    it.effect("leaves the session on the model and level the walk found it with", () =>
      Effect.gen(function* () {
        // Like Droid, the session keeps its reasoning level across model switches.
        const current = { model: "native-a", reasoning_effort: "high" };
        const calls: Array<string> = [];
        const select = (id: "model" | "reasoning_effort", category: string, values: string[]) => ({
          id,
          name: id,
          category,
          type: "select" as const,
          currentValue: current[id],
          options: values.map((value) => ({ value, name: value })),
        });
        const runtime = {
          getConfigOptions: Effect.sync(() => [
            select("model", "model", ["native-a", "custom:scient-gpt"]),
            select("reasoning_effort", "thought_level", [...levels]),
          ]),
          setModel: (model: string) =>
            Effect.sync(() => {
              calls.push(`model=${model}`);
              current.model = model;
            }),
          setConfigOption: (_configId: string, value: string) =>
            Effect.sync(() => {
              calls.push(`effort=${value}`);
              current.reasoning_effort = value;
            }),
          getReasoningMetadata: (model: string) =>
            model === "custom:scient-gpt" ? metadata("medium") : undefined,
          getDefaultReasoningLevel: () => "low",
        };
        const models = yield* discoverDroidModels(runtime);
        expect(models.map((model) => model.slug)).toEqual(["native-a", "custom:scient-gpt"]);
        // The Scient model's configured level was written during the walk.
        expect(calls).toContain("effort=low");
        expect(current).toEqual({ model: "native-a", reasoning_effort: "high" });
        expect(calls.slice(-2)).toEqual(["model=native-a", "effort=high"]);
      }),
    );

    it.effect("refuses a report that also names another model than the one selected", () =>
      Effect.gen(function* () {
        // Each effort write reports a level the model takes, and model B as current.
        for (const [requestedEffort, reportedEffort] of [
          [undefined, "low"],
          ["minimal", "low"],
          ["minimal", "minimal"],
          ["high", "high"],
        ] as const) {
          const current = { model: "custom:scient-other", reasoning_effort: "high" as string };
          const select = (
            id: "model" | "reasoning_effort",
            category: string,
            values: string[],
          ) => ({
            id,
            name: id,
            category,
            type: "select" as const,
            currentValue: current[id],
            options: values.map((value) => ({ value, name: value })),
          });
          const result = yield* Effect.exit(
            applyDroidModelAndEffort({
              runtime: {
                getConfigOptions: Effect.sync(() => [
                  select("model", "model", ["custom:scient-gpt", "native-b"]),
                  select("reasoning_effort", "thought_level", [...levels]),
                ]),
                setModel: (model: string) =>
                  Effect.sync(() => {
                    current.model = model;
                  }),
                setConfigOption: (_configId: string, value: string) =>
                  Effect.suspend(() => {
                    current.model = "native-b";
                    current.reasoning_effort = reportedEffort;
                    return reportedEffort === value
                      ? Effect.void
                      : Effect.fail(
                          new EffectAcpErrors.AcpRequestError({
                            code: -32603,
                            errorMessage: `The agent applied reasoning_effort "${reportedEffort}" instead of "${value}".`,
                            data: {
                              configId: "reasoning_effort",
                              requestedValue: value,
                              appliedValue: reportedEffort,
                            },
                          }),
                        );
                  }),
                // Only the Scient model has metadata; B is one of Droid's own.
                getReasoningMetadata: (model: string) =>
                  model === "custom:scient-gpt" ? metadata("medium") : undefined,
                getDefaultReasoningLevel: () => "minimal",
              },
              requestedModel: "custom:scient-gpt",
              requestedEffort,
            }),
          );
          expect(
            Exit.isFailure(result) && Cause.squash(result.cause),
            `${requestedEffort} -> ${reportedEffort}`,
          ).toMatchObject({
            message:
              'Droid reported the model "native-b" instead of "custom:scient-gpt" after the reasoning effort was set, so the message was not sent.',
          });
        }
      }),
    );

    it.effect("offers the level Droid runs, not the default it replaced", () =>
      Effect.gen(function* () {
        const { runtime } = makeClampingRuntime("low");
        const [model] = yield* discoverDroidModels({
          ...runtime,
          getReasoningMetadata: () => metadata("medium"),
          getDefaultReasoningLevel: () => "minimal",
        });
        expect(model?.replacedDefault).toEqual({ configured: "minimal", applied: "low" });
        const descriptor = buildDroidCapabilitiesFromEfforts(
          model!.efforts,
          metadata("medium"),
          "minimal",
          model!.replacedDefault,
        ).optionDescriptors?.[0];
        expect(descriptor?.type === "select" && descriptor.options).toEqual([
          { id: "low", label: "low", isDefault: true },
          { id: "medium", label: "medium" },
          { id: "high", label: "high" },
        ]);
      }),
    );
  });

  it("maps an effort ladder into a single reasoningEffort select descriptor", () => {
    const capabilities = buildDroidCapabilitiesFromEfforts([
      { value: "none", label: "None" },
      { value: "high", label: "High", isDefault: true },
    ]);
    expect(capabilities).toBeDefined();
    const empty = buildDroidCapabilitiesFromEfforts([]);
    expect(empty).toBeDefined();
  });

  it("extracts the requested effort from composer selection options", () => {
    expect(requestedDroidEffortFromSelection([{ id: "reasoningEffort", value: " high " }])).toBe(
      "high",
    );
    expect(requestedDroidEffortFromSelection([{ id: "other", value: "x" }])).toBeUndefined();
    expect(
      requestedDroidEffortFromSelection([{ id: "reasoningEffort", value: "  " }]),
    ).toBeUndefined();
    expect(requestedDroidEffortFromSelection(undefined)).toBeUndefined();
  });
});

describe("applyDroidModelAndEffort", () => {
  it.effect("applies model before effort and validates against the live ladder", () =>
    Effect.gen(function* () {
      const first = makeRuntime();
      yield* applyDroidModelAndEffort({
        runtime: first.runtime,
        requestedModel: "gpt-5.6-sol",
        requestedEffort: "high",
      });
      expect(first.calls.map((call) => call.op)).toEqual(["setModel", "setConfigOption"]);
      expect(first.calls[0]?.arg).toBe("gpt-5.6-sol");
      expect(first.calls[1]?.arg).toEqual({ configId: "reasoning_effort", value: "high" });

      // Stale ladder value fails with an explicit request error.
      const second = makeRuntime();
      const failure = yield* Effect.exit(
        applyDroidModelAndEffort({
          runtime: second.runtime,
          requestedModel: undefined,
          requestedEffort: "max",
        }),
      );
      expect(failure._tag).toBe("Failure");
      expect(second.calls).toEqual([]);
    }),
  );

  it.effect("says why a model Droid does not offer is unavailable before selecting it", () =>
    Effect.gen(function* () {
      const native = makeRuntime();
      const nativeFailure = yield* Effect.exit(
        applyDroidModelAndEffort({
          runtime: native.runtime,
          requestedModel: "claude-opus-4-6",
          requestedEffort: undefined,
        }),
      );
      expect(Exit.isFailure(nativeFailure) && Cause.squash(nativeFailure.cause)).toMatchObject({
        message: 'Droid no longer offers "claude-opus-4-6". Pick another model.',
      });
      const managed = makeRuntime();
      const managedFailure = yield* Effect.exit(
        applyDroidModelAndEffort({
          runtime: {
            ...managed.runtime,
            describeUnavailableModel: (modelId: string) =>
              modelId === "custom:scient-lost-0" ? "Re-enter the API key for Lab." : undefined,
          },
          requestedModel: "custom:scient-lost-0",
          requestedEffort: "high",
        }),
      );
      expect(Exit.isFailure(managedFailure) && Cause.squash(managedFailure.cause)).toMatchObject({
        message: "Re-enter the API key for Lab.",
      });
      expect([...native.calls, ...managed.calls]).toEqual([]);
    }),
  );

  it.effect("keeps Droid's own model for the Droid default and a blank model", () =>
    Effect.gen(function* () {
      for (const requestedModel of [DROID_DEFAULT_MODEL, "  "]) {
        const { runtime, calls } = makeRuntime();
        yield* applyDroidModelAndEffort({ runtime, requestedModel, requestedEffort: undefined });
        expect(calls).toEqual([]);
      }
    }),
  );

  it.effect("no-ops when nothing is requested", () =>
    Effect.gen(function* () {
      const { runtime, calls } = makeRuntime();
      yield* applyDroidModelAndEffort({
        runtime,
        requestedModel: undefined,
        requestedEffort: undefined,
      });
      expect(calls).toEqual([]);
    }),
  );

  it.effect("applies an effort advertised by the selected custom model", () =>
    Effect.gen(function* () {
      const { runtime, calls } = makeRuntime({
        configOptions: [
          {
            id: "model",
            name: "Model",
            category: "model",
            type: "select",
            currentValue: "custom:Ox-Alpha-0",
            options: [{ value: "custom:Ox-Alpha-0", name: "Ox Alpha" }],
          },
          {
            id: "reasoning_effort",
            name: "Reasoning",
            category: "thought_level",
            type: "select",
            currentValue: "none",
            options: [
              { value: "none", name: "None" },
              { value: "high", name: "High" },
            ],
          },
        ] as never,
      });
      yield* applyDroidModelAndEffort({
        runtime,
        requestedModel: "custom:Ox-Alpha-0",
        requestedEffort: "high",
      });
      expect(calls).toEqual([
        { op: "setModel", arg: "custom:Ox-Alpha-0" },
        {
          op: "setConfigOption",
          arg: { configId: "reasoning_effort", value: "high" },
        },
      ]);
    }),
  );

  it.effect("fails explicitly when the selected model exposes no effort option", () =>
    Effect.gen(function* () {
      const { runtime, calls } = makeRuntime({
        configOptions: [
          {
            id: "model",
            name: "Model",
            category: "model",
            type: "select",
            currentValue: "composer-2",
            options: [{ value: "composer-2", name: "Composer 2" }],
          },
        ] as never,
      });
      const failure = yield* Effect.exit(
        applyDroidModelAndEffort({
          runtime,
          requestedModel: undefined,
          requestedEffort: "high",
        }),
      );
      expect(failure._tag).toBe("Failure");
      expect(calls).toEqual([]);
    }),
  );
});

describe("makeDroidCredentialRedactor", () => {
  it.effect("takes the instance's credentials out of a Droid error, and nothing else", () =>
    Effect.gen(function* () {
      // The capability Droid holds in place of a custom model's key, as the broker makes it.
      const broker = yield* makeDroidKeyBroker({
        connections: [
          {
            id: "gateway",
            name: "Gateway",
            protocol: "openai-completions",
            baseUrl: "http://127.0.0.1:9",
            credentialId: "gateway-credential",
            apiKey: Redacted.make("gateway-real-key-0123456789"),
            models: [],
          },
        ],
        isCurrent: () => true,
        retire: Effect.void,
      });
      const capability = broker.route("gateway")!.apiKey;
      const redact = makeDroidCredentialRedactor({
        environment: { FACTORY_API_KEY: "fk-live-0123456789abcdef", PATH: "/usr/bin" },
        sensitiveValues: ["gateway-token-0123456789", "gateway-token-0123456789-long", "on"],
      });
      expect(
        redact(
          `401 Invalid API key fk-live-0123456789abcdef for ${capability} via gateway-token-0123456789-long (gateway-token-0123456789) on /usr/bin`,
        ),
      ).toBe(
        "401 Invalid API key [redacted] for [redacted] via [redacted] ([redacted]) on /usr/bin",
      );
      // Without the instance's sensitive values, the environment's key and capabilities still go.
      expect(
        makeDroidCredentialRedactor({ environment: { FACTORY_API_KEY: "fk-live-0123456789" } })(
          `fk-live-0123456789 ${capability}`,
        ),
      ).toBe("[redacted] [redacted]");
      expect(makeDroidCredentialRedactor({})("nothing configured")).toBe("nothing configured");
    }).pipe(Effect.scoped),
  );
});
