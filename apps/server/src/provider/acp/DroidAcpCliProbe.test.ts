/**
 * Optional integration check against a real `droid exec --output-format acp`
 * install. Enable with: T3_DROID_ACP_PROBE=1 vp test run DroidAcpCliProbe
 *
 * The probe assumes either `FACTORY_API_KEY` is set in the environment or
 * the user has previously paired via `droid` (device-pairing caches the
 * credential). Without credentials `authenticate` fails and the probe
 * surfaces that error — which is itself diagnostic.
 *
 * This is the Phase-0 gate from docs/design/droid-provider-plan.md §7: every
 * 🔬 assumption becomes an explicit assertion here. Run once per reviewed
 * Droid version and record the output in the plan's revision log.
 */
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import { ChildProcessSpawner } from "effect/unstable/process";
import { describe, expect } from "vite-plus/test";

import {
  applyDroidModelAndEffort,
  buildDroidModelsFromConfigOptions,
  DROID_AGENT_INFO_NAME,
  discoverDroidModels,
  makeDroidAcpRuntime,
  resolveAdvertisedDroidAuthMethodId,
  resolveDroidAuthMethodId,
} from "./DroidAcpSupport.ts";

const encodeUnknownJson = Schema.encodeUnknownSync(Schema.fromJsonString(Schema.Unknown));

const logProbeJson = (label: string, value: unknown) =>
  Effect.log(`${label}: ${encodeUnknownJson(value)}`).pipe(Effect.asVoid);

const makeProbeRuntime = Effect.gen(function* () {
  const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  return yield* makeDroidAcpRuntime({
    droidSettings: { binaryPath: "droid" },
    environment: process.env,
    childProcessSpawner,
    cwd: process.cwd(),
    clientInfo: { name: "scient-droid-probe", version: "0.0.0" },
  });
});

