import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import type { ModelReasoningMetadata } from "@t3tools/contracts";
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
  droidAccountCapabilitiesFromInitializeResult,
  droidCostMultiplierLabel,
  findDroidAutonomyOption,
  findSelectDroidConfigOption,
  hasDroidApiKeyEnvironment,
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
  it("labels unknown choices as runtime only and drops unsupported controls", () => {
    const efforts = [{ value: "high", label: "High", isDefault: true }];
    expect(buildDroidCapabilitiesFromEfforts(efforts, null).optionDescriptors).toEqual([
      expect.objectContaining({
        id: "reasoningEffort",
        label: "Reasoning",
        type: "select",
        strictSelection: true,
        options: [{ id: "high", label: "High", isDefault: true }],
      }),
    ]);
    expect(
      buildDroidCapabilitiesFromEfforts(efforts, { ...known, supported: false, levels: [] })
        .optionDescriptors,
    ).toEqual([
      expect.objectContaining({
        strictSelection: true,
        emptySelectionLabel: "Reasoning",
        options: [],
      }),
    ]);
  });
  it("does not dispatch stale efforts when a managed model has no reasoning choices", () => {
    for (const metadata of [null, { ...known, supported: false, levels: [] }]) {
      const caps = buildDroidCapabilitiesFromEfforts([], metadata);
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
  it.effect("keeps manual and budget-only unknown metadata as runtime-only controls", () =>
    Effect.gen(function* () {
      for (const source of ["manual", "provider"] as const) {
        const metadata: ModelReasoningMetadata = {
          ...known,
          status: "unknown",
          source,
          supported: true,
          levels: [],
          mode: "budget",
        };
        expect(
          buildDroidCapabilitiesFromEfforts(
            [{ value: "high", label: "High", isDefault: true }],
            metadata,
          ).optionDescriptors,
        ).toEqual([
          expect.objectContaining({
            id: "reasoningEffort",
            label: "Reasoning",
            type: "select",
            strictSelection: true,
            concreteReasoning: true,
            options: [{ id: "high", label: "High", isDefault: true }],
          }),
        ]);
        const { runtime } = makeRuntime();
        for (const requestedEffort of [undefined, "high"]) {
          yield* applyDroidModelAndEffort({
            runtime: { ...runtime, getReasoningMetadata: () => metadata },
            requestedModel: undefined,
            requestedEffort,
          });
        }
        expect(metadata.supported).toBe(true);
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
  it.effect("rejects explicit and inherited conflicts without remapping Droid sentinels", () =>
    Effect.gen(function* () {
      for (const requestedEffort of [undefined, "none", "max"]) {
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
    "allows implicit no-effort for nonreasoning models but rejects every explicit effort",
    () =>
      Effect.gen(function* () {
        const { runtime, calls } = makeRuntime();
        const managed = {
          ...runtime,
          getReasoningMetadata: () => ({ ...known, supported: false, levels: [] }),
        };
        yield* applyDroidModelAndEffort({
          runtime: managed,
          requestedModel: undefined,
          requestedEffort: undefined,
        });
        for (const requestedEffort of ["none", "off", "high"]) {
          expect(
            (yield* Effect.exit(
              applyDroidModelAndEffort({
                runtime: managed,
                requestedModel: undefined,
                requestedEffort,
              }),
            ))._tag,
          ).toBe("Failure");
        }
        expect(calls).toEqual([]);
      }),
  );
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
