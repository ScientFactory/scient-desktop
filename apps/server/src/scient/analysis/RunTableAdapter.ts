// @effect-diagnostics nodeBuiltinImport:off -- a built program and its pictures are host files.
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import {
  AnalysisArtifactFileName,
  AnalysisArtifactId,
  AnalysisArtifactRepresentationId,
  AnalysisOperationError,
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
import { pathModule } from "../compute/RuntimeDiscovery.ts";
import type {
  ComputeProjectOutputObservation,
  ComputeProjectOutputObserverPort,
} from "../compute/ComputeProjectOutputObserver.ts";
import type { FoundLanguageTool } from "../compute/ToolScan.ts";
import { batchLogBaseline, batchLogsFor, type BatchLogBaseline } from "./batchLogOutput.ts";

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

/**
 * The first experiment a NetLogo model saves, since headless NetLogo runs only those. They sit in a
 * .nlogo model's eighth section; elsewhere, as in its Info tab, the same markup can be an example.
 */
function firstExperiment(file: string): string | null {
  try {
    const model = NodeFS.readFileSync(file, "utf8");
    const experiments = file.toLowerCase().endsWith(".nlogox")
      ? model.replace(/<(info|code)>[\s\S]*?<\/\1>/gu, "")
      : (model.split("@#$#@#$#@")[7] ?? "");
    const name = /<experiment\b[^>]*\bname="([^"]*)"/u.exec(experiments)?.[1];
    return name === undefined
      ? null
      : name
          .replaceAll("&quot;", '"')
          .replaceAll("&lt;", "<")
          .replaceAll("&gt;", ">")
          .replaceAll("&amp;", "&");
  } catch {
    return null;
  }
}

