// @effect-diagnostics nodeBuiltinImport:off -- opts in to a provided fixture and native Python.
import * as NodeProcess from "node:process";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { initializeScientProject } from "@scientfactory/project-init";
import { DEFAULT_SERVER_SETTINGS } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";

import * as ServerConfig from "../../config.ts";
import * as OwnedLocalEndpoints from "../../localEndpoints/OwnedLocalEndpointRegistry.ts";
import * as WorkspaceEntries from "../../workspace/WorkspaceEntries.ts";
import * as WorkspaceFileSystem from "../../workspace/WorkspaceFileSystem.ts";
import * as WorkspacePaths from "../../workspace/WorkspacePaths.ts";
import { makeComputeNotebookOutputs } from "../compute/ComputeNotebookOutputs.ts";
import { makeComputeRpcGateway } from "../compute/ComputeRpcGateway.ts";
import { ComputeSessionService } from "../compute/ComputeSessionService.ts";
import { computeWorkspaceResolverForTest } from "../compute/ComputeWorkspaceTestUtils.ts";
import * as LocalComputeStore from "../compute/LocalComputeStore.ts";
import * as PythonComputeRuntime from "../compute/PythonComputeRuntime.ts";
import * as LocalDuplexProcess from "../execution/LocalDuplexProcess.ts";
import * as LocalExecutionProcess from "../execution/LocalExecutionProcess.ts";
import { makeNotebookRunJobs } from "../notebook/NotebookRunJobs.ts";
import { makeNotebookStore } from "../notebook/NotebookStore.ts";
import { makeNotebookRuns } from "../notebook/notebookRuns.ts";
import { layerKnownWorkspacesAllowAll } from "../workspace/knownWorkspaces.testkit.ts";
import { ComputeResults, layer as resultsLayer } from "./ComputeResults.ts";
import { makeResultOperations } from "./resultOperations.ts";
import { makeResultsReader } from "./resultRevisions.ts";

const python = NodeProcess.env.SCIENT_TEST_PYTHON;
const fixture = NodeProcess.env.SCIENT_TEST_THRESHOLD_PROJECT;

