// @effect-diagnostics nodeBuiltinImport:off -- The index walks the server-owned workspace.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import type {
  ScientLatexResolveRequest,
  ScientLatexResolveResult,
  ScientLatexResolutionIncompleteReason,
  ScientLatexRootCandidate,
  ScientLatexRootEvidenceKind,
} from "@t3tools/contracts";

import { isLatexSourcePath, resolveLatexRoot } from "./latexRoot.ts";

const MAX_INDEX_FILES = 2_000;
const MAX_SOURCE_BYTES = 1_048_576;
const MAX_TOTAL_SOURCE_BYTES = 24 * 1_048_576;
const MAX_DIRECTORY_DEPTH = 32;
const MAX_CANDIDATES = 64;

const IGNORED_DIRECTORIES = new Set([
  ".git",
  ".hg",
  ".scient",
  ".svn",
  ".tectonic",
  "build",
  "dist",
  "node_modules",
  "out",
]);
const OPAQUE_ENVIRONMENTS = [
  "comment",
  "filecontents",
  "filecontents*",
  "lstlisting",
  "minted",
  "Verbatim",
  "verbatim",
  "verbatim*",
] as const;

interface LatexDependencyDirective {
  readonly command: "input" | "include" | "subfile" | "import" | "subimport";
  readonly directory: string | null;
  readonly target: string;
}

interface IndexedLatexSource {
  readonly relativePath: string;
  readonly contents: string;
  readonly documentRoot: boolean;
  readonly directives: ReadonlyArray<LatexDependencyDirective>;
}

interface ProjectIndex {
  readonly sources: ReadonlyMap<string, IndexedLatexSource>;
  readonly generation: string;
  readonly incompleteReasons: ReadonlySet<ScientLatexResolutionIncompleteReason>;
}

function toPosix(value: string): string {
  return value.replaceAll("\\", "/");
}

function escapesWorkspace(relativePath: string): boolean {
  return (
    relativePath.length === 0 ||
    relativePath === "." ||
    relativePath === ".." ||
    relativePath.startsWith("../") ||
    NodePath.isAbsolute(relativePath)
  );
}

function workspaceRelative(workspaceRoot: string, absolutePath: string): string | null {
  const relative = toPosix(NodePath.relative(workspaceRoot, absolutePath));
  return escapesWorkspace(relative) ? null : relative;
}

/** Removes syntax regions where dependency-looking text is literal rather than executable TeX. */
export function latexDependencySource(source: string): string {
  const withoutComments = source
    .split(/\r?\n/u)
    .map((line) => {
      let output = "";
      for (let index = 0; index < line.length; index += 1) {
        const character = line[index] ?? "";
        if (character === "%") {
          let backslashes = 0;
          for (let back = index - 1; back >= 0 && line[back] === "\\"; back -= 1) backslashes += 1;
          if (backslashes % 2 === 0) break;
        }
        if (character === "\\" && line.slice(index + 1, index + 5) === "verb") {
          const starOffset = line[index + 5] === "*" ? 1 : 0;
          const delimiterIndex = index + 5 + starOffset;
          const delimiter = line[delimiterIndex];
          if (delimiter !== undefined && !/\s/u.test(delimiter)) {
            const end = line.indexOf(delimiter, delimiterIndex + 1);
            const consumed = (end < 0 ? line.length - 1 : end) - index;
            output += " ".repeat(consumed + 1);
            index += consumed;
            continue;
          }
        }
        output += character;
      }
      return output;
    })
    .join("\n");

  let visible = withoutComments;
  for (const environment of OPAQUE_ENVIRONMENTS) {
    const escaped = environment.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
    visible = visible.replace(
      new RegExp(`\\\\begin\\s*\\{${escaped}\\}[\\s\\S]*?(?:\\\\end\\s*\\{${escaped}\\}|$)`, "gu"),
      (match) => " ".repeat(match.length),
    );
  }
  return visible;
}

