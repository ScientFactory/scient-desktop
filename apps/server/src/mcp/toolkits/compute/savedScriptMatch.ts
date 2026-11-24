// @effect-diagnostics nodeBuiltinImport:off -- a bounded walk finds freshly saved files before the workspace index sees them.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import { COMPUTE_SESSION_FILE_EXTENSIONS } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import {
  ENVIRONMENT_MARKERS,
  IGNORED_DIRECTORY_NAMES,
} from "../../../scient/compute/ComputeProjectWriteWatch.ts";
import type { AgentScope } from "./agentComputeScope.ts";

const MAX_ENTRIES = 8_192;
const MAX_CANDIDATE_BYTES = 16 * 1024 * 1024;
const MAX_CANDIDATES = 256;
const ignoredDirectories: ReadonlySet<string> = new Set(IGNORED_DIRECTORY_NAMES);

export function fileSessionLanguage(path: string) {
  const normalized = path.toLowerCase();
  return Object.entries(COMPUTE_SESSION_FILE_EXTENSIONS).find(([, extension]) =>
    normalized.endsWith(extension),
  )?.[0];
}

async function candidatePaths(
  cwd: string,
  codeBytes: number,
  language: string | undefined,
  signal: AbortSignal,
): Promise<ReadonlyArray<string> | null> {
  const paths: string[] = [];
  const directories = [""];
  let inspected = 0;
  for (const directory of directories) {
    signal.throwIfAborted();
    const absolute = NodePath.join(cwd, directory);
    const entries = await NodeFSP.readdir(absolute, { withFileTypes: true }).catch(() => []);
    inspected += entries.length;
    if (inspected > MAX_ENTRIES) return null;
    if (
      directory !== "" &&
      entries.some(({ name }) => (ENVIRONMENT_MARKERS as readonly string[]).includes(name))
    )
      continue;
    for (const entry of entries) {
      signal.throwIfAborted();
      if (entry.name.startsWith(".")) continue;
      const path = directory ? `${directory}/${entry.name}` : entry.name;
      if (entry.isDirectory() && !ignoredDirectories.has(entry.name)) directories.push(path);
      if (!entry.isFile()) continue;
      const candidateLanguage = fileSessionLanguage(path);
      if (
        candidateLanguage === undefined ||
        (language !== undefined && candidateLanguage !== language)
      )
        continue;
      const stat = await NodeFSP.lstat(NodePath.join(cwd, path)).catch(() => null);
      if (!stat?.isFile() || stat.size !== codeBytes) continue;
      paths.push(path);
      if (paths.length > MAX_CANDIDATES || paths.length * codeBytes > MAX_CANDIDATE_BYTES)
        return null;
    }
  }
  return paths;
}

export const matchSavedScript = Effect.fn("ScientComputeToolkit.matchSavedScript")(function* (
  scope: AgentScope,
  code: string,
  language: string | undefined,
) {
  if (code.trim() === "") return undefined;
  const paths = yield* Effect.promise((signal) =>
    candidatePaths(scope.cwd, Buffer.byteLength(code), language, signal),
  ).pipe(Effect.timeoutOrElse({ duration: "750 millis", orElse: () => Effect.succeed(null) }));
  if (paths === null) return undefined;
  let matched;
  for (const path of paths) {
    const file = yield* scope.gateway
      .readFile({ cwd: scope.cwd, relativePath: path })
      .pipe(Effect.orElseSucceed(() => null));
    if (
      file === null ||
      file.outsideWorkspace ||
      file.exists === false ||
      file.truncated ||
      file.contents !== code
    )
      continue;
    if (matched !== undefined) return undefined;
    matched = {
      language: fileSessionLanguage(path),
      source: {
        _tag: "document",
        origin: "file",
        path: file.relativePath,
        revision: file.revision,
        bufferState: "saved",
        range: null,
      } as const,
    };
  }
  return matched;
});
