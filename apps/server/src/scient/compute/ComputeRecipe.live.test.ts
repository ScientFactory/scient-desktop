// @effect-diagnostics nodeBuiltinImport:off -- isolated native provisioner qualification.
import * as NodePath from "node:path";
import * as NodeProcess from "node:process";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as LocalExecutionProcess from "../execution/LocalExecutionProcess.ts";
import { sanitizeComputeEnvironment } from "./ComputeEnvironmentPolicy.ts";
import { recipeHash, type ComputeRecipeCatalog } from "./ComputeRecipe.ts";
import {
  bundledRecipes,
  COMPUTE_CATALOG_URL,
  makeComputeRecipeSource,
} from "./ComputeRecipeSource.ts";
import { makeManagedPythonEnvironmentManager } from "./ManagedPythonEnvironment.ts";
import { makeManagedPythonProvisioner } from "./ManagedPythonProvisioner.ts";
import { makeManagedPythonRuntimeController } from "./ManagedPythonRuntimeController.ts";
import { makeSpawnProbe } from "./PythonComputeRuntime.ts";
import { PYTHON_DATA_AND_FIGURES_TOOLKIT } from "./PythonToolkitCatalog.ts";

describe.runIf(NodeProcess.env.SCIENT_TEST_MANAGED_PYTHON === "1")(
  "live qualified recipe transaction",
  () => {
    it.live(
      "installs a fetched recipe directly, preserves an in-use generation on Update, and rejects corruption",
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const computeDir = yield* fs.makeTempDirectoryScoped({ prefix: "scient-recipe-live-" });
          const specDirectory = NodePath.join(import.meta.dirname, "managed-python");
          const project = yield* fs.readFileString(NodePath.join(specDirectory, "pyproject.toml"));
          const lock = yield* fs.readFileString(NodePath.join(specDirectory, "uv.lock"));
          const baseline = bundledRecipes.recipes[0]!;
          const changed = `${project}\n# Immutable qualification fixture\n`;
          const candidate = {
            ...baseline,
            revision: baseline.revision + 1,
            toolkitRevision: "scientific-python-2099-01-01.1",
            sourceCommit: "a".repeat(40),
            projectSha256: recipeHash(changed),
          };
          let clock = 1000;
          let feed: ComputeRecipeCatalog = {
            schemaVersion: 1,
            sequence: 2,
            withdrawn: [],
            recipes: [candidate],
          };
          const recipes = makeComputeRecipeSource({
            computeDir,
            specDirectory,
            purpose: "python",
            target: `${NodeProcess.platform}-${NodeProcess.arch}`,
            now: () => clock,
            fetch: async (url) =>
              new Response(
                url === COMPUTE_CATALOG_URL
                  ? JSON.stringify(feed)
                  : url.endsWith("uv.lock")
                    ? lock
                    : changed,
              ),
          });
          const processes = yield* LocalExecutionProcess.ExecutionProcess;
          const { environment } = sanitizeComputeEnvironment(
            Object.fromEntries(
              Object.entries(NodeProcess.env).filter(
                (entry): entry is [string, string] => entry[1] !== undefined,
              ),
            ),
          );
          const spawnProbe = yield* makeSpawnProbe(processes, { environment, cwd: computeDir });
          const manager = makeManagedPythonEnvironmentManager(
            computeDir,
            makeManagedPythonProvisioner({
              computeDir,
              specDirectory,
              processes,
              spawnProbe,
              environment,
              platform: NodeProcess.platform,
              arch: NodeProcess.arch,
            }),
            "python",
            { trackUsage: true },
          );
          const controller = makeManagedPythonRuntimeController({
            manager,
            recipes,
            toolkitIds: [PYTHON_DATA_AND_FIGURES_TOOLKIT.toolkitId],
          });
          const settle = Effect.gen(function* () {
            for (let attempt = 0; attempt < 6000; attempt++) {
              const status = yield* controller.status();
              if (status.operation === null) return status;
              yield* Effect.sleep("50 millis");
            }
            return yield* Effect.die("Recipe transaction did not settle.");
          });
          try {
            yield* controller.manage("install");
            const installed = yield* settle;
            expect(installed.failureMessage).toBeNull();
            expect(installed.toolkitRevision).toBe(candidate.toolkitRevision);
            const first = yield* Effect.promise(() => manager.inspect());
            expect(first?.record.active.recipe?.projectSha256).toBe(recipeHash(changed));
            const release = yield* Effect.promise(() => manager.acquire(first!.executable));
            try {
              const newer = {
                ...candidate,
                revision: candidate.revision + 1,
                toolkitRevision: "scientific-python-2099-01-02.1",
              };
              feed = { ...feed, sequence: 3, recipes: [newer] };
              clock += 3_600_001;
              yield* Effect.promise(() => recipes.refresh());
              expect((yield* controller.status()).updateAvailable).toBe(true);
              yield* controller.manage("update");
              const updated = yield* settle;
              expect(updated.failureMessage).toBeNull();
              expect(updated.toolkitRevision).toBe(newer.toolkitRevision);
              expect(updated.generationId).not.toBe(installed.generationId);
              expect(yield* fs.exists(first!.executable)).toBe(true);
              const verified = yield* Effect.promise(() => manager.inspect());
              const restored = makeManagedPythonEnvironmentManager(computeDir, {
                provision: async () => {
                  throw new Error("Receipt inspection must not provision.");
                },
                verify: async () => {},
              });
              expect(
                (yield* Effect.promise(() => restored.inspect()))?.record.active.recipe,
              ).toEqual(newer);
              feed = {
                ...feed,
                sequence: 4,
                recipes: [
                  { ...newer, revision: newer.revision + 1, projectSha256: "f".repeat(64) },
                ],
              };
              clock += 3_600_001;
              yield* controller.manage("update");
              const rejected = yield* settle;
              expect(rejected.failureMessage).toContain("integrity");
              expect(rejected.generationId).toBe(updated.generationId);
              expect(yield* fs.exists(verified!.executable)).toBe(true);
            } finally {
              release();
            }
          } finally {
            controller.dispose();
            yield* Effect.promise(() => manager.collect());
          }
        }).pipe(
          Effect.scoped,
          Effect.provide(LocalExecutionProcess.layer.pipe(Layer.provideMerge(NodeServices.layer))),
        ),
      600_000,
    );
  },
);