export function parseLatexDependencyDirectives(source: string): {
  readonly directives: ReadonlyArray<LatexDependencyDirective>;
  readonly incompleteReasons: ReadonlySet<ScientLatexResolutionIncompleteReason>;
} {
  const visible = latexDependencySource(source);
  const directives: LatexDependencyDirective[] = [];
  const matchedCommands: Array<{ readonly from: number; readonly to: number }> = [];
  const incompleteReasons = new Set<ScientLatexResolutionIncompleteReason>();
  const pattern =
    /\\(?:(input|include|subfile)\s*\{([^{}]+)\}|(import|subimport)\s*\{([^{}]+)\}\s*\{([^{}]+)\})/gu;
  for (const match of visible.matchAll(pattern)) {
    const simple = match[1] as LatexDependencyDirective["command"] | undefined;
    const imported = match[3] as LatexDependencyDirective["command"] | undefined;
    const command = simple ?? imported;
    if (command === undefined) continue;
    const directory = imported === undefined ? null : (match[4] ?? "").trim();
    const target = (simple === undefined ? (match[5] ?? "") : (match[2] ?? "")).trim();
    matchedCommands.push({ from: match.index, to: match.index + match[0].length });
    if (target.includes("\\") || target.includes("#") || directory?.includes("\\") === true) {
      incompleteReasons.add("dynamic-input");
      continue;
    }
    directives.push({
      command,
      directory,
      target,
    });
  }

  const commandPattern = /\\(?:input|include|subfile|import|subimport)\b/gu;
  for (const match of visible.matchAll(commandPattern)) {
    if (!matchedCommands.some((range) => match.index >= range.from && match.index < range.to)) {
      incompleteReasons.add("dynamic-input");
    }
  }
  return { directives, incompleteReasons };
}

function candidatePath(baseDirectory: string, target: string): string | null {
  const raw = target.trim();
  if (raw.length === 0 || raw.includes("#") || raw.includes("\\")) return null;
  const normalized = raw.replaceAll("\\", "/");
  const withExtension = /\.[A-Za-z0-9]{1,8}$/u.test(normalized) ? normalized : `${normalized}.tex`;
  return NodePath.resolve(baseDirectory, withExtension);
}

async function buildProjectIndex(
  workspaceRoot: string,
  sourceRelativePath: string,
): Promise<ProjectIndex> {
  const sources = new Map<string, IndexedLatexSource>();
  const incompleteReasons = new Set<ScientLatexResolutionIncompleteReason>();
  const generation = NodeCrypto.createHash("sha256");
  let fileCount = 0;
  let totalBytes = 0;

  const addSource = async (absolutePath: string, relativePath: string): Promise<void> => {
    if (sources.has(relativePath)) return;
    let info: Awaited<ReturnType<typeof NodeFSP.lstat>>;
    try {
      info = await NodeFSP.lstat(absolutePath);
    } catch {
      incompleteReasons.add("unreadable-file");
      return;
    }
    if (!info.isFile() || info.isSymbolicLink()) return;
    if (info.size > MAX_SOURCE_BYTES) {
      incompleteReasons.add("file-too-large");
      return;
    }
    let contents: string;
    try {
      contents = await NodeFSP.readFile(absolutePath, "utf8");
    } catch {
      incompleteReasons.add("unreadable-file");
      return;
    }
    totalBytes += Buffer.byteLength(contents);
    if (totalBytes > MAX_TOTAL_SOURCE_BYTES) {
      incompleteReasons.add("scan-limit");
      return;
    }
    const parsed = parseLatexDependencyDirectives(contents);
    for (const reason of parsed.incompleteReasons) incompleteReasons.add(reason);
    const dependencySource = latexDependencySource(contents);
    const documentRoot =
      resolveLatexRoot({ relativePath, contents }).reason === "documentclass" ||
      /\\begin\s*\{document\}/u.test(dependencySource);
    sources.set(relativePath, {
      relativePath,
      contents,
      documentRoot,
      directives: parsed.directives,
    });
    generation.update(relativePath).update("\0").update(contents).update("\0");
  };

  const sourceAbsolutePath = NodePath.resolve(workspaceRoot, sourceRelativePath);

  const visit = async (directory: string, depth: number): Promise<void> => {
    if (depth > MAX_DIRECTORY_DEPTH || fileCount >= MAX_INDEX_FILES) {
      incompleteReasons.add("scan-limit");
      return;
    }
    let entries: NodeFS.Dirent<string>[];
    try {
      entries = await NodeFSP.readdir(directory, { withFileTypes: true, encoding: "utf8" });
    } catch {
      incompleteReasons.add("unreadable-file");
      return;
    }
    for (const entry of entries.toSorted((left, right) => left.name.localeCompare(right.name))) {
      if (fileCount >= MAX_INDEX_FILES) {
        incompleteReasons.add("scan-limit");
        return;
      }
      if (entry.isSymbolicLink()) continue;
      const absolutePath = NodePath.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!IGNORED_DIRECTORIES.has(entry.name)) await visit(absolutePath, depth + 1);
        continue;
      }
      if (!entry.isFile()) continue;
      const relativePath = workspaceRelative(workspaceRoot, absolutePath);
      if (relativePath === null || !isLatexSourcePath(relativePath)) continue;
      fileCount += 1;
      await addSource(absolutePath, relativePath);
    }
  };
  await visit(workspaceRoot, 0);
  // A bounded scan may stop before the requested source. The source still
  // belongs in the result, but ordinary generations remain independent of
  // which member of the same project the user happened to open.
  await addSource(sourceAbsolutePath, sourceRelativePath);
  return {
    sources,
    generation: generation.digest("hex").slice(0, 32),
    incompleteReasons,
  };
}

