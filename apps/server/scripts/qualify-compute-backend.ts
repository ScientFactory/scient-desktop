// @effect-diagnostics nodeBuiltinImport:off -- opt-in native qualification CLI.
/**
 * Runs an external Compute corpus through the real Scient gateway, durable
 * service, selected native runtime, retained-output store, and cleanup path.
 *
 * This is intentionally opt-in: it executes arbitrary corpus code and may use
 * licensed runtimes. It never installs software or mutates the selected
 * runtime.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeProcess from "node:process";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { initializeScientProject } from "@scientfactory/project-init";
import {
  ComputeExecutionId,
  ComputeLanguageId,
  ComputeSessionId,
  TERMINAL_COMPUTE_EXECUTION_STATUSES,
  type ComputeProjectId,
  type ComputeSessionGeneration,
} from "@scientfactory/compute";
import { DEFAULT_SERVER_SETTINGS } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import * as ServerConfig from "../src/config.ts";
import * as OwnedLocalEndpoints from "../src/localEndpoints/OwnedLocalEndpointRegistry.ts";
import * as ServerSettings from "../src/serverSettings.ts";
import * as WorkspaceEntries from "../src/workspace/WorkspaceEntries.ts";
import * as WorkspaceFileSystem from "../src/workspace/WorkspaceFileSystem.ts";
import * as WorkspacePaths from "../src/workspace/WorkspacePaths.ts";
import * as LocalAnalysisStore from "../src/scient/analysis/LocalAnalysisStore.ts";
import * as LocalDuplexProcess from "../src/scient/execution/LocalDuplexProcess.ts";
import * as LocalExecutionProcess from "../src/scient/execution/LocalExecutionProcess.ts";
import * as ComputeSessionService from "../src/scient/compute/ComputeSessionService.ts";
import { makeComputeRpcGateway } from "../src/scient/compute/ComputeRpcGateway.ts";
import { computeWorkspaceResolverForTest } from "../src/scient/compute/ComputeWorkspaceTestUtils.ts";
import * as LocalComputeStore from "../src/scient/compute/LocalComputeStore.ts";
import { matlabRuntimeBinding } from "../src/scient/compute/MatlabComputeRuntime.ts";
import { pythonRuntimeBinding } from "../src/scient/compute/PythonComputeRuntime.ts";
import * as ScientificRuntimePreferences from "../src/scient/compute/ScientificRuntimePreferences.ts";

const Language = Schema.Literals(["python", "matlab"]);
type Language = typeof Language.Type;
const NonNegativeInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const ManifestEntry = Schema.Struct({
  path: Schema.String,
  language: Language,
  role: Schema.Literals(["test", "helper"]),
  purpose: Schema.String,
  markers: Schema.Array(Schema.String),
  expectedDiagnostic: Schema.optional(
    Schema.Struct({
      errorName: Schema.optional(Schema.String),
      messageIncludes: Schema.optional(Schema.String),
    }),
  ),
  minimumDisplays: Schema.optional(NonNegativeInt),
  minimumResources: Schema.optional(NonNegativeInt),
});
type ManifestEntry = typeof ManifestEntry.Type;
const CorpusManifest = Schema.Struct({ tests: Schema.Array(ManifestEntry) });
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const arguments_ = NodeProcess.argv.slice(2);
if (arguments_[0] === "--") arguments_.shift();
const [languageInput, executableInput, qaRootInput, evidenceDirInput] = arguments_;
if (
  arguments_.length !== 4 ||
  (languageInput !== "python" && languageInput !== "matlab") ||
  !executableInput ||
  !qaRootInput ||
  !evidenceDirInput
) {
  throw new Error(
    "Usage: node qualify-compute-backend.ts <python|matlab> <executable> <corpus-root> <new-evidence-dir>",
  );
}
const language = languageInput;
const executable = NodePath.resolve(executableInput);
const qaRoot = NodePath.resolve(qaRootInput);
const evidenceDir = NodePath.resolve(evidenceDirInput);

const languageId = ComputeLanguageId.make(language);
const infrastructurePatterns = [
  "DELIM not in msg_list",
  "Bad pipe message",
  "tornado.general",
  "ZMQStream callback",
];
const expectedError = (entry: ManifestEntry) => entry.expectedDiagnostic !== undefined;
const interruptCase = (path: string) =>
  path.includes("/python_interrupt_") || path.includes("/matlab_interrupt_");
const parallelCase = (path: string) => path.includes("parallel_session_");
const markerLine = language === "python" ? /^# %%/mu : /^%%/mu;

type SourceRange = {
  readonly startLine: number;
  readonly startColumn: number;
  readonly endLine: number;
  readonly endColumn: number;
};

function rangeForLines(
  lines: ReadonlyArray<string>,
  startLine: number,
  endExclusive: number,
): SourceRange {
  const endLine = Math.max(startLine, endExclusive - 1);
  return { startLine, startColumn: 0, endLine, endColumn: lines[endLine]?.length ?? 0 };
}

function splitFirstSection(source: string): {
  first: string;
  firstRange: SourceRange | null;
  recovery: string | null;
  recoveryRange: SourceRange | null;
} {
  const lines = source.split("\n");
  const sectionStarts = lines.flatMap((line, index) => (markerLine.test(line) ? [index] : []));
  if (sectionStarts.length < 2) {
    return { first: source, firstRange: null, recovery: null, recoveryRange: null };
  }
  const recoveryStart = sectionStarts[1]!;
  return {
    first: lines.slice(sectionStarts[0], recoveryStart).join("\n"),
    firstRange: rangeForLines(lines, sectionStarts[0]!, recoveryStart),
    recovery: lines.slice(recoveryStart).join("\n"),
    recoveryRange: rangeForLines(lines, recoveryStart, lines.length),
  };
}

function processExists(pid: number | null | undefined): boolean {
  if (!pid) return false;
  try {
    NodeProcess.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function safeLabel(path: string): string {
  return path.replaceAll("/", "__").replaceAll(/[^a-zA-Z0-9_.-]/gu, "-");
}

try {
  await NodeFSP.access(evidenceDir);
  throw new Error(`Evidence directory already exists: ${evidenceDir}`);
} catch (cause) {
  if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
}
await NodeFSP.mkdir(evidenceDir, { recursive: true });
const manifest = Schema.decodeSync(Schema.fromJsonString(CorpusManifest))(
  await NodeFSP.readFile(NodePath.join(qaRoot, "suite-manifest.json"), "utf8"),
);
const tests = manifest.tests.filter(
  (entry) => entry.language === language && entry.role === "test",
);
const reports: Array<Record<string, unknown>> = [];
const repositoryRoot = NodePath.resolve(import.meta.dirname, "../../..");
const candidateRevision = NodeChildProcess.execFileSync("git", ["rev-parse", "HEAD"], {
  cwd: repositoryRoot,
  encoding: "utf8",
}).trim();

const program = Effect.gen(function* () {
  const startedAt = DateTime.formatIso(DateTime.makeUnsafe(yield* Clock.currentTimeMillis));
  const fs = yield* FileSystem.FileSystem;
  const projectRoot = yield* fs.makeTempDirectoryScoped({
    prefix: `scient-deep-qa-${language}-project-`,
  });
  const stateRoot = yield* fs.makeTempDirectoryScoped({
    prefix: `scient-deep-qa-${language}-state-`,
  });
  yield* Effect.promise(() =>
    NodeFSP.cp(qaRoot, projectRoot, {
      recursive: true,
      filter: (source) => {
        const relative = NodePath.relative(qaRoot, source);
        if (relative === "") return true;
        const first = relative.split(NodePath.sep)[0];
        return first !== "qa-output" && first !== "archive" && first !== ".scient";
      },
    }),
  );
  yield* Effect.promise(() => initializeScientProject({ root: projectRoot }));

  const settings = {
    schemaVersion: 1 as const,
    languages: { [language]: { enabled: true, executable } },
  };
  const computeLayer = ComputeSessionService.layerWithRuntimeBindings(
    Effect.all([pythonRuntimeBinding, matlabRuntimeBinding]),
  ).pipe(
    Layer.provide(
      ScientificRuntimePreferences.layer.pipe(
        Layer.provide(ServerSettings.layerTest({ scientificComputing: settings })),
        Layer.provide(LocalAnalysisStore.layer),
      ),
    ),
    Layer.provide(LocalComputeStore.layer),
    Layer.provide(LocalExecutionProcess.layer),
    Layer.provide(LocalDuplexProcess.layer),
    Layer.provide(OwnedLocalEndpoints.layer),
    Layer.provide(ServerConfig.layerTest(projectRoot, stateRoot)),
    Layer.provide(NodeServices.layer),
  );
  const workspaceLayer = WorkspaceFileSystem.layer.pipe(
    Layer.provide(WorkspacePaths.layer),
    Layer.provide(WorkspaceEntries.layer.pipe(Layer.provide(WorkspacePaths.layer))),
    Layer.provide(NodeServices.layer),
  );

  yield* Effect.gen(function* () {
    const compute = yield* ComputeSessionService.ComputeSessionService;
    const workspace = yield* WorkspaceFileSystem.WorkspaceFileSystem;
    const gateway = makeComputeRpcGateway({
      workspaceResolver: computeWorkspaceResolverForTest,
      compute,
      workspaceFileSystem: workspace,
      serverSettings: {
        getSettings: Effect.succeed({
          ...DEFAULT_SERVER_SETTINGS,
          scientificComputing: settings,
        }),
      },
    });

    const inventoryStarted = yield* Clock.currentTimeMillis;
    const inventories = yield* Effect.forEach(
      Array.from({ length: 20 }),
      () => gateway.runtimeInventory(),
      {
        concurrency: 4,
      },
    );
    const inspection = yield* gateway.inspectRuntimes({ cwd: projectRoot, refresh: true });
    const runtime = inspection.languages
      .find((candidate) => candidate.descriptor.languageId === languageId)
      ?.runtimes.find((candidate) => candidate.verification.readiness === "ready");
    if (!runtime)
      return yield* Effect.die(
        new Error(`No ready ${language} runtime: ${encodeJson(inspection)}`),
      );
    const inventoryDurationMs = (yield* Clock.currentTimeMillis) - inventoryStarted;
    yield* Effect.promise(() =>
      NodeFSP.writeFile(
        NodePath.join(evidenceDir, "environment.json"),
        encodeJson({
          startedAt,
          candidateRevision,
          platform: NodeProcess.platform,
          architecture: NodeProcess.arch,
          nodeVersion: NodeProcess.version,
          language,
          executable,
          corpusRoot: qaRoot,
          projectRoot,
          stateRoot,
          runtime,
          inspection,
          inventoryConcurrency: {
            calls: inventories.length,
            durationMs: inventoryDurationMs,
          },
        }),
      ),
    );

    const ownedProcessIds = new Set<number>();
    const startSession = Effect.fn("DeepQA.startSession")(function* (id: string) {
      const sessionId = ComputeSessionId.make(id);
      const started = yield* Clock.currentTimeMillis;
      const session = yield* gateway.startSession({
        cwd: projectRoot,
        sessionId,
        languageId,
        executable: runtime.profile.executable,
      });
      if (session.identity?.transportProcessId) {
        ownedProcessIds.add(session.identity.transportProcessId);
      }
      if (session.identity?.runtimeProcessId) {
        ownedProcessIds.add(session.identity.runtimeProcessId);
      }
      return { sessionId, session, startupMs: (yield* Clock.currentTimeMillis) - started };
    });

    const waitForOwnedProcessesToExit = Effect.fn("DeepQA.waitForOwnedProcessesToExit")(
      function* () {
        for (let attempt = 0; attempt < 600; attempt += 1) {
          const alive = [...ownedProcessIds].filter(processExists);
          if (alive.length === 0) return alive;
          yield* Effect.sleep("50 millis");
        }
        return [...ownedProcessIds].filter(processExists);
      },
    );

    const waitForTerminal = Effect.fn("DeepQA.waitForTerminal")(function* (
      sessionId: ComputeSessionId,
      executionId: ComputeExecutionId,
    ) {
      for (let attempt = 0; attempt < 12_000; attempt += 1) {
        const execution = (yield* gateway.listExecutions({
          cwd: projectRoot,
          sessionId,
          limit: 100,
        })).find((candidate) => candidate.request.executionId === executionId);
        if (execution?.result && TERMINAL_COMPUTE_EXECUTION_STATUSES.has(execution.result.status))
          return execution;
        yield* Effect.sleep("20 millis");
      }
      return yield* Effect.die(new Error(`Timed out waiting for ${executionId}`));
    });

    const waitForBusy = Effect.fn("DeepQA.waitForBusy")(function* (sessionId: ComputeSessionId) {
      for (let attempt = 0; attempt < 2_000; attempt += 1) {
        const session = (yield* gateway.listSessions({ cwd: projectRoot })).find(
          (candidate) => candidate.sessionId === sessionId,
        );
        if (session?.activity === "busy") return;
        yield* Effect.sleep("10 millis");
      }
      return yield* Effect.die(new Error(`Session ${sessionId} never became busy.`));
    });

    let activeProjectId: ComputeProjectId | null = null;
    const execute = Effect.fn("DeepQA.execute")(function* (input: {
      sessionId: ComputeSessionId;
      generation: ComputeSessionGeneration;
      label: string;
      code: string;
      source?: { path: string; revision: string; range: SourceRange | null };
      expectedStatus: "succeeded" | "failed" | "cancelled";
      expectedMarkers?: ReadonlyArray<string>;
      expectedDiagnostic?: ManifestEntry["expectedDiagnostic"] | undefined;
      minimumDisplays?: number | undefined;
      minimumResources?: number | undefined;
      interrupt?: boolean | undefined;
    }) {
      // @effect-diagnostics-next-line cryptoRandomUUIDInEffect:off -- execution IDs are opaque, not reproducible evidence.
      const executionId = ComputeExecutionId.make(`qa-${crypto.randomUUID()}`);
      const start = yield* Clock.currentTimeMillis;
      yield* gateway.submitExecution({
        cwd: projectRoot,
        sessionId: input.sessionId,
        executionId,
        expectedGeneration: input.generation,
        code: input.code,
        source: input.source
          ? {
              _tag: "document" as const,
              origin: input.source.range === null ? ("file" as const) : ("selection" as const),
              path: input.source.path,
              bufferState: "saved" as const,
              revision: input.source.revision,
              range: input.source.range,
            }
          : { _tag: "console" as const },
      });
      let cancelRequestedAt: number | null = null;
      if (input.interrupt) {
        yield* waitForBusy(input.sessionId);
        yield* Effect.sleep("1200 millis");
        cancelRequestedAt = yield* Clock.currentTimeMillis;
        yield* gateway.interruptSession({
          cwd: projectRoot,
          sessionId: input.sessionId,
          expectedGeneration: input.generation,
        });
      }
      const execution = yield* waitForTerminal(input.sessionId, executionId);
      const output = yield* gateway.listOutputs({
        cwd: projectRoot,
        sessionId: input.sessionId,
        executionId,
      });
      const variables = yield* gateway
        .inspectVariables({
          cwd: projectRoot,
          sessionId: input.sessionId,
          expectedGeneration: input.generation,
        })
        .pipe(Effect.orElseSucceed(() => null));
      const text = output.outputs
        .flatMap((item) => {
          if (item._tag === "stream") return [item.text];
          if (item._tag === "diagnostic")
            return [
              item.diagnostic.errorName,
              item.diagnostic.message,
              ...item.diagnostic.traceback,
            ];
          return [];
        })
        .join("\n");
      const diagnostics = output.outputs.flatMap((item) =>
        item._tag === "diagnostic" ? [item.diagnostic] : [],
      );
      const expectedDiagnostic = input.expectedDiagnostic;
      const diagnosticMatched =
        expectedDiagnostic === undefined ||
        diagnostics.some(
          (diagnostic) =>
            (expectedDiagnostic.errorName === undefined ||
              diagnostic.errorName === expectedDiagnostic.errorName) &&
            (expectedDiagnostic.messageIncludes === undefined ||
              diagnostic.message.includes(expectedDiagnostic.messageIncludes)),
        );
      const expectedMarkers = input.expectedMarkers ?? [];
      const missingMarkers = input.label.includes("_if_available")
        ? expectedMarkers.some((marker) => text.includes(marker))
          ? []
          : [...expectedMarkers]
        : expectedMarkers.filter((marker) => !text.includes(marker));
      const infrastructureErrors = infrastructurePatterns.filter((pattern) =>
        text.includes(pattern),
      );
      const resources: ReadonlyArray<{
        readonly mediaType: string;
        readonly contentHash: string;
        readonly byteLength: number;
      }> = output.outputs.flatMap((item) =>
        item._tag === "display-data" ||
        item._tag === "display-update" ||
        item._tag === "execute-result"
          ? item.bundle.representations.flatMap((representation) =>
              representation.data._tag === "resource"
                ? [
                    {
                      mediaType: representation.mediaType,
                      contentHash: representation.data.contentHash,
                      byteLength: representation.data.byteLength,
                    },
                  ]
                : [],
            )
          : item._tag === "image"
            ? [
                {
                  mediaType: item.mediaType,
                  contentHash: item.contentHash,
                  byteLength: item.byteLength,
                },
              ]
            : [],
      );
      const missingResources: string[] = [];
      if (activeProjectId === null)
        return yield* Effect.die("The QA project identity was not captured.");
      for (const resource of resources) {
        const retained = yield* compute.resolveOutputResource({
          projectId: activeProjectId,
          sessionId: input.sessionId,
          executionId,
          contentHash: resource.contentHash,
        });
        if (!retained) missingResources.push(resource.contentHash);
      }
      const status = execution.result?.status ?? "missing";
      const displayCount = output.outputs.filter(
        (item) =>
          item._tag === "display-data" ||
          item._tag === "display-update" ||
          item._tag === "execute-result" ||
          item._tag === "image",
      ).length;
      const minimumDisplays = input.minimumDisplays ?? 0;
      const minimumResources = input.minimumResources ?? 0;
      const report = {
        label: input.label,
        executionId,
        expectedStatus: input.expectedStatus,
        actualStatus: status,
        passed:
          status === input.expectedStatus &&
          missingMarkers.length === 0 &&
          diagnosticMatched &&
          infrastructureErrors.length === 0 &&
          displayCount >= minimumDisplays &&
          resources.length >= minimumResources &&
          missingResources.length === 0,
        durationMs: (yield* Clock.currentTimeMillis) - start,
        cancelSettlementMs:
          cancelRequestedAt === null ? null : (yield* Clock.currentTimeMillis) - cancelRequestedAt,
        expectedMarkers,
        missingMarkers,
        expectedDiagnostic: expectedDiagnostic ?? null,
        diagnosticMatched,
        diagnostics,
        infrastructureErrors,
        outputKinds: output.outputs.reduce<Record<string, number>>((counts, item) => {
          counts[item._tag] = (counts[item._tag] ?? 0) + 1;
          return counts;
        }, {}),
        outputCount: output.outputs.length,
        displayCount,
        minimumDisplays,
        resourceCount: resources.length,
        minimumResources,
        resourceBytes: resources.reduce((sum, resource) => sum + resource.byteLength, 0),
        missingResources,
        result: execution.result,
        stdoutTail: text.slice(-4_000),
        variables: variables?.variables.map((variable) => ({
          name: variable.name,
          typeName: variable.typeName,
          shape: variable.shape,
        })),
      };
      reports.push(report);
      yield* Effect.promise(() =>
        NodeFSP.writeFile(
          NodePath.join(evidenceDir, `${safeLabel(input.label)}.json`),
          encodeJson({ report, execution, output, variables }),
        ),
      );
      NodeProcess.stdout.write(
        `${encodeJson({
          event: "scenario",
          label: report.label,
          passed: report.passed,
          expectedStatus: report.expectedStatus,
          actualStatus: report.actualStatus,
          durationMs: report.durationMs,
          displayCount: report.displayCount,
          resourceCount: report.resourceCount,
        })}\n`,
      );
      return report;
    });

    const primary = yield* startSession(`deep-qa-${language}-primary`);
    const primaryIdentity = primary.session.identity;
    if (primaryIdentity === null) {
      return yield* Effect.die(new Error("Primary Compute session has no process identity."));
    }
    activeProjectId = primary.session.projectId;
    const processIds = {
      transport: primaryIdentity.transportProcessId,
      runtime: primaryIdentity.runtimeProcessId,
    };
    reports.push({
      label: "primary-session-start",
      passed: true,
      startupMs: primary.startupMs,
      processIds,
    });

    const resetCode =
      language === "python"
        ? "import matplotlib.pyplot as plt; plt.close('all')"
        : "close all force;";
    const livenessCode =
      language === "python"
        ? "assert 21 * 2 == 42; print('QA_SESSION_ALIVE')"
        : "assert(21 * 2 == 42); disp('QA_SESSION_ALIVE');";

    for (const entry of tests.filter((candidate) => !parallelCase(candidate.path))) {
      const sourceFile = yield* workspace.readFile({ cwd: projectRoot, relativePath: entry.path });
      const sections = splitFirstSection(sourceFile.contents);
      yield* execute({
        sessionId: primary.sessionId,
        generation: primary.session.generation,
        label: `reset-${entry.path}`,
        code: resetCode,
        expectedStatus: "succeeded",
      });
      if (interruptCase(entry.path)) {
        yield* execute({
          sessionId: primary.sessionId,
          generation: primary.session.generation,
          label: entry.path,
          code: sections.first,
          source: {
            path: sourceFile.relativePath,
            revision: sourceFile.revision,
            range: sections.firstRange,
          },
          expectedStatus: "cancelled",
          interrupt: true,
          minimumDisplays: entry.minimumDisplays,
          minimumResources: entry.minimumResources,
        });
        if (!sections.recovery)
          return yield* Effect.die(new Error(`Missing recovery section: ${entry.path}`));
        yield* execute({
          sessionId: primary.sessionId,
          generation: primary.session.generation,
          label: `${entry.path}::recovery`,
          code: sections.recovery,
          source: {
            path: sourceFile.relativePath,
            revision: sourceFile.revision,
            range: sections.recoveryRange,
          },
          expectedStatus: "succeeded",
          expectedMarkers: entry.markers.filter((marker) => marker.includes("RECOVERY")),
        });
      } else if (expectedError(entry)) {
        const mainMarkers = entry.markers.filter((marker) => !marker.includes("RECOVERY"));
        yield* execute({
          sessionId: primary.sessionId,
          generation: primary.session.generation,
          label: entry.path,
          code: sections.first,
          source: {
            path: sourceFile.relativePath,
            revision: sourceFile.revision,
            range: sections.firstRange,
          },
          expectedStatus: "failed",
          expectedMarkers: mainMarkers,
          expectedDiagnostic: entry.expectedDiagnostic,
          minimumDisplays: entry.minimumDisplays,
          minimumResources: entry.minimumResources,
        });
        if (sections.recovery) {
          yield* execute({
            sessionId: primary.sessionId,
            generation: primary.session.generation,
            label: `${entry.path}::recovery`,
            code: sections.recovery,
            source: {
              path: sourceFile.relativePath,
              revision: sourceFile.revision,
              range: sections.recoveryRange,
            },
            expectedStatus: "succeeded",
            expectedMarkers: entry.markers.filter((marker) => marker.includes("RECOVERY")),
          });
        }
      } else {
        yield* execute({
          sessionId: primary.sessionId,
          generation: primary.session.generation,
          label: entry.path,
          code: sourceFile.contents,
          source: { path: sourceFile.relativePath, revision: sourceFile.revision, range: null },
          expectedStatus: "succeeded",
          expectedMarkers: entry.markers,
          minimumDisplays: entry.minimumDisplays,
          minimumResources: entry.minimumResources,
        });
      }
      yield* execute({
        sessionId: primary.sessionId,
        generation: primary.session.generation,
        label: `${entry.path}::liveness`,
        code: livenessCode,
        expectedStatus: "succeeded",
        expectedMarkers: ["QA_SESSION_ALIVE"],
      });
    }

    if (language === "python") {
      const packageProbeLines = [
        "import io, json, tempfile, pathlib",
        "import yaml, PIL.Image, pypdf, jinja2, tabulate, requests, defusedxml.ElementTree as DET",
        "import numpy as np, pandas as pd, scipy.linalg, matplotlib, plotly, seaborn, statsmodels.api as sm, sympy, sklearn, openpyxl",
        "assert yaml.safe_load(yaml.safe_dump({'a': [1, 2]})) == {'a': [1, 2]}",
        "im=PIL.Image.new('RGB',(8,8),'red').resize((4,4)); assert im.size == (4,4)",
        "writer=pypdf.PdfWriter(); writer.add_blank_page(width=72,height=72); b=io.BytesIO(); writer.write(b); assert len(pypdf.PdfReader(io.BytesIO(b.getvalue())).pages)==1",
        "assert jinja2.Template('{{x}}').render(x=42)=='42'; assert '42' in tabulate.tabulate([[42]])",
        "assert requests.Request('GET','https://example.invalid').prepare().url == 'https://example.invalid/'",
        "assert DET.fromstring('<root><x/></root>').tag == 'root'",
        "assert np.allclose(scipy.linalg.solve(np.eye(2), np.array([1.,2.])), [1,2])",
      ];
      const readyToolkits = new Set(
        runtime.toolkits
          .filter((toolkit) => toolkit.readiness === "ready")
          .map((toolkit) => String(toolkit.toolkitId)),
      );
      if (readyToolkits.has("python-large-data")) {
        packageProbeLines.push(
          "import xarray as xr, pyarrow as pa, h5py, h5netcdf, zarr, dask.array as da",
          "assert xr.DataArray([1,2,3]).mean().item()==2; assert pa.array([1,None]).null_count==1",
          "assert da.arange(10,chunks=5).sum().compute()==45",
        );
      }
      if (readyToolkits.has("python-image-analysis")) {
        packageProbeLines.push(
          "import skimage.transform, imageio.v3 as iio, tifffile",
          "assert skimage.transform.resize(np.zeros((4,4)),(2,2)).shape==(2,2)",
        );
      }
      if (readyToolkits.has("python-bioinformatics")) {
        packageProbeLines.push(
          "import Bio.Seq, pyfaidx",
          "assert str(Bio.Seq.Seq('ACGT').reverse_complement())=='ACGT'",
        );
      }
      packageProbeLines.push("print('PYTHON_PACKAGE_FUNCTIONAL_PROBE_OK')");
      const packageProbe = packageProbeLines.join("\n");
      yield* execute({
        sessionId: primary.sessionId,
        generation: primary.session.generation,
        label: "09-runtime-and-packages/python_functional_package_probe",
        code: packageProbe,
        expectedStatus: "succeeded",
        expectedMarkers: ["PYTHON_PACKAGE_FUNCTIONAL_PROBE_OK"],
      });
    }

    const parallel = tests.filter((candidate) => parallelCase(candidate.path));
    if (parallel.length === 2) {
      const sessionA = yield* startSession(`deep-qa-${language}-parallel-a`);
      const sessionB = yield* startSession(`deep-qa-${language}-parallel-b`);
      const [fileA, fileB] = yield* Effect.forEach(
        parallel,
        (entry) => workspace.readFile({ cwd: projectRoot, relativePath: entry.path }),
        { concurrency: 2 },
      );
      if (fileA === undefined || fileB === undefined) {
        return yield* Effect.die(new Error("Parallel qualification fixtures were not loaded."));
      }
      const sectionA = splitFirstSection(fileA.contents);
      const sectionB = splitFirstSection(fileB.contents);
      const runA = execute({
        sessionId: sessionA.sessionId,
        generation: sessionA.session.generation,
        label: parallel[0]!.path,
        code: sectionA.first,
        source: { path: fileA.relativePath, revision: fileA.revision, range: sectionA.firstRange },
        expectedStatus: "cancelled",
        interrupt: true,
      });
      const runB = execute({
        sessionId: sessionB.sessionId,
        generation: sessionB.session.generation,
        label: parallel[1]!.path,
        code: sectionB.first,
        source: { path: fileB.relativePath, revision: fileB.revision, range: sectionB.firstRange },
        expectedStatus: "cancelled",
        interrupt: true,
      });
      yield* Effect.all([runA, runB], { concurrency: 2 });
      if (!sectionA.recovery || !sectionB.recovery)
        return yield* Effect.die("Parallel recovery sections missing.");
      yield* Effect.all(
        [
          execute({
            sessionId: sessionA.sessionId,
            generation: sessionA.session.generation,
            label: `${parallel[0]!.path}::recovery`,
            code: sectionA.recovery,
            source: {
              path: fileA.relativePath,
              revision: fileA.revision,
              range: sectionA.recoveryRange,
            },
            expectedStatus: "succeeded",
            expectedMarkers: parallel[0]!.markers,
          }),
          execute({
            sessionId: sessionB.sessionId,
            generation: sessionB.session.generation,
            label: `${parallel[1]!.path}::recovery`,
            code: sectionB.recovery,
            source: {
              path: fileB.relativePath,
              revision: fileB.revision,
              range: sectionB.recoveryRange,
            },
            expectedStatus: "succeeded",
            expectedMarkers: parallel[1]!.markers,
          }),
        ],
        { concurrency: 2 },
      );
      yield* gateway.stopSession({
        cwd: projectRoot,
        sessionId: sessionA.sessionId,
        expectedGeneration: sessionA.session.generation,
      });
      yield* gateway.stopSession({
        cwd: projectRoot,
        sessionId: sessionB.sessionId,
        expectedGeneration: sessionB.session.generation,
      });
      reports.push({
        label: "parallel-session-start",
        passed: true,
        startupMs: [sessionA.startupMs, sessionB.startupMs],
      });
    }

    yield* gateway.stopSession({
      cwd: projectRoot,
      sessionId: primary.sessionId,
      expectedGeneration: primary.session.generation,
    });
    const aliveProcessIds = yield* waitForOwnedProcessesToExit();
    const remainingSessions = yield* gateway.listSessions({ cwd: projectRoot });
    const processCleanup = {
      ownedProcessIds: [...ownedProcessIds],
      aliveProcessIds,
      remainingSessions,
    };
    reports.push({
      label: "primary-session-cleanup",
      passed:
        aliveProcessIds.length === 0 &&
        remainingSessions.every((session) => session.status === "stopped"),
      ...processCleanup,
    });
    if (yield* fs.exists(NodePath.join(projectRoot, "qa-output"))) {
      yield* Effect.promise(() =>
        NodeFSP.cp(
          NodePath.join(projectRoot, "qa-output"),
          NodePath.join(evidenceDir, "generated"),
          {
            recursive: true,
          },
        ),
      );
    }
    yield* Effect.promise(() =>
      NodeFSP.writeFile(NodePath.join(evidenceDir, "summary.json"), encodeJson(reports)),
    );
  }).pipe(Effect.provide(Layer.merge(computeLayer, workspaceLayer)));
}).pipe(Effect.scoped, Effect.provide(NodeServices.layer));

try {
  await Effect.runPromise(program);
} finally {
  await NodeFSP.writeFile(NodePath.join(evidenceDir, "summary.json"), encodeJson(reports));
}

const failedReports = reports.filter((report) => report.passed !== true);
if (failedReports.length > 0) {
  throw new Error(
    `${failedReports.length} Compute qualification scenario(s) failed: ${failedReports
      .map((report) => String(report.label ?? "unknown"))
      .join(", ")}`,
  );
}

NodeProcess.stdout.write(
  `${encodeJson({ event: "complete", language, evidenceDir, scenarios: reports.length })}\n`,
);
