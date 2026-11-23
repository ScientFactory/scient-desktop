// @effect-diagnostics nodeBuiltinImport:off -- opt-in corpus proof uses two installed Python environments and disposable files.
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeProcess from "node:process";

import * as NodeServices from "@effect/platform-node/NodeServices";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";
import * as Layer from "effect/Layer";
import {
  ComputeExecutionId,
  ComputeLanguageId,
  ComputeProjectId,
  ComputeSessionId,
} from "@scientfactory/compute";
import { describe, expect, it } from "@effect/vitest";

import * as ServerConfig from "../../../config.ts";
import * as OwnedLocalEndpoints from "../../../localEndpoints/OwnedLocalEndpointRegistry.ts";
import { ComputeSessionService } from "../../compute/ComputeSessionService.ts";
import * as LocalComputeStore from "../../compute/LocalComputeStore.ts";
import * as PythonComputeRuntime from "../../compute/PythonComputeRuntime.ts";
import * as LocalDuplexProcess from "../../execution/LocalDuplexProcess.ts";
import * as ComputeResults from "../ComputeResults.ts";
import * as LocalExecutionProcess from "../../execution/LocalExecutionProcess.ts";
import { makeResultsReader, publishScriptRun } from "../resultRevisions.ts";
import { processExists } from "../../execution/LocalProcessTestSupport.ts";
import { makeResultHandoff } from "./ResultHandoff.ts";
import { exportResultPackage } from "./exportResultPackage.ts";
import { hashBytes } from "./handoffFiles.ts";
import { notebookCode } from "./notebookSource.ts";
import { verifyResultPackage } from "./verifyResultPackage.ts";

const CORPUS = NodeProcess.env.HANDOFF_TEST_CORPUS;
const BASELINE = NodeProcess.env.HANDOFF_TEST_BASELINE;
const RECIPIENT = NodeProcess.env.HANDOFF_TEST_RECIPIENT;
const Live = LocalExecutionProcess.layer.pipe(Layer.provide(NodeServices.layer));