function dependencyTargets(
  input: {
    readonly workspaceRoot: string;
    readonly rootDirectory: string;
    readonly importBase: string | null;
  },
  directive: LatexDependencyDirective,
): { readonly absolutePath: string; readonly importBase: string | null } | null {
  if (directive.command === "import" || directive.command === "subimport") {
    const parent =
      directive.command === "subimport"
        ? (input.importBase ?? input.rootDirectory)
        : input.rootDirectory;
    const directory = NodePath.resolve(parent, directive.directory ?? "");
    const absolutePath = candidatePath(directory, directive.target);
    if (absolutePath === null || workspaceRelative(input.workspaceRoot, absolutePath) === null)
      return null;
    return { absolutePath, importBase: directory };
  }
  const base = input.importBase ?? input.rootDirectory;
  const absolutePath = candidatePath(base, directive.target);
  if (absolutePath === null || workspaceRelative(input.workspaceRoot, absolutePath) === null)
    return null;
  return { absolutePath, importBase: input.importBase };
}

function rootContainsSource(
  index: ProjectIndex,
  workspaceRoot: string,
  root: IndexedLatexSource,
  sourceRelativePath: string,
): boolean {
  const rootDirectory = NodePath.dirname(NodePath.resolve(workspaceRoot, root.relativePath));
  const visited = new Set<string>();
  const visit = (relativePath: string, importBase: string | null): boolean => {
    const identity = `${relativePath}\0${importBase ?? ""}`;
    if (visited.has(identity)) return false;
    visited.add(identity);
    if (relativePath === sourceRelativePath) return true;
    const source = index.sources.get(relativePath);
    if (source === undefined) return false;
    for (const directive of source.directives) {
      const target = dependencyTargets({ workspaceRoot, rootDirectory, importBase }, directive);
      if (target === null) continue;
      const targetRelative = workspaceRelative(workspaceRoot, target.absolutePath);
      if (targetRelative !== null && visit(targetRelative, target.importBase)) return true;
    }
    return false;
  };
  return visit(root.relativePath, null);
}

function addCandidate(
  candidates: Map<string, { evidence: Set<ScientLatexRootEvidenceKind>; self: boolean }>,
  rootRelativePath: string,
  evidence: ScientLatexRootEvidenceKind,
  independentlyCompilable: boolean,
): void {
  const current = candidates.get(rootRelativePath);
  if (current === undefined) {
    candidates.set(rootRelativePath, {
      evidence: new Set([evidence]),
      self: independentlyCompilable,
    });
  } else {
    current.evidence.add(evidence);
    current.self ||= independentlyCompilable;
  }
}