describe.runIf(Boolean(python && fixture))("recorded Python result freshness", () => {
  it.live("keeps script and notebook results current across unrelated root changes", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const instance = yield* fs.makeTempDirectoryScoped({ prefix: "scient-freshness-" });
      const cwd = `${instance}/project`;
      yield* fs.copy(fixture!, cwd);
      yield* Effect.promise(() => initializeScientProject({ root: cwd }));

      const config = ServerConfig.layerTest(cwd, `${instance}/state`);
      const compute = PythonComputeRuntime.layer.pipe(
        Layer.provide(LocalComputeStore.layer),
        Layer.provide(LocalExecutionProcess.layer),
        Layer.provide(LocalDuplexProcess.layer),
        Layer.provide(OwnedLocalEndpoints.layer),
        Layer.provide(config),
        Layer.provide(NodeServices.layer),
      );
      const paths = WorkspacePaths.layer;
      const files = WorkspaceFileSystem.layer.pipe(
        Layer.provide(layerKnownWorkspacesAllowAll),
        Layer.provide(WorkspaceEntries.layer.pipe(Layer.provide(paths))),
        Layer.provide(paths),
        Layer.provide(config),
        Layer.provide(NodeServices.layer),
      );
      const layers = Layer.mergeAll(
        compute,
        files,
        paths,
        config,
        resultsLayer.pipe(Layer.provide(compute), Layer.provide(config)),
      );
      yield* Effect.gen(function* () {
        const computeService = yield* ComputeSessionService;
        const workspace = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const { computeDir } = yield* ServerConfig.ServerConfig;
        const gateway = makeComputeRpcGateway({
          workspaceResolver: computeWorkspaceResolverForTest,
          compute: computeService,
          workspaceFileSystem: workspace,
          serverSettings: {
            getSettings: Effect.succeed({
              ...DEFAULT_SERVER_SETTINGS,
              scientificComputing: {
                schemaVersion: 1,
                languages: { python: { executable: python! } },
              },
            }),
          },
        });
        const notebooks = makeNotebookRuns({
          computeDir,
          jobs: yield* makeNotebookRunJobs,
          workspacePaths: yield* WorkspacePaths.WorkspacePaths,
          gateway,
          notebooks: yield* makeNotebookStore,
          notebookOutputs: makeComputeNotebookOutputs({
            gateway,
            compute: computeService,
            fileSystem: fs,
          }),
        });
        const results = yield* ComputeResults;
        const operations = makeResultOperations({
          gateway,
          results,
          runNotebookFresh: notebooks.run,
          runtimeDescriptors: computeService.runtimeDescriptors,
          workspace,
        });
        const project = yield* gateway.project({ cwd });
        const reader = () => makeResultsReader({ computeDir }, project.projectId, project.root);
        const publish = Effect.fn("FreshnessTest.publish")(function* (
          scriptPath: string,
          expectedDirectories: ReadonlyArray<string> = [],
        ) {
          const result = yield* operations.rerun({
            cwd,
            scriptPath,
            parameters: { threshold: "0.5" },
          });
          if (result._tag !== "published") return yield* Effect.die(result.message);
          const stored = (yield* Effect.promise(() => reader().revisions())).find(
            ({ revision }) => revision === result.summary.revision,
          );
          if (stored === undefined) return yield* Effect.die("Published revision was not stored.");
          expect(stored.inputs.files.map(({ path }) => path)).toContain("data/predictions.csv");
          expect(stored.inputs.files.map(({ path }) => path)).not.toContain("scratch.txt");
          expect(stored.inputs.directories?.map(({ path }) => path) ?? []).toEqual(
            expectedDirectories,
          );
          return stored;
        });

        const script = yield* publish("threshold.py");
        expect(script.inputs.truncated).toBe(false);
        expect(script.inputs.outsideDataPaths).toEqual([]);
        const scriptSummary = yield* Effect.promise(() => reader().summary(script));
        expect(scriptSummary.inputCoverageIncomplete).toBeUndefined();
        expect(scriptSummary.inputs).toEqual(["data/predictions.csv"]);
        const confusion = yield* results.preview(project, script.revision, "confusion.csv");
        expect(confusion).toMatchObject({
          _tag: "table",
          columns: [
            { name: "actual", type: "text" },
            { name: "predicted_positive", type: "integer" },
            { name: "predicted_negative", type: "integer" },
          ],
        });
        yield* fs.writeFileString(`${cwd}/notes.md`, "An unrelated file.\n");
        yield* fs.makeDirectory(`${cwd}/assets/results`, { recursive: true });
        const source = yield* fs.readFileString(`${cwd}/threshold.py`);
        yield* fs.writeFileString(
          `${cwd}/scratch.py`,
          source +
            '\nPath("scratch.txt").write_text("scratch")\nassert Path("scratch.txt").read_text() == "scratch"\n',
        );
        const scratch = yield* publish("scratch.py");
        const notebookPath = `${cwd}/threshold.ipynb`;
        const sourceNotebook = JSON.parse(yield* fs.readFileString(notebookPath)) as {
          cells: Array<unknown>;
        };
        for (const [id, source] of [
          [
            "read-scratch",
            'from pathlib import Path\nassert Path("scratch.txt").read_text() == "scratch"',
          ],
          ["replace-scratch", 'Path("scratch.txt").write_text("updated after reading")'],
          ["read-again", 'assert Path("scratch.txt").read_text() == "updated after reading"'],
        ]) {
          sourceNotebook.cells.push({
            id,
            cell_type: "code",
            metadata: {},
            execution_count: null,
            outputs: [],
            source,
          });
        }
        yield* fs.writeFileString(notebookPath, JSON.stringify(sourceNotebook));
        const notebook = yield* publish("threshold.ipynb");
        expect(yield* fs.exists(`${cwd}/scratch.txt`)).toBe(true);
        yield* fs.remove(`${cwd}/scratch.txt`);
        yield* fs.writeFileString(
          `${cwd}/list-project.py`,
          source + '\nassert "threshold.py" in os.listdir(".")\n',
        );
        const listed = yield* publish("list-project.py", ["."]);
        expect((yield* Effect.promise(() => reader().summary(listed))).causes).toEqual([]);
        yield* fs.writeFileString(`${cwd}/another.txt`, "Still unrelated.\n");
        expect((yield* Effect.promise(() => reader().summary(listed))).causes).toEqual([
          { kind: "input-changed", path: "." },
        ]);
        const legacy = {
          ...listed,
          inputs: { ...listed.inputs, directoryListingVersion: 2 as const },
        };
        const legacySummary = yield* Effect.promise(() => reader().summary(legacy));
        expect(legacySummary.causes).toEqual([]);
        expect(legacySummary.observedDirectories).toEqual([]);
        for (const revision of [script, scratch, notebook]) {
          expect((yield* Effect.promise(() => reader().summary(revision))).causes).toEqual([]);
        }
        yield* fs.remove(`${cwd}/uv.lock`);
        for (const revision of [script, scratch, notebook]) {
          expect((yield* Effect.promise(() => reader().summary(revision))).causes).toEqual([
            { kind: "lockfile-changed", path: "uv.lock" },
          ]);
        }
        const failed = yield* operations.rerun({
          cwd,
          scriptPath: "threshold.py",
          parameters: { threshold: "1.1" },
        });
        expect(failed._tag).toBe("failed");
        const failure = yield* Effect.promise(() => reader().lastAttempt("threshold.py"));
        if (failure === null) return yield* Effect.die("The failed attempt was not stored.");
        const output = yield* operations.attemptOutput({
          cwd,
          scriptPath: "threshold.py",
          finishedAt: failure.finishedAt,
        });
        expect(output.parameters).toEqual([
          { name: "threshold", value: "1.1", source: "override" },
        ]);
        expect(output.output.outputs).toContainEqual(
          expect.objectContaining({
            _tag: "diagnostic",
            diagnostic: expect.objectContaining({ errorName: "ValueError" }),
          }),
        );
      }).pipe(Effect.provide(layers));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