describe.runIf(Boolean(CORPUS && BASELINE && RECIPIENT))(
  "synthetic threshold handoff on a fresh Python environment",
  () => {
    it.live.each(["script", "notebook"] as const)("exports and verifies the threshold %s", (kind) =>
      Effect.gen(function* () {
        const temp = yield* Effect.acquireRelease(
          Effect.promise(async () =>
            NodeFSP.realpath(
              await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "scient-handoff-live-")),
            ),
          ),
          (path) => Effect.promise(() => NodeFSP.rm(path, { recursive: true, force: true })),
        );
        const { folder, env } = yield* Effect.promise(async () => {
          const root = NodePath.join(temp, "project");
          const staged = NodePath.join(temp, "staging");
          const layout = { computeDir: NodePath.join(temp, "state") };
          const scriptPath = kind === "script" ? "threshold.py" : "threshold.ipynb";
          await NodeFSP.cp(CORPUS!, root, { recursive: true });
          const source = await NodeFSP.readFile(NodePath.join(root, scriptPath), "utf8");
          let code = source;
          let recordedCells: ReadonlyArray<string> | undefined;
          if (kind === "notebook") {
            const cells = notebookCode(source);
            const effective = [cells[0] ?? "", "threshold = 0.7", ...cells.slice(1)];
            code = effective.join("\n");
            recordedCells = effective;
            const cleanNotebook = {
              nbformat: 4,
              nbformat_minor: 4,
              metadata: {},
              cells: effective.map((cell) => ({
                cell_type: "code",
                source: cell,
                metadata: {},
                outputs: [],
                execution_count: null,
              })),
            };
            await NodeFSP.writeFile(NodePath.join(root, scriptPath), JSON.stringify(cleanNotebook));
          }
          const env = {
            ...NodeProcess.env,
            MPLCONFIGDIR: NodePath.join(temp, "matplotlib"),
            SCIENT_RESULTS_DIR: staged,
            SCIENT_PARAMETERS: '{"threshold":0.7}',
          };
          NodeChildProcess.execFileSync(
            BASELINE!,
            kind === "script"
              ? [scriptPath]
              : [
                  "-c",
                  "import json; data = json.load(open('threshold.ipynb')); exec('\\n'.join(cell['source'] for cell in data['cells']))",
                ],
            { cwd: root, env },
          );
          const dataPath = "data/predictions.csv";
          const dataFile = NodePath.join(root, dataPath);
          const stat = await NodeFSP.stat(dataFile, { bigint: true });
          const published = await publishScriptRun(layout, {
            projectId: "project",
            root,
            stagingFolder: staged,
            succeeded: true,
            scriptPath,
            language: "Python",
            code,
            sessionId: "session",
            executionId: "execution",
            startedAt: null,
            finishedAt: "2026-11-23T00:00:00Z",
            threadId: undefined,
            runtime: { executable: BASELINE!, version: "3.12.13", fingerprint: null },
            reads: {
              files: [
                { path: dataFile, size: Number(stat.size), modifiedAtNs: stat.mtimeNs.toString() },
              ],
              truncated: false,
            },
          });
          if (published._tag !== "published") throw new Error(published.message);
          const revision = {
            ...published.revision,
            script: { ...published.revision.script, kind },
            inputs: {
              ...published.revision.inputs,
              files: published.revision.inputs.files.map((file) => ({
                ...file,
                origin: "declared" as const,
              })),
            },
            parameters: [{ name: "threshold", value: "0.7", source: "override" as const }],
            environment: {
              lockfiles: await Promise.all(
                ["requirements.txt", "uv.lock"].map(async (path) => ({
                  path,
                  sha256: hashBytes(await NodeFSP.readFile(NodePath.join(root, path))),
                })),
              ),
            },
          };
          const { folder } = await exportResultPackage({
            reader: makeResultsReader(layout, "project", root),
            revision,
            projectRoot: root,
            destination: temp,
            includeInputs: [dataPath],
            ...(recordedCells === undefined ? {} : { recordedCells }),
            createdAt: "2026-11-23T00:01:00Z",
            scientVersion: "0.0.0-test",
          });
          return { folder, env };
        });
        expect(
          yield* Effect.promise(() =>
            NodeFSP.readFile(NodePath.join(folder, "environment", "lockfiles", "uv.lock")),
          ),
        ).toEqual(yield* Effect.promise(() => NodeFSP.readFile(NodePath.join(CORPUS!, "uv.lock"))));
        const process = yield* LocalExecutionProcess.ExecutionProcess;
        const result = yield* verifyResultPackage(process, {
          packageFolder: folder,
          executable: RECIPIENT!,
          allowExecution: true,
        }).pipe(Effect.provideService(HostProcess.Environment, env));
        expect(result.report).toMatchObject({
          status: "verified",
          environment: { language: "Python", version: "3.12.13" },
        });
        expect(result.report.outputs.map(({ path, status }) => [path, status])).toEqual([
          ["confusion.csv", "matched"],
          ["metrics.json", "matched"],
          ["roc.png", "matched"],
        ]);
        if (kind === "script") {
          yield* Effect.promise(async () => {
            const path = NodePath.join(folder, "manifest.json");
            const manifest = JSON.parse(await NodeFSP.readFile(path, "utf8"));
            await NodeFSP.mkdir(NodePath.join(folder, "data", "data"));
            await NodeFSP.rename(
              NodePath.join(folder, "data", "predictions.csv"),
              NodePath.join(folder, "data", "data", "predictions.csv"),
            );
            await NodeFSP.writeFile(path, JSON.stringify({ ...manifest, version: 1 }));
          });
          const legacy = yield* verifyResultPackage(process, {
            packageFolder: folder,
            executable: RECIPIENT!,
            allowExecution: true,
          }).pipe(Effect.provideService(HostProcess.Environment, env));
          expect(legacy.report.status).toBe("verified");
          expect(legacy.report.files.some((file) => file.status === "unlisted")).toBe(false);
        }
        expect(result.report.outputs.find(({ path }) => path === "metrics.json")).toMatchObject({
          differenceCount: 0,
          maxAbsoluteError: { error: 0 },
          maxRelativeError: { error: 0 },
        });
        expect(
          JSON.parse(
            yield* Effect.promise(() =>
              NodeFSP.readFile(NodePath.join(folder, "outputs", "metrics.json"), "utf8"),
            ),
          ),
        ).toEqual({
          precision: 0.75,
          recall: 0.6,
          n: 10,
        });
      }).pipe(Effect.provide(Live)),
    );
  },
);