function renderedCandidates(
  candidates: ReadonlyMap<
    string,
    { evidence: ReadonlySet<ScientLatexRootEvidenceKind>; self: boolean }
  >,
): ReadonlyArray<ScientLatexRootCandidate> {
  return [...candidates.entries()]
    .toSorted(([left], [right]) => left.localeCompare(right))
    .slice(0, MAX_CANDIDATES)
    .map(([rootRelativePath, candidate]) => ({
      rootRelativePath,
      evidence: [...candidate.evidence],
      independentlyCompilable: candidate.self,
    }));
}

export async function resolveLatexDocument(
  input: ScientLatexResolveRequest,
): Promise<ScientLatexResolveResult> {
  const workspaceRoot = NodePath.resolve(input.workspaceRoot);
  if (NodePath.isAbsolute(input.sourceRelativePath))
    throw new Error("LaTeX source path must be relative.");
  const sourceRelativePath = workspaceRelative(
    workspaceRoot,
    NodePath.resolve(workspaceRoot, input.sourceRelativePath),
  );
  if (sourceRelativePath === null || !isLatexSourcePath(sourceRelativePath)) {
    throw new Error("LaTeX source path must stay inside the workspace and name a source file.");
  }

  const index = await buildProjectIndex(workspaceRoot, sourceRelativePath);
  const source = index.sources.get(sourceRelativePath);
  const incompleteReasons = [...index.incompleteReasons];
  const complete = incompleteReasons.length === 0;
  const candidates = new Map<
    string,
    { evidence: Set<ScientLatexRootEvidenceKind>; self: boolean }
  >();

  for (const root of index.sources.values()) {
    if (!root.documentRoot || root.relativePath === sourceRelativePath) continue;
    if (rootContainsSource(index, workspaceRoot, root, sourceRelativePath)) {
      addCandidate(candidates, root.relativePath, "static-dependency", true);
    }
  }

  const shared = () => ({
    sourceRelativePath,
    candidates: renderedCandidates(candidates),
    indexGeneration: index.generation || "empty",
    complete,
    incompleteReasons,
  });

  const contextPath = input.contextRootRelativePath;
  if (contextPath !== undefined && !NodePath.isAbsolute(contextPath)) {
    const normalized = workspaceRelative(
      workspaceRoot,
      NodePath.resolve(workspaceRoot, contextPath),
    );
    const contextSource = normalized === null ? undefined : index.sources.get(normalized);
    if (normalized !== null && contextSource !== undefined) {
      addCandidate(candidates, normalized, "context", contextSource.documentRoot);
      return {
        _tag: "resolved",
        ...shared(),
        rootRelativePath: normalized,
        reason: "context",
      };
    }
  }

  if (source !== undefined) {
    const local = resolveLatexRoot({ relativePath: sourceRelativePath, contents: source.contents });
    if (local.reason === "magic-comment") {
      const rootRelativePath = workspaceRelative(
        workspaceRoot,
        NodePath.resolve(workspaceRoot, local.rootRelativePath),
      );
      if (rootRelativePath !== null && index.sources.has(rootRelativePath)) {
        const root = index.sources.get(rootRelativePath)!;
        addCandidate(candidates, rootRelativePath, "magic-comment", root.documentRoot);
        return {
          _tag: "resolved",
          ...shared(),
          rootRelativePath,
          reason: "magic-comment",
        };
      }
    }
    if (source.documentRoot) {
      addCandidate(candidates, sourceRelativePath, "self-document", true);
      return {
        _tag: "resolved",
        ...shared(),
        rootRelativePath: sourceRelativePath,
        reason: "self-document",
      };
    }
  }

  const inferred = renderedCandidates(candidates);
  if (complete && inferred.length === 1) {
    return {
      _tag: "resolved",
      ...shared(),
      rootRelativePath: inferred[0]!.rootRelativePath,
      reason: "static-dependency",
    };
  }
  return {
    _tag: inferred.length > 1 ? "ambiguous" : "unresolved",
    ...shared(),
  };
}
