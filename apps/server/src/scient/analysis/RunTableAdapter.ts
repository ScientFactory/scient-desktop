// @effect-diagnostics nodeBuiltinImport:off -- a built program and its pictures are host files.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import {
  AnalysisArtifactFileName,
  AnalysisArtifactId,
  AnalysisArtifactRepresentationId,
  AnalysisRuntimeId,
  type AnalysisArtifactCollection,
  type AnalysisRunContext,
  type AnalysisRuntimeAdapter,
} from "@scientfactory/analysis";
import {
  COMPUTE_LANGUAGE_CATALOG,
  COMPUTE_RUN_TABLE,
  computeRunnableTools,
  isSystemTool,
  type ComputeRunCommand,
  type ComputeRunRoute,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { sanitizeComputeEnvironment } from "../compute/ComputeEnvironmentPolicy.ts";
import type {
  ComputeProjectOutputObservation,
  ComputeProjectOutputObserverPort,
} from "../compute/ComputeProjectOutputObserver.ts";
import type { FoundLanguageTool } from "../compute/ToolScan.ts";

const MAXIMUM_CAPTURED_BYTES = 64 * 1024 * 1024;

interface RunnableTool {
  readonly command: ComputeRunCommand;
  readonly executable: string;
  readonly version: string | null;
}

const programName = (executable: string) =>
  NodePath.basename(executable.replaceAll("\\", "/")).replace(/\.(exe|cmd|bat|com)$/iu, "");

/** JAVA_HOME names the Java someone wants, which outranks the newest one. */
function runnable(
  route: ComputeRunRoute,
  tools: ReadonlyArray<FoundLanguageTool>,
  environment: Readonly<Record<string, string>>,
): ReadonlyArray<FoundLanguageTool> {
  const ordered = computeRunnableTools(route, tools);
  const home = environment.JAVA_HOME;
  if (route.languageId !== "java" || home === undefined) return ordered;
  const chosen = ordered.filter((tool) => tool.executable.startsWith(home));
  return [...chosen, ...ordered.filter((tool) => !chosen.includes(tool))];
}

/** The best command this computer has, or what someone added, run the way its name says. */
function chooseTool(
  route: ComputeRunRoute,
  tools: ReadonlyArray<FoundLanguageTool>,
  added: string | undefined,
  environment: Readonly<Record<string, string>>,
): RunnableTool | null {
  if (added !== undefined) {
    const name = programName(added);
    const command =
      route.commands.find((candidate) => candidate.command === name) ?? route.commands[0];
    return command === undefined ? null : { command, executable: added, version: null };
  }
  const tool = runnable(route, tools, environment)[0];
  const command = route.commands.find((candidate) => candidate.command === tool?.name);
  return tool === undefined || command === undefined
    ? null
    : { command, executable: tool.executable, version: tool.version };
}

function fill(args: ReadonlyArray<string>, file: string, output: string): ReadonlyArray<string> {
  const quoted = file.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
  return args.map((arg) =>
    arg
      .replaceAll("{file}", file)
      .replaceAll("{quotedFile}", quoted)
      .replaceAll("{output}", output),
  );
}

/** Windows starts a batch file only through its command interpreter. */
function startable(
  step: { readonly executable: string; readonly args: ReadonlyArray<string> },
  environment: Readonly<Record<string, string>>,
  platform: NodeJS.Platform,
) {
  return platform === "win32" && /\.(bat|cmd)$/iu.test(step.executable)
    ? {
        executable: environment.ComSpec ?? environment.COMSPEC ?? "cmd.exe",
        args: ["/d", "/c", "call", step.executable, ...step.args],
      }
    : step;
}

function prepare(
  route: ComputeRunRoute,
  environment: Readonly<Record<string, string>>,
  platform: NodeJS.Platform,
  context: AnalysisRunContext,
) {
  const executable = context.runtime.executablePath;
  if (executable === null) throw new Error(`${context.runtime.label} was not found.`);
  const { command } = chooseTool(route, [], executable, environment)!;
  const file = context.absoluteSourcePath;
  const process = { cwd: context.source.cwd, environment };
  const output = NodePath.join(
    context.artifactStagingDirectory,
    platform === "win32" ? "program.exe" : "program",
  );
  const step = (name: string, args: ReadonlyArray<string>) => ({
    ...startable({ executable: name, args }, environment, platform),
    ...process,
  });
  const args = fill(
    platform === "win32" ? command.args : [...command.args, ...(command.unixArgs ?? [])],
    file,
    output,
  );
  if (command.build === undefined) return step(executable, args);
  // A build's runner sits beside the compiler that needs it.
  const runner = command.build.runner;
  return {
    ...step(
      runner === undefined ? output : NodePath.join(NodePath.dirname(executable), runner),
      fill(command.build.args ?? [], file, output),
    ),
    before: [step(executable, args)],
  };
}

/** The other installs a failed run can be tried with, one for each version. */
function alternatives(
  route: ComputeRunRoute,
  tools: ReadonlyArray<FoundLanguageTool>,
  chosen: RunnableTool | null,
  label: string,
  environment: Readonly<Record<string, string>>,
) {
  if (chosen === null) return [];
  const seen = new Set([`${programName(chosen.executable)} ${chosen.version}`]);
  return runnable(route, tools, environment).flatMap((tool) => {
    const key = `${tool.name} ${tool.version}`;
    if (seen.has(key)) return [];
    seen.add(key);
    return [
      {
        executablePath: tool.executable,
        label:
          tool.version !== null
            ? `${label} ${tool.version}`
            : isSystemTool(tool.executable)
              ? `system ${tool.name}`
              : tool.name,
        version: tool.version,
      },
    ];
  });
}

/** What a run left in the project: its pictures become results, its tables are pointed at. */
function projectOutputCapture(observer: ComputeProjectOutputObserverPort) {
  // Held by the run's own context, so a run that never reaches collection leaves nothing behind.
  const observations = new WeakMap<AnalysisRunContext, ComputeProjectOutputObservation>();
  return {
    prepareRun: async (context: AnalysisRunContext): Promise<void> => {
      observations.set(context, await Effect.runPromise(observer.begin(context.source.cwd)));
    },
    collectArtifacts: async (context: AnalysisRunContext): Promise<AnalysisArtifactCollection> => {
      const observation = observations.get(context);
      if (observation === undefined) return { candidates: [], failureMessage: null };
      const { images, tables } = await Effect.runPromise(
        observer.collect(observation, { maximumBytes: MAXIMUM_CAPTURED_BYTES }),
      );
      const files = NodePath.join(context.artifactStagingDirectory, "files");
      await NodeFSP.mkdir(files, { recursive: true });
      const candidates = await Promise.all(
        images.map(async (image, index) => {
          const number = String(index + 1).padStart(3, "0");
          const extension = image.mediaType === "image/png" ? "png" : "svg";
          const fileName = AnalysisArtifactFileName.make(`figure-${number}.${extension}`);
          await NodeFSP.writeFile(NodePath.join(files, fileName), image.bytes);
          return {
            artifactId: AnalysisArtifactId.make(`figure-${number}`),
            kind: "figure" as const,
            label: NodePath.basename(image.relativePath),
            representations: [
              {
                representationId: AnalysisArtifactRepresentationId.make(`static-${extension}`),
                fileName,
                mediaType: image.mediaType,
                presentation: "static" as const,
                requiresNetworkForFullExperience: false,
              },
            ],
          };
        }),
      );
      return { candidates, writtenFiles: tables, failureMessage: null };
    },
  };
}

/** One runtime per row of the run table, read from what the scan found. */
export function makeRunTableAdapters(input: {
  readonly tools: () => Promise<ReadonlyMap<string, ReadonlyArray<FoundLanguageTool>>>;
  readonly environment: Readonly<Record<string, string>>;
  readonly platform: NodeJS.Platform;
  readonly observer?: ComputeProjectOutputObserverPort;
}): ReadonlyArray<AnalysisRuntimeAdapter> {
  const { environment } = sanitizeComputeEnvironment(input.environment);
  const capture = input.observer === undefined ? {} : projectOutputCapture(input.observer);
  const names = new Map(
    COMPUTE_LANGUAGE_CATALOG.flatMap((group) => group.languages).map((language) => [
      language.languageId,
      language.name,
    ]),
  );
  return COMPUTE_RUN_TABLE.map((route): AnalysisRuntimeAdapter => {
    const label = names.get(route.languageId) ?? route.label ?? route.languageId;
    return {
      id: AnalysisRuntimeId.make(`file:${route.languageId}`),
      kind: route.languageId,
      fileExtensions: route.extensions,
      readsLiveScan: true,
      inspect: async ({ customExecutablePath, inspectedAt }) => {
        const tools = (await input.tools()).get(route.languageId) ?? [];
        const tool = chooseTool(route, tools, customExecutablePath, environment);
        return {
          id: AnalysisRuntimeId.make(`file:${route.languageId}`),
          kind: route.languageId,
          label,
          availability: tool === null ? "missing" : "available",
          source:
            customExecutablePath !== undefined ? "custom" : tool === null ? "unconfigured" : "path",
          executablePath: tool?.executable ?? null,
          version: tool?.version ?? null,
          detail: tool === null ? `${label} was not found on this computer.` : null,
          capabilities: ["run-file", "stream-output", "cancel-process-tree"],
          inspectedAt,
          verification: null,
          alternatives: alternatives(route, tools, tool, label, environment),
        };
      },
      ...capture,
      prepare: (context) => prepare(route, environment, input.platform, context),
    };
  });
}