describe.runIf(Boolean(CORPUS && BASELINE && RECIPIENT))(
  "legacy reads from an in-project Python environment",
  () => {
    it.live("exports a real saved threshold result without requiring its runtime files", () =>
      Effect.gen(function* () {
        const temp = yield* Effect.acquireRelease(
          Effect.promise(async () =>
            NodeFSP.realpath(
              await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "scient-handoff-venv-")),
            ),
          ),
          (path) => Effect.promise(() => NodeFSP.rm(path, { recursive: true, force: true })),
        );
        const root = NodePath.join(temp, "project");
        const state = NodePath.join(temp, "state");
        const executable = NodePath.join(root, ".venv", "bin", "python");
        const scriptPath = "analyses/threshold.py";
        const code = yield* Effect.promise(async () => {
          await NodeFSP.cp(CORPUS!, root, { recursive: true });
          const moduleFolder = NodePath.join(root, "local_helpers");
          await NodeFSP.mkdir(moduleFolder);
          await NodeFSP.writeFile(
            NodePath.join(moduleFolder, "__init__.py"),
            "from .constants import marker\n",
          );
          await NodeFSP.writeFile(NodePath.join(moduleFolder, "constants.py"), "marker = 42\n");
          const script = NodePath.join(root, scriptPath);
          await NodeFSP.mkdir(NodePath.dirname(script));
          const source = await NodeFSP.readFile(NodePath.join(root, "threshold.py"), "utf8");
          await NodeFSP.writeFile(
            script,
            `from local_helpers import marker\nassert marker == 42\n${source}`,
          );
          NodeChildProcess.execFileSync("uv", ["sync", "--frozen", "--python", BASELINE!], {
            cwd: root,
            env: { ...NodeProcess.env, UV_PROJECT_ENVIRONMENT: NodePath.join(root, ".venv") },
          });
          NodeChildProcess.execFileSync(executable, ["-m", "compileall", "-q", "local_helpers"], {
            cwd: root,
          });
          return NodeFSP.readFile(script, "utf8");
        });
        const runtime = PythonComputeRuntime.layer.pipe(
          Layer.provide(LocalComputeStore.layer),
          Layer.provide(LocalExecutionProcess.layer),
          Layer.provide(LocalDuplexProcess.layer),
          Layer.provide(OwnedLocalEndpoints.layer),
        );
        const producer = ComputeResults.layer.pipe(
          Layer.provideMerge(runtime),
          Layer.provideMerge(ServerConfig.layerTest(root, state)),
          Layer.provide(NodeServices.layer),
        );
        const projectId = ComputeProjectId.make("threshold");
        const sessionId = ComputeSessionId.make("threshold-handoff");
        const executionId = ComputeExecutionId.make("threshold-execution");
        const { revisionId, computeDir } = yield* Effect.gen(function* () {
          const service = yield* ComputeSessionService;
          const results = yield* ComputeResults.ComputeResults;
          yield* service.startSession({
            projectId,
            sessionId,
            languageId: ComputeLanguageId.make("python"),
            label: "Python",
            workingDirectory: root,
            configuredExecutable: executable,
            runOnce: {
              executionId,
              code,
              publishResults: true,
              source: {
                _tag: "document",
                origin: "file",
                path: scriptPath,
                bufferState: "saved",
                revision: null,
                range: null,
              },
            },
          });
          const published = yield* results.publication(projectId, sessionId, executionId);
          if (published._tag !== "published") return yield* Effect.die(published.message);
          const config = yield* ServerConfig.ServerConfig;
          return { revisionId: published.summary.revision, computeDir: config.computeDir };
        }).pipe(Effect.provide(producer), Effect.timeout("60 seconds"));
        const layout = { computeDir };
        const folder = yield* Effect.promise(async () => {
          const reader = makeResultsReader(layout, projectId, root);
          const revision = (await reader.revisions()).find((item) => item.revision === revisionId);
          if (!revision) throw new Error("The Compute revision was not saved.");
          expect(revision.inputs.files.map(({ path }) => path).toSorted()).toEqual([
            "data/predictions.csv",
            "local_helpers/__init__.py",
            "local_helpers/constants.py",
          ]);
          // Older revisions can still contain runtime reads that the current recorder excludes.
          const runtimePath = ".venv/pyvenv.cfg";
          const runtimeFile = NodePath.join(root, runtimePath);
          const [bytes, stat] = await Promise.all([
            NodeFSP.readFile(runtimeFile),
            NodeFSP.stat(runtimeFile, { bigint: true }),
          ]);
          const legacyRevision = {
            ...revision,
            inputs: {
              ...revision.inputs,
              files: [
                ...revision.inputs.files,
                {
                  path: runtimePath,
                  size: bytes.length,
                  sha256: hashBytes(bytes),
                  modifiedAtNs: stat.mtimeNs.toString(),
                  changedDuringRun: false,
                  origin: "observed" as const,
                },
              ],
            },
          };
          const { folder } = await exportResultPackage({
            reader,
            revision: legacyRevision,
            projectRoot: root,
            destination: temp,
            includeInputs: ["data/predictions.csv"],
            createdAt: "2026-11-23T00:01:00Z",
            scientVersion: "0.0.0-test",
          });
          const manifest = JSON.parse(
            await NodeFSP.readFile(NodePath.join(folder, "manifest.json"), "utf8"),
          );
          expect(manifest).toMatchObject({
            version: 2,
            code: expect.arrayContaining([
              {
                path: "local_helpers/__init__.py",
                sha256: expect.any(String),
                size: expect.any(Number),
              },
              {
                path: "local_helpers/constants.py",
                sha256: expect.any(String),
                size: expect.any(Number),
              },
            ]),
            environment: { omittedRuntimeInputs: 1 },
          });
          await expect(
            NodeFSP.stat(NodePath.join(folder, "data", "predictions.csv")),
          ).resolves.toBeDefined();
          await expect(NodeFSP.stat(NodePath.join(folder, "data", "data"))).rejects.toMatchObject({
            code: "ENOENT",
          });
          expect(manifest.inputs.map((file: { path: string }) => file.path)).toEqual([
            "data/predictions.csv",
          ]);
          return folder;
        });
        const process = yield* LocalExecutionProcess.ExecutionProcess;
        const result = yield* verifyResultPackage(process, {
          packageFolder: folder,
          executable: RECIPIENT!,
          allowExecution: true,
        });
        expect(result.report.status).toBe("verified");
      }).pipe(Effect.provide(Live)),
    );
  },
);

