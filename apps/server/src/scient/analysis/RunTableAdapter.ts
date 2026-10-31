// @effect-diagnostics nodeBuiltinImport:off -- a built program's path is a host path.
import * as NodePath from "node:path";

import {
  AnalysisRuntimeId,
  type AnalysisRunContext,
  type AnalysisRuntimeAdapter,
} from "@scientfactory/analysis";
import {
  COMPUTE_LANGUAGE_CATALOG,
  COMPUTE_RUN_TABLE,
  type ComputeRunCommand,
  type ComputeRunRoute,
} from "@t3tools/contracts";

import { sanitizeComputeEnvironment } from "../compute/ComputeEnvironmentPolicy.ts";
import type { FoundLanguageTool } from "../compute/ToolScan.ts";

interface RunnableTool {
  readonly command: ComputeRunCommand;
  readonly executable: string;
  readonly version: string | null;
}

const programName = (executable: string) =>
  NodePath.basename(executable.replaceAll("\\", "/")).replace(/\.(exe|cmd|bat|com)$/iu, "");

/** The best command this computer has, or what someone added, run the way its name says. */
function chooseTool(
  route: ComputeRunRoute,
  tools: ReadonlyArray<FoundLanguageTool>,
  added: string | undefined,
): RunnableTool | null {
  if (added !== undefined) {
    const name = programName(added);
    const command =
      route.commands.find((candidate) => candidate.command === name) ?? route.commands[0];
    return command === undefined ? null : { command, executable: added, version: null };
  }
  for (const command of route.commands) {
    const tool = tools.find((candidate) => candidate.name === command.command);
    if (tool !== undefined) return { command, executable: tool.executable, version: tool.version };
  }
  return null;
}

/** A build's runner sits beside the compiler that needs it, or comes from the scan's PATH. */
function fill(args: ReadonlyArray<string>, file: string, output: string): ReadonlyArray<string> {
  return args.map((arg) => arg.replaceAll("{file}", file).replaceAll("{output}", output));
}

function prepare(
  route: ComputeRunRoute,
  environment: Readonly<Record<string, string>>,
  platform: NodeJS.Platform,
  context: AnalysisRunContext,
) {
  const executable = context.runtime.executablePath;
  if (executable === null) throw new Error(`${context.runtime.label} was not found.`);
  const { command } = chooseTool(route, [], executable)!;
  const file = context.absoluteSourcePath;
  const process = { cwd: context.source.cwd, environment };
  const output = NodePath.join(
    context.artifactStagingDirectory,
    platform === "win32" ? "program.exe" : "program",
  );
  const args = fill(command.args, file, output);
  if (command.build === undefined) return { executable, args, ...process };
  const runner = command.build.runner;
  return {
    executable: runner === undefined ? output : NodePath.join(NodePath.dirname(executable), runner),
    args: fill(command.build.args ?? [], file, output),
    ...process,
    before: [{ executable, args, ...process }],
  };
}

/** One runtime per row of the run table, read from what the scan found. */
export function makeRunTableAdapters(input: {
  readonly tools: () => Promise<ReadonlyMap<string, ReadonlyArray<FoundLanguageTool>>>;
  readonly environment: Readonly<Record<string, string>>;
  readonly platform: NodeJS.Platform;
}): ReadonlyArray<AnalysisRuntimeAdapter> {
  const { environment } = sanitizeComputeEnvironment(input.environment);
  const names = new Map(
    COMPUTE_LANGUAGE_CATALOG.flatMap((group) => group.languages).map((language) => [
      language.languageId,
      language.name,
    ]),
  );
  return COMPUTE_RUN_TABLE.map((route): AnalysisRuntimeAdapter => {
    const label = names.get(route.languageId) ?? route.languageId;
    return {
      id: AnalysisRuntimeId.make(`file:${route.languageId}`),
      kind: route.languageId,
      fileExtensions: route.extensions,
      inspect: async ({ customExecutablePath, inspectedAt }) => {
        const tools = (await input.tools()).get(route.languageId) ?? [];
        const tool = chooseTool(route, tools, customExecutablePath);
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
        };
      },
      prepare: (context) => prepare(route, environment, input.platform, context),
    };
  });
}
