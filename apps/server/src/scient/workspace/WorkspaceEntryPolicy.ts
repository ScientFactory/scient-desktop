export interface WorkspaceEntryDisposition {
  readonly visibility: "ordinary" | "internal";
  readonly mutation: "files" | "owner";
  readonly reasonCode: string;
}

const ordinary = (reasonCode: string, mutation: WorkspaceEntryDisposition["mutation"] = "files") =>
  ({ visibility: "ordinary", mutation, reasonCode }) satisfies WorkspaceEntryDisposition;

const internal = (reasonCode: string) =>
  ({ visibility: "internal", mutation: "owner", reasonCode }) satisfies WorkspaceEntryDisposition;

const INTERNAL_SEGMENTS = new Map<string, string>([
  [".git", "tool.git"],
  [".svn", "tool.svn"],
  [".hg", "tool.hg"],
  [".jj", "tool.jj"],
  ["CVS", "tool.cvs"],
  ["node_modules", "dependency.node-modules"],
  [".pnpm-store", "dependency.pnpm-store"],
  [".venv", "dependency.python-venv"],
  ["venv", "dependency.python-venv"],
  ["__pycache__", "cache.python-bytecode"],
  [".pytest_cache", "cache.pytest"],
  [".mypy_cache", "cache.mypy"],
  [".ruff_cache", "cache.ruff"],
  [".tox", "cache.tox"],
  [".nox", "cache.nox"],
]);

function normalizedSegments(relativePath: string): string[] {
  return relativePath
    .replaceAll("\\", "/")
    .split("/")
    .filter((segment) => segment.length > 0 && segment !== ".");
}

/**
 * Classifies one already-confined workspace-relative path for the Files UI.
 * Root confinement is deliberately owned by WorkspacePaths, before this pure
 * presentation and mutation policy runs.
 */
export function workspaceEntryDisposition(relativePath: string): WorkspaceEntryDisposition {
  const segments = normalizedSegments(relativePath);
  if (segments.length === 0) return ordinary("workspace.root");

  if (segments[0] === ".scient-next") {
    return internal("scient.runtime-state");
  }

  for (const segment of segments) {
    const reasonCode = INTERNAL_SEGMENTS.get(segment);
    if (reasonCode !== undefined) return internal(reasonCode);
  }

  if (segments.some((segment) => segment === ".DS_Store")) {
    return internal("os.metadata");
  }

  if (segments.some((segment, index) => segment === ".yarn" && segments[index + 1] === "cache")) {
    return internal("dependency.yarn-cache");
  }

  if (segments[0] !== ".scient") {
    return ordinary("workspace.project-material");
  }

  if (segments.length === 1) {
    return ordinary("scient.container", "owner");
  }

  if (segments[1] === "skills") {
    return ordinary("scient.project-skill");
  }

  if (segments[1] === "sources") {
    return internal("scient.sources-store");
  }

  const scientPath = segments.join("/");
  if (scientPath === ".scient/project.json") {
    return ordinary("scient.project-identity", "owner");
  }
  if (scientPath === ".scient/skills.lock.json") {
    return ordinary("scient.skills-lock", "owner");
  }
  if (
    scientPath === ".scient/project-init.json" ||
    scientPath === ".scient/init-transaction.json"
  ) {
    return internal("scient.project-transaction");
  }

  return ordinary("scient.unknown-project-material");
}