describe.runIf(Boolean(RECIPIENT))("owned process cancellation", () => {
  it.live("stops the rerun and its child before publishing the cancelled report", () =>
    Effect.gen(function* () {
      const temp = yield* Effect.acquireRelease(
        Effect.promise(async () =>
          NodeFSP.realpath(
            await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "scient-handoff-cancel-")),
          ),
        ),
        (path) => Effect.promise(() => NodeFSP.rm(path, { recursive: true, force: true })),
      );
      const { folder, layout } = yield* Effect.promise(async () => {
        const root = NodePath.join(temp, "project");
        const stagingFolder = NodePath.join(temp, "staging");
        const layout = { computeDir: NodePath.join(temp, "state") };
        const code = [
          "import os, subprocess, sys, time",
          'child = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(600)"])',
          'print(f"OWNED {os.getpid()} {child.pid}", flush=True)',
          "time.sleep(600)",
        ].join("\n");
        await NodeFSP.mkdir(root);
        await NodeFSP.mkdir(stagingFolder);
        await NodeFSP.writeFile(NodePath.join(root, "analysis.py"), code);
        await NodeFSP.writeFile(NodePath.join(stagingFolder, "values.json"), '{"ok":1}');
        const published = await publishScriptRun(layout, {
          projectId: "project",
          root,
          stagingFolder,
          succeeded: true,
          scriptPath: "analysis.py",
          language: "Python",
          code,
          sessionId: "session",
          executionId: "execution",
          startedAt: null,
          finishedAt: "2026-11-23T00:00:00Z",
          threadId: undefined,
          runtime: { executable: RECIPIENT!, version: "3.12.13", fingerprint: null },
          reads: undefined,
        });
        if (published._tag !== "published") throw new Error(published.message);
        const { folder } = await exportResultPackage({
          reader: makeResultsReader(layout, "project", root),
          revision: published.revision,
          projectRoot: root,
          destination: temp,
          includeInputs: [],
          createdAt: "2026-11-23T00:01:00Z",
          scientVersion: "0.0.0-test",
        });
        return { folder, layout };
      });

      const native = yield* LocalExecutionProcess.ExecutionProcess;
      const running = yield* Deferred.make<readonly [number, number]>();
      const handoff = makeResultHandoff({
        layout,
        process: {
          start: (request) =>
            native.start(request).pipe(
              Effect.map((handle) => {
                if (request.environment.SCIENT_RESULTS_DIR === undefined) return handle;
                let text = "";
                return {
                  ...handle,
                  output: handle.output.pipe(
                    Stream.tap((chunk) => {
                      text += chunk.text;
                      const match = /OWNED (\d+) (\d+)\r?\n/u.exec(text);
                      return match === null
                        ? Effect.void
                        : Deferred.succeed(running, [Number(match[1]), Number(match[2])]);
                    }),
                  ),
                };
              }),
            ),
        },
        gateway: {
          project: () => Effect.die("Unused"),
          inspectRuntimes: () => Effect.die("Unused"),
          listAllExecutions: () => Effect.die("Unused"),
        },
      });
      const verificationId = "e29f4ff3-4af4-45e0-8cbc-11694558ac38";
      const verify = yield* handoff
        .verify({
          packageFolder: folder,
          executable: RECIPIENT!,
          allowExecution: true,
          verificationId,
          timeoutMinutes: 90,
        })
        .pipe(Effect.forkScoped);
      const [parent, child] = yield* Deferred.await(running).pipe(Effect.timeout("20 seconds"));
      expect(processExists(parent)).toBe(true);
      expect(processExists(child)).toBe(true);
      expect(yield* handoff.cancelVerification({ verificationId })).toEqual({ requested: true });
      const result = yield* Fiber.join(verify);
      expect(processExists(parent)).toBe(false);
      expect(processExists(child)).toBe(false);
      expect(result.report).toMatchObject({ status: "cancelled", timeoutMinutes: 90 });
      expect(
        yield* Effect.promise(async () =>
          JSON.parse(await NodeFSP.readFile(result.reportPath, "utf8")),
        ),
      ).toEqual(result.report);
      expect(yield* handoff.cancelVerification({ verificationId })).toEqual({ requested: false });
    }).pipe(Effect.provide(Live)),
  );
});