function fill(args: ReadonlyArray<string>, file: string, output: string): ReadonlyArray<string> {
  const quoted = file.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
  const filled = args.map((arg) =>
    arg
      .replaceAll("{file}", file)
      .replaceAll("{quotedFile}", quoted)
      .replaceAll("{fileFolder}", NodePath.dirname(file))
      .replaceAll("{fileStem}", NodePath.basename(file).replace(/\.[^.]+$/u, ""))
      .replaceAll("{output}", output),
  );
  const at = filled.indexOf("{netlogoExperiment}");
  if (at === -1) return filled;
  const experiment = firstExperiment(file);
  // A model without one runs as given, so NetLogo itself says what it needs.
  return experiment === null ? filled.toSpliced(at - 1, 2) : filled.toSpliced(at, 1, experiment);
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

/**
 * The nearest folder at or above the file's that holds a marker. A file in `.lake`, where Lake keeps
 * dependencies, belongs to the project above it.
 */
function projectRoot(
  file: string,
  markers: ReadonlyArray<string>,
  platform: NodeJS.Platform,
): string | null {
  const path = pathModule(platform);
  const [above, inside] = file.split(/[\\/]\.lake[\\/]/u);
  let folder = inside === undefined ? path.dirname(file) : above!;
  for (;;) {
    if (markers.some((name) => NodeFS.existsSync(path.join(folder, name)))) return folder;
    const parent = path.dirname(folder);
    if (parent === folder) return null;
    folder = parent;
  }
}

/** Lake ships beside Lean in every install: elan's launchers and each toolchain alike. */
export function beside(executable: string, command: string, platform: NodeJS.Platform): string {
  const path = pathModule(platform);
  const extension = /\.exe$/iu.test(executable) ? ".exe" : "";
  return path.join(path.dirname(executable), `${command}${extension}`);
}

function readText(file: string): string | null {
  try {
    return NodeFS.readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

/** `lake lean` arrived in Lean 4.8. Channels, nightlies and later versions have it. */
export function lakeHasLeanCommand(toolchain: string | null): boolean {
  const minor = /(?:^|:)v4\.(\d+)\./u.exec(toolchain?.trim() ?? "")?.[1];
  return minor === undefined || Number(minor) >= 8;
}

interface LakeManifest {
  readonly name?: unknown;
  readonly packages?: ReadonlyArray<{ readonly name?: unknown } | null>;
}

/** A Mathlib project whose Mathlib is not built yet, which Mathlib's own cache fills in minutes. */
export function mathlibNeedsCache(root: string): boolean {
  let manifest: LakeManifest | null = null;
  try {
    manifest = JSON.parse(readText(NodePath.join(root, "lake-manifest.json")) ?? "null");
  } catch {
    return false;
  }
  const isMathlib = manifest?.name === "mathlib";
  const packages = Array.isArray(manifest?.packages) ? manifest.packages : [];
  if (!isMathlib && !packages.some((entry) => entry?.name === "mathlib")) return false;
  const mathlib = isMathlib ? root : NodePath.join(root, ".lake", "packages", "mathlib");
  const build = NodePath.join(mathlib, ".lake", "build", "lib");
  return !["lean/Mathlib.olean", "Mathlib.olean"].some((file) =>
    NodeFS.existsSync(NodePath.join(build, file)),
  );
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
  const root =
    route.project === undefined ? null : projectRoot(file, route.project.markers, platform);
  if (route.project !== undefined && root !== null) {
    const tool = beside(executable, route.project.command, platform);
    if (!NodeFS.existsSync(tool)) {
      throw new AnalysisOperationError({
        operation: "start",
        reason: "runtime-missing",
        message: `This file is in a Lake project at ${root}, and Lake is not beside ${executable}. Install Lean with elan, which brings Lake: https://lean-lang.org/install/`,
      });
    }
    const inProject = (args: ReadonlyArray<string>) => ({ ...step(tool, args), cwd: root });
    // Lean only: Mathlib's cache, and Lake from before `lake lean`.
    const lean = route.languageId === "lean";
    const before = lean && mathlibNeedsCache(root) ? [inProject(["exe", "cache", "get"])] : [];
    if (lean && !lakeHasLeanCommand(readText(NodePath.join(root, "lean-toolchain")))) {
      return { ...inProject(["env", "lean", file]), before: [...before, inProject(["build"])] };
    }
    const main = inProject(fill(route.project.args, file, output));
    return before.length === 0 ? main : { ...main, before };
  }
  const logs = batchLogsFor(route.languageId, platform);
  const args =
    logs?.args(executable, context) ??
    fill(
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
  const capture: Pick<AnalysisRuntimeAdapter, "prepareRun" | "collectArtifacts"> =
    input.observer === undefined ? {} : projectOutputCapture(input.observer);
  const names = new Map(
    COMPUTE_LANGUAGE_CATALOG.flatMap((group) => group.languages).map((language) => [
      language.languageId,
      language.name,
    ]),
  );
  return COMPUTE_RUN_TABLE.map((route): AnalysisRuntimeAdapter => {
    const label = names.get(route.languageId) ?? route.label ?? route.languageId;
    const logs = batchLogsFor(route.languageId, input.platform);
    const baselines = new WeakMap<AnalysisRunContext, BatchLogBaseline>();
    const missing =
      route.languageId === "sas" && input.platform === "darwin"
        ? "SAS has no version for Mac. It runs on Windows and Linux, or online through SAS OnDemand for Academics."
        : `${label} was not found on this computer.`;
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
          detail: tool === null ? missing : null,
          capabilities: ["run-file", "stream-output", "cancel-process-tree"],
          inspectedAt,
          verification: null,
          alternatives: alternatives(route, tools, tool, label, environment),
        };
      },
      ...capture,
      ...(logs === undefined
        ? {}
        : {
            prepareRun: async (context: AnalysisRunContext) => {
              baselines.set(context, await batchLogBaseline(logs.places(context)));
              await capture.prepareRun?.(context);
            },
            concludeRun: async (context: AnalysisRunContext, exitCode: number | null) => {
              const before = baselines.get(context);
              if (before === undefined) throw new Error(`${label} began without a log baseline.`);
              return logs.conclude(context, exitCode, before);
            },
          }),
      prepare: (context) => prepare(route, environment, input.platform, context),
    };
  });
}