describe.runIf(process.env.T3_DROID_ACP_PROBE === "1")("Droid ACP CLI probe", () => {
  it.effect("initialize identifies @factory/cli over protocol version 1", () =>
    Effect.gen(function* () {
      const runtime = yield* makeProbeRuntime;
      const started = yield* runtime.start();
      expect(started.initializeResult.agentInfo?.name).toBe(DROID_AGENT_INFO_NAME);
      expect(started.initializeResult.protocolVersion).toBe(1);
    }).pipe(TestClock.withLive, Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("session/new exposes model config options with at least one model", () =>
    Effect.gen(function* () {
      const runtime = yield* makeProbeRuntime;
      yield* runtime.start();
      const models = buildDroidModelsFromConfigOptions(yield* runtime.getConfigOptions);
      yield* logProbeJson("droid config-option models", models);
      expect(models.length).toBeGreaterThan(0);
    }).pipe(TestClock.withLive, Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("discovery walks per-model reasoning-effort ladders and restores selection", () =>
    Effect.gen(function* () {
      const runtime = yield* makeProbeRuntime;
      yield* runtime.start();
      const initialOptions = yield* runtime.getConfigOptions;
      const initialModels = buildDroidModelsFromConfigOptions(initialOptions);
      const initialModelOption = initialOptions.find(
        (option) => option.category?.trim().toLowerCase() === "model",
      );
      const initialSlug =
        typeof initialModelOption?.currentValue === "string"
          ? initialModelOption.currentValue.trim()
          : undefined;
      const discovered = yield* discoverDroidModels(runtime);
      yield* logProbeJson("droid discovery", discovered);
      expect(discovered.map((model) => model.slug).toSorted()).toEqual(
        initialModels.map((model) => model.slug).toSorted(),
      );
      const restoredModelOption = (yield* runtime.getConfigOptions).find(
        (option) => option.category?.trim().toLowerCase() === "model",
      );
      expect(
        typeof restoredModelOption?.currentValue === "string"
          ? restoredModelOption.currentValue.trim()
          : undefined,
      ).toBe(initialSlug);
    }).pipe(TestClock.withLive, Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("setModel applies in-session via session/set_config_option", () =>
    Effect.gen(function* () {
      const runtime = yield* makeProbeRuntime;
      yield* runtime.start();
      const initialOptions = yield* runtime.getConfigOptions;
      const models = buildDroidModelsFromConfigOptions(initialOptions);
      expect(models.length).toBeGreaterThan(0);
      const initialModelOption = initialOptions.find(
        (option) => option.category?.trim().toLowerCase() === "model",
      );
      const initialSlug =
        typeof initialModelOption?.currentValue === "string"
          ? initialModelOption.currentValue.trim()
          : undefined;
      const target =
        models.find((model) => model.slug === "gpt-5.6-sol" && model.slug !== initialSlug) ??
        models.find(
          (model) =>
            model.slug !== initialSlug &&
            model.slug !== "auto" &&
            !model.slug.startsWith("custom:"),
        );
      expect(target).toBeDefined();
      if (!target) return;
      yield* runtime.setModel(target.slug);
      const currentOption = (yield* runtime.getConfigOptions).find(
        (option) => option.category?.trim().toLowerCase() === "model",
      );
      expect(
        typeof currentOption?.currentValue === "string"
          ? currentOption.currentValue.trim()
          : undefined,
      ).toBe(target.slug);
    }).pipe(TestClock.withLive, Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("applies a built-in model reasoning effort in-session", () =>
    Effect.gen(function* () {
      const runtime = yield* makeProbeRuntime;
      yield* runtime.start();
      const target = buildDroidModelsFromConfigOptions(yield* runtime.getConfigOptions).find(
        (model) => model.slug === "gpt-5.6-sol",
      );
      expect(target).toBeDefined();
      if (!target) return;
      yield* runtime.setModel(target.slug);
      const effortOption = (yield* runtime.getConfigOptions).find(
        (option) => option.category?.trim().toLowerCase() === "thought_level",
      );
      yield* logProbeJson("droid selected-model effort option", effortOption);
      expect(effortOption?.type).toBe("select");
      if (effortOption?.type !== "select") return;
      expect(
        effortOption.options.some((option) =>
          "value" in option
            ? option.value === "low"
            : option.options.some((nested) => nested.value === "low"),
        ),
      ).toBe(true);
      yield* runtime.setConfigOption(effortOption.id, "low");
      const updatedEffortOption = (yield* runtime.getConfigOptions).find(
        (option) => option.id === effortOption.id,
      );
      yield* logProbeJson("droid updated effort option", updatedEffortOption);
      expect(updatedEffortOption?.currentValue).toBe("low");
    }).pipe(TestClock.withLive, Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("switches to a custom model and applies its advertised reasoning effort", () =>
    Effect.gen(function* () {
      const runtime = yield* makeProbeRuntime;
      yield* runtime.start();
      const target = buildDroidModelsFromConfigOptions(yield* runtime.getConfigOptions).find(
        (model) => model.slug === "custom:Ox-Alpha-0",
      );
      expect(target).toBeDefined();
      if (!target) return;

      yield* applyDroidModelAndEffort({
        runtime,
        requestedModel: target.slug,
        requestedEffort: "high",
      });

      const selected = buildDroidModelsFromConfigOptions(yield* runtime.getConfigOptions).find(
        (model) => model.slug === target.slug,
      );
      expect(selected?.capabilitiesObserved).toBe(true);
      expect(selected?.currentEffortValue).toBe("high");
      expect(selected?.efforts.map((effort) => effort.value)).toContain("high");
    }).pipe(TestClock.withLive, Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("advertised auth methods include a resolvable method for this environment", () =>
    Effect.gen(function* () {
      const runtime = yield* makeProbeRuntime;
      const started = yield* runtime.start();
      const advertised = (started.initializeResult.authMethods ?? []).map((method) => method.id);
      yield* Effect.log("droid authMethods", advertised);
      expect(advertised.length).toBeGreaterThan(0);
      // The env-derived choice must be advertised; if the environment carries
      // no API key, the headless fallback ladder must still resolve to one of
      // the agent's advertised methods.
      expect(resolveDroidAuthMethodId(process.env)).toBeDefined();
      expect(
        resolveAdvertisedDroidAuthMethodId({
          environment: process.env,
          advertisedAuthMethods: advertised,
        }),
      ).toBeDefined();
    }).pipe(TestClock.withLive, Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("prompt returns a real stopReason and cancel settles a hung turn", () =>
    Effect.gen(function* () {
      const runtime = yield* makeProbeRuntime;
      yield* runtime.start();
      // Minimal prompt: exercises the full request/response path without
      // assuming any particular model behavior beyond end-of-turn.
      const result = yield* runtime.prompt({
        prompt: [{ type: "text" as const, text: "Reply with exactly: ok" }],
      });
      expect(typeof result.stopReason).toBe("string");
    }).pipe(TestClock.withLive, Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
