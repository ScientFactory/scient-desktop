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
const MAX_INDEX_ENTRIES = 20_000;
const MAX_SOURCE_BYTES = 1_048_576;
const MAX_TOTAL_SOURCE_BYTES = 24 * 1_048_576;
const MAX_DIRECTORY_DEPTH = 32;
const MAX_CANDIDATES = 64;
const MAX_DEPENDENCY_DIRECTIVES_PER_SOURCE = 10_000;
const MAX_GRAPH_STEPS = 100_000;

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
  readonly documentRoot: boolean;
  readonly explicitRootRelativePath: string | null;
  readonly directives: ReadonlyArray<LatexDependencyDirective>;
  readonly incompleteReasons: ReadonlySet<ScientLatexResolutionIncompleteReason>;
}

interface ProjectIndex {
  readonly sources: ReadonlyMap<string, IndexedLatexSource>;
  readonly generation: string;
  readonly skippedSymlinkPaths: ReadonlySet<string>;
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

async function isSafeWorkspaceSourceFile(
  workspaceRoot: string,
  relativePath: string,
): Promise<boolean> {
  if (!isLatexSourcePath(relativePath)) return false;
  let current = workspaceRoot;
  for (const segment of toPosix(relativePath).split("/").slice(0, -1)) {
    current = NodePath.join(current, segment);
    try {
      const info = await NodeFSP.lstat(current);
      if (info.isSymbolicLink() || !info.isDirectory()) return false;
    } catch {
      return false;
    }
  }
  try {
    const info = await NodeFSP.lstat(NodePath.join(workspaceRoot, relativePath));
    return info.isFile() && !info.isSymbolicLink();
  } catch {
    return false;
  }
}

/** Removes syntax regions where dependency-looking text is literal rather than executable TeX. */
function latexDependencySource(source: string): string {
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
  readonly visibleSource: string;
  readonly directives: ReadonlyArray<LatexDependencyDirective>;
  readonly incompleteReasons: ReadonlySet<ScientLatexResolutionIncompleteReason>;
} {
  const visible = latexDependencySource(source);
  const directives: LatexDependencyDirective[] = [];
  const matchedCommands: Array<{ readonly from: number; readonly to: number }> = [];
  const incompleteReasons = new Set<ScientLatexResolutionIncompleteReason>();
  let directiveLimitReached = false;
  const pattern =
    /\\(?:(input|include|subfile)\s*\{([^{}]+)\}|(import|subimport)\s*\{([^{}]+)\}\s*\{([^{}]+)\})/gu;
  for (const match of visible.matchAll(pattern)) {
    if (matchedCommands.length >= MAX_DEPENDENCY_DIRECTIVES_PER_SOURCE) {
      incompleteReasons.add("scan-limit");
      directiveLimitReached = true;
      break;
    }
    const simple = match[1] as LatexDependencyDirective["command"] | undefined;
    const imported = match[3] as LatexDependencyDirective["command"] | undefined;
    const command = simple ?? imported;
    if (command === undefined) continue;
    const directory = imported === undefined ? null : (match[4] ?? "").trim();
    const target = (simple === undefined ? (match[5] ?? "") : (match[2] ?? "")).trim();
    matchedCommands.push({ from: match.index, to: match.index + match[0].length });
    if (
      target.includes("\\") ||
      target.includes("#") ||
      directory?.includes("\\") === true ||
      directory?.includes("#") === true
    ) {
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
  if (!directiveLimitReached) {
    let matchedIndex = 0;
    for (const match of visible.matchAll(commandPattern)) {
      while (
        matchedIndex < matchedCommands.length &&
        match.index >= matchedCommands[matchedIndex]!.to
      ) {
        matchedIndex += 1;
      }
      const matched = matchedCommands[matchedIndex];
      if (matched === undefined || match.index < matched.from || match.index >= matched.to) {
        incompleteReasons.add("dynamic-input");
      }
    }
  }
  const unsupportedPattern =
    /\\(?:InputIfFileExists|(?:sub)?(?:input|include)from|subfileinclude)\b/iu;
  if (unsupportedPattern.test(visible)) incompleteReasons.add("unsupported-command");
  return { visibleSource: visible, directives, incompleteReasons };
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
  const sourceHashes = new Map<string, string>();
  const skippedSymlinkPaths = new Set<string>();
  const incompleteReasons = new Set<ScientLatexResolutionIncompleteReason>();
  let fileCount = 0;
  let entryCount = 0;
  let totalBytes = 0;
  let scanStopped = false;

  const addSource = async (absolutePath: string, relativePath: string): Promise<void> => {
    if (sources.has(relativePath)) return;
    let info: Awaited<ReturnType<typeof NodeFSP.lstat>>;
    try {
      info = await NodeFSP.lstat(absolutePath);
    } catch {
      incompleteReasons.add("unreadable-file");
      return;
    }
    if (info.isSymbolicLink()) {
      incompleteReasons.add("unreadable-file");
      return;
    }
    if (!info.isFile()) return;
    if (info.size > MAX_SOURCE_BYTES) {
      incompleteReasons.add("file-too-large");
      return;
    }
    if (info.size > MAX_TOTAL_SOURCE_BYTES - totalBytes) {
      incompleteReasons.add("scan-limit");
      scanStopped = true;
      return;
    }
    let contents: string;
    let sourceByteLength = 0;
    try {
      const file = await NodeFSP.open(absolutePath, "r");
      try {
        const bytes = Buffer.alloc(Math.min(MAX_SOURCE_BYTES + 1, Math.max(1, info.size + 1)));
        let bytesRead = 0;
        while (bytesRead < bytes.byteLength) {
          const result = await file.read(bytes, bytesRead, bytes.byteLength - bytesRead, bytesRead);
          if (result.bytesRead === 0) break;
          bytesRead += result.bytesRead;
        }
        if (bytesRead > MAX_SOURCE_BYTES) {
          incompleteReasons.add("file-too-large");
          return;
        }
        const currentInfo = await file.stat();
        if (
          currentInfo.dev !== info.dev ||
          currentInfo.ino !== info.ino ||
          currentInfo.size !== info.size ||
          currentInfo.mtimeMs !== info.mtimeMs ||
          currentInfo.ctimeMs !== info.ctimeMs ||
          bytesRead !== info.size
        ) {
          incompleteReasons.add("unreadable-file");
          return;
        }
        sourceByteLength = bytesRead;
        contents = bytes.toString("utf8", 0, bytesRead);
      } finally {
        await file.close();
      }
    } catch {
      incompleteReasons.add("unreadable-file");
      return;
    }
    totalBytes += sourceByteLength;
    if (totalBytes > MAX_TOTAL_SOURCE_BYTES) {
      incompleteReasons.add("scan-limit");
      scanStopped = true;
      return;
    }
    const parsed = parseLatexDependencyDirectives(contents);
    sourceHashes.set(relativePath, NodeCrypto.createHash("sha256").update(contents).digest("hex"));
    const rootResolution = resolveLatexRoot({ relativePath, contents });
    const documentRoot =
      rootResolution.reason === "documentclass" ||
      /\\begin\s*\{document\}/u.test(parsed.visibleSource);
    sources.set(relativePath, {
      relativePath,
      documentRoot,
      explicitRootRelativePath:
        rootResolution.reason === "magic-comment" ? rootResolution.rootRelativePath : null,
      directives: parsed.directives,
      incompleteReasons: parsed.incompleteReasons,
    });
  };

  const sourceAbsolutePath = NodePath.resolve(workspaceRoot, sourceRelativePath);

  // Include the requested source before the bounded project walk. This keeps
  // the result useful even when the walk hits a limit before reaching it.
  if (await isSafeWorkspaceSourceFile(workspaceRoot, sourceRelativePath)) {
    await addSource(sourceAbsolutePath, sourceRelativePath);
  } else {
    incompleteReasons.add("unreadable-file");
  }

  const visit = async (directory: string, depth: number): Promise<void> => {
    if (scanStopped) return;
    if (depth > MAX_DIRECTORY_DEPTH || fileCount >= MAX_INDEX_FILES) {
      incompleteReasons.add("scan-limit");
      scanStopped = true;
      return;
    }
    let entries: NodeFS.Dir;
    try {
      entries = await NodeFSP.opendir(directory, { encoding: "utf8" });
    } catch {
      incompleteReasons.add("unreadable-file");
      return;
    }
    try {
      for await (const entry of entries) {
        entryCount += 1;
        if (entryCount > MAX_INDEX_ENTRIES) {
          incompleteReasons.add("scan-limit");
          scanStopped = true;
          return;
        }
        if (fileCount >= MAX_INDEX_FILES) {
          incompleteReasons.add("scan-limit");
          scanStopped = true;
          return;
        }
        const absolutePath = NodePath.join(directory, entry.name);
        if (entry.isSymbolicLink()) {
          const relativePath = workspaceRelative(workspaceRoot, absolutePath);
          if (relativePath !== null) skippedSymlinkPaths.add(relativePath);
          continue;
        }
        if (entry.isDirectory()) {
          if (!IGNORED_DIRECTORIES.has(entry.name)) await visit(absolutePath, depth + 1);
          if (scanStopped) return;
          continue;
        }
        if (!entry.isFile()) continue;
        const relativePath = workspaceRelative(workspaceRoot, absolutePath);
        if (relativePath === null || !isLatexSourcePath(relativePath)) continue;
        fileCount += 1;
        await addSource(absolutePath, relativePath);
        if (scanStopped) return;
      }
    } catch {
      incompleteReasons.add("unreadable-file");
    }
  };
  await visit(workspaceRoot, 0);
  const generation = NodeCrypto.createHash("sha256");
  for (const [path, hash] of [...sourceHashes].sort(([left], [right]) => left.localeCompare(right))) {
    generation.update(path).update("\0").update(hash).update("\0");
  }
  return {
    sources,
    generation: generation.digest("hex").slice(0, 32),
    skippedSymlinkPaths,
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
  budget: { steps: number },
): {
  readonly contains: boolean;
  readonly incompleteReasons: ReadonlySet<ScientLatexResolutionIncompleteReason>;
} {
  const rootDirectory = NodePath.dirname(NodePath.resolve(workspaceRoot, root.relativePath));
  const incompleteReasons = new Set<ScientLatexResolutionIncompleteReason>();
  const pending: Array<{ readonly relativePath: string; readonly importBase: string | null }> = [];
  const scheduled = new Set<string>();
  const enqueue = (relativePath: string, importBase: string | null): void => {
    const identity = `${relativePath}\0${importBase ?? ""}`;
    if (scheduled.has(identity)) return;
    scheduled.add(identity);
    pending.push({ relativePath, importBase });
  };
  enqueue(root.relativePath, null);
  let contains = false;
  const takeStep = (): boolean => {
    budget.steps += 1;
    if (budget.steps <= MAX_GRAPH_STEPS) return true;
    incompleteReasons.add("scan-limit");
    return false;
  };
  while (pending.length > 0) {
    if (!takeStep()) break;
    const { relativePath, importBase } = pending.pop()!;
    if (relativePath === sourceRelativePath) {
      contains = true;
      continue;
    }
    const source = index.sources.get(relativePath);
    if (source === undefined) continue;
    for (const reason of source.incompleteReasons) incompleteReasons.add(reason);
    for (const directive of source.directives) {
      if (!takeStep()) return { contains, incompleteReasons };
      const target = dependencyTargets({ workspaceRoot, rootDirectory, importBase }, directive);
      if (target === null) {
        incompleteReasons.add("unsupported-command");
        continue;
      }
      const targetRelative = workspaceRelative(workspaceRoot, target.absolutePath);
      if (targetRelative === null) {
        incompleteReasons.add("unsupported-command");
        continue;
      }
      let ancestor = targetRelative;
      let usesSkippedSymlink = false;
      while (ancestor !== ".") {
        if (index.skippedSymlinkPaths.has(ancestor)) {
          incompleteReasons.add("unreadable-file");
          usesSkippedSymlink = true;
          break;
        }
        const parent = NodePath.posix.dirname(ancestor);
        if (parent === ancestor) break;
        ancestor = parent;
      }
      if (usesSkippedSymlink) continue;
      enqueue(targetRelative, target.importBase);
    }
  }
  return { contains, incompleteReasons };
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
  const incompleteReasons = new Set(index.incompleteReasons);
  const candidates = new Map<
    string,
    { evidence: Set<ScientLatexRootEvidenceKind>; self: boolean }
  >();
  // Bound the total work across every possible root, including import-base variants.
  const graphBudget = { steps: 0 };

  for (const root of index.sources.values()) {
    if (!root.documentRoot || root.relativePath === sourceRelativePath) continue;
    const relation = rootContainsSource(
      index,
      workspaceRoot,
      root,
      sourceRelativePath,
      graphBudget,
    );
    for (const reason of relation.incompleteReasons) incompleteReasons.add(reason);
    if (relation.contains) {
      addCandidate(candidates, root.relativePath, "static-dependency", true);
    }
    if (graphBudget.steps > MAX_GRAPH_STEPS) break;
  }
  if (candidates.size === 0 && incompleteReasons.size > 0) {
    for (const root of index.sources.values()) {
      if (root.documentRoot) {
        addCandidate(candidates, root.relativePath, "project-document", true);
      }
    }
  }
  if (candidates.size > MAX_CANDIDATES) incompleteReasons.add("scan-limit");
  const complete = incompleteReasons.size === 0;

  const shared = () => ({
    sourceRelativePath,
    candidates: renderedCandidates(candidates),
    indexGeneration: index.generation,
    complete,
    incompleteReasons: [...incompleteReasons],
  });

  const contextPath = input.contextRootRelativePath;
  if (contextPath !== undefined && !NodePath.isAbsolute(contextPath)) {
    const normalized = workspaceRelative(
      workspaceRoot,
      NodePath.resolve(workspaceRoot, contextPath),
    );
    if (normalized !== null && (await isSafeWorkspaceSourceFile(workspaceRoot, normalized))) {
      addCandidate(
        candidates,
        normalized,
        "context",
        index.sources.get(normalized)?.documentRoot ?? true,
      );
      return {
        _tag: "resolved",
        ...shared(),
        rootRelativePath: normalized,
        reason: "context",
      };
    }
  }

  if (source !== undefined) {
    if (source.explicitRootRelativePath !== null) {
      const rootRelativePath = workspaceRelative(
        workspaceRoot,
        NodePath.resolve(workspaceRoot, source.explicitRootRelativePath),
      );
      if (
        rootRelativePath !== null &&
        (index.sources.has(rootRelativePath) ||
          (await isSafeWorkspaceSourceFile(workspaceRoot, rootRelativePath)))
      ) {
        const root = index.sources.get(rootRelativePath);
        addCandidate(candidates, rootRelativePath, "magic-comment", root?.documentRoot ?? true);
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
  if (inferred.length > 1) return { _tag: "ambiguous", ...shared() };
  return { _tag: "unresolved", ...shared() };
}
