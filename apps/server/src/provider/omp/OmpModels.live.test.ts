// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as OmpExecutableGate from "./OmpExecutableGate.ts";
import { ompLiveInstance, ompQualifyBinary, ompQualifyTarget } from "./OmpLive.testFixtures.ts";
import { makeOmpRpcProcess, OMP_ISOLATED_ARGS } from "./OmpRpcProcess.ts";

// Exercise the actual client decoder and v2 transport with a multi-provider
// catalog. All keys are synthetic; no model is called or user profile loaded.
describe.runIf(ompQualifyBinary)("real Oh My Pi model discovery", () => {
  it.effect(
    "decodes native image and text capabilities across a large catalog",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const root = NodeFS.mkdtempSync(
            NodePath.join(NodeOS.tmpdir(), "scient-omp-models-live-"),
          );
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => NodeFS.rmSync(root, { recursive: true, force: true })),
          );
          const { environment } = ompLiveInstance(root, {
            blockEgress: true,
            baseEnv: {
              PATH: process.env.PATH ?? "",
              ANTHROPIC_API_KEY: "synthetic-catalog-key",
              OPENAI_API_KEY: "synthetic-catalog-key",
              GEMINI_API_KEY: "synthetic-catalog-key",
              GROQ_API_KEY: "synthetic-catalog-key",
              MISTRAL_API_KEY: "synthetic-catalog-key",
              OPENROUTER_API_KEY: "synthetic-catalog-key",
              XAI_API_KEY: "synthetic-catalog-key",
            },
          });
          const extensionPath = NodePath.join(root, "unknown-context.mjs");
          // A non-finite capacity survives registration and serializes to the same
          // null field returned by native discovered-model caches.
          NodeFS.writeFileSync(
            extensionPath,
            `export default (pi) => {
          pi.registerProvider("scient_catalog_test", {
            baseUrl: "http://127.0.0.1:9", api: "openai-completions", apiKey: "synthetic-key",
            models: [{ id: "unknown-context", name: "Unknown context", contextWindow: Number.NaN,
              maxTokens: 4096, reasoning: false, input: ["text", "image"],
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
          });
        };`,
          );
          const client = yield* makeOmpRpcProcess({
            target: ompQualifyTarget,
            command: ompQualifyBinary!,
            cwd: root,
            env: environment,
            extraArgs: [...OMP_ISOLATED_ARGS, "--extension", extensionPath],
          });
          yield* client.ready;
          const { models } = yield* client.getModels();
          expect(models.length).toBeGreaterThan(100);
          expect(models.find((model) => model.provider === "scient_catalog_test")).toMatchObject({
            id: "unknown-context",
            contextWindow: null,
            input: ["text", "image"],
          });
          expect(models.some((model) => model.input?.includes("image"))).toBe(true);
          expect(
            models.some((model) => model.input?.includes("text") && !model.input.includes("image")),
          ).toBe(true);
        }),
      ).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, OmpExecutableGate.layer))),
    60_000,
  );
});
