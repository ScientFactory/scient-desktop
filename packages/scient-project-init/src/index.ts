// @effect-diagnostics nodeBuiltinImport:off -- This package is the filesystem boundary for project setup.
// @effect-diagnostics globalDate:off -- Project manifests record interoperable ISO timestamps.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { renderAgentsTemplate, renderProjectTemplate } from "./templates.ts";

export { renderAgentsTemplate, renderProjectTemplate } from "./templates.ts";

export const SCIENT_PROJECT_FILE = "PROJECT.md";
export const SCIENT_AGENTS_FILE = "AGENTS.md";
export const SCIENT_IDENTITY_FILE = ".scient/project.json";
export const SCIENT_TRANSACTION_FILE = ".scient/project-init.json";
export const SCIENT_PREVIOUS_TRANSACTION_FILE = ".scient/init-transaction.json";

const PROJECT_SCHEMA_VERSION = 1;
const TRANSACTION_SCHEMA_VERSION = 1;
const MAX_IDENTITY_BYTES = 64 * 1024;
const MAX_TRANSACTION_BYTES = 1024 * 1024;
const MAX_GENERATED_FILE_BYTES = 1024 * 1024;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const initializationByRoot = new Map<string, Promise<ScientProjectInitializationResult>>();

export type ScientProjectState = "ordinary" | "initialized" | "recoverable" | "conflicting";

export interface ScientProjectIssue {
  readonly path: string;
  readonly message: string;
}

export interface ScientProjectInspection {
  readonly root: string;
  readonly state: ScientProjectState;
  readonly canInitialize: boolean;
  readonly issues: ReadonlyArray<ScientProjectIssue>;
  readonly existingFiles: ReadonlyArray<string>;
}

export interface ScientProjectInitializationResult extends ScientProjectInspection {
  readonly created: ReadonlyArray<string>;
  readonly preserved: ReadonlyArray<string>;
}

export interface ScientProjectIdentity {
  readonly projectId: string;
  readonly formatVersion: 1;
  readonly createdAt: string;
}

type ProjectIdentity = ScientProjectIdentity;

interface TransactionFileEntry {
  readonly path: string;
  readonly content: string;
  readonly sha256: string;
}

interface ProjectInitializationTransaction {
  readonly schemaVersion: 1;
  readonly operationId: string;
  readonly createdAt: string;
  readonly title: string;
  readonly identity: ProjectIdentity;
  readonly files: ReadonlyArray<TransactionFileEntry>;
}

function sha256(content: string): string {
  return NodeCrypto.createHash("sha256").update(content).digest("hex");
}

function stableJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function projectTitle(root: string, requestedTitle?: string): string {
  const requested = requestedTitle?.trim();
  if (requested) return requested;
  return NodePath.basename(root.replace(/[\\/]+$/u, "")) || "Untitled project";
}

type KnownPathSnapshot =
  | { readonly kind: "missing" }
  | { readonly kind: "file"; readonly size: number }
  | { readonly kind: "directory" }
  | { readonly kind: "symlink" }
  | { readonly kind: "other" };

async function snapshotPath(filePath: string): Promise<KnownPathSnapshot> {
  try {
    const value = await NodeFSP.lstat(filePath);
    if (value.isSymbolicLink()) return { kind: "symlink" };
    if (value.isFile()) return { kind: "file", size: value.size };
    if (value.isDirectory()) return { kind: "directory" };
    return { kind: "other" };
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return { kind: "missing" };
    throw error;
  }
}

async function readBoundedFile(filePath: string, maximumBytes: number): Promise<string> {
  const snapshot = await snapshotPath(filePath);
  if (snapshot.kind !== "file") {
    throw new Error(`${NodePath.basename(filePath)} is not a regular file.`);
  }
  if (snapshot.size > maximumBytes) {
    throw new Error(`${NodePath.basename(filePath)} exceeds the safe setup size limit.`);
  }
  return NodeFSP.readFile(filePath, "utf8");
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}

function parseIdentity(content: string): ProjectIdentity | null {
  try {
    const value: unknown = JSON.parse(content);
    if (typeof value !== "object" || value === null) return null;
    const candidate = value as Record<string, unknown>;
    if (
      candidate.formatVersion !== PROJECT_SCHEMA_VERSION ||
      typeof candidate.projectId !== "string" ||
      !UUID_PATTERN.test(candidate.projectId) ||
      typeof candidate.createdAt !== "string" ||
      !Number.isFinite(Date.parse(candidate.createdAt))
    ) {
      return null;
    }
    return candidate as unknown as ProjectIdentity;
  } catch {
    return null;
  }
}

function parseTransaction(content: string): ProjectInitializationTransaction | null {
  try {
    const value: unknown = JSON.parse(content);
    if (typeof value !== "object" || value === null) return null;
    const candidate = value as Record<string, unknown>;
    if (
      candidate.schemaVersion !== TRANSACTION_SCHEMA_VERSION ||
      typeof candidate.operationId !== "string" ||
      !UUID_PATTERN.test(candidate.operationId) ||
      typeof candidate.createdAt !== "string" ||
      !Number.isFinite(Date.parse(candidate.createdAt)) ||
      typeof candidate.title !== "string" ||
      candidate.title.trim().length === 0 ||
      !parseIdentity(stableJson(candidate.identity)) ||
      !Array.isArray(candidate.files)
    ) {
      return null;
    }
    const paths = new Set<string>();
    for (const entry of candidate.files) {
      if (typeof entry !== "object" || entry === null) return null;
      const file = entry as Record<string, unknown>;
      if (
        (file.path !== SCIENT_PROJECT_FILE && file.path !== SCIENT_AGENTS_FILE) ||
        typeof file.content !== "string" ||
        typeof file.sha256 !== "string" ||
        file.sha256 !== sha256(file.content) ||
        paths.has(file.path)
      ) {
        return null;
      }
      paths.add(file.path);
    }
    return candidate as unknown as ProjectInitializationTransaction;
  } catch {
    return null;
  }
}

async function validateRoot(root: string, createIfMissing: boolean): Promise<string> {
  const trimmedRoot = root.trim();
  if (trimmedRoot.length === 0) throw new Error("Enter a project folder path.");
  const expandedRoot =
    trimmedRoot === "~"
      ? NodeOS.homedir()
      : trimmedRoot.startsWith("~/") || trimmedRoot.startsWith("~\\")
        ? NodePath.join(NodeOS.homedir(), trimmedRoot.slice(2))
        : trimmedRoot;
  const normalized = NodePath.resolve(expandedRoot);
  if (createIfMissing) await NodeFSP.mkdir(normalized, { recursive: true });
  let rootStat;
  try {
    rootStat = await NodeFSP.stat(normalized);
  } catch (error) {
    if (!createIfMissing && isNodeError(error, "ENOENT")) return normalized;
    throw error;
  }
  if (!rootStat.isDirectory()) throw new Error("The project path is not a directory.");
  return await NodeFSP.realpath(normalized);
}

async function inspectResolvedRoot(root: string): Promise<ScientProjectInspection> {
  const [projectFile, agentsFile, metadataDirectory] = await Promise.all([
    snapshotPath(NodePath.join(root, SCIENT_PROJECT_FILE)),
    snapshotPath(NodePath.join(root, SCIENT_AGENTS_FILE)),
    snapshotPath(NodePath.join(root, ".scient")),
  ]);
  const [identityFile, transactionFile, previousTransactionFile] =
    metadataDirectory.kind === "directory"
      ? await Promise.all([
          snapshotPath(NodePath.join(root, SCIENT_IDENTITY_FILE)),
          snapshotPath(NodePath.join(root, SCIENT_TRANSACTION_FILE)),
          snapshotPath(NodePath.join(root, SCIENT_PREVIOUS_TRANSACTION_FILE)),
        ])
      : ([{ kind: "missing" }, { kind: "missing" }, { kind: "missing" }] as const);
  const knownPaths = [
    [SCIENT_PROJECT_FILE, projectFile],
    [SCIENT_AGENTS_FILE, agentsFile],
    [SCIENT_IDENTITY_FILE, identityFile],
    [SCIENT_TRANSACTION_FILE, transactionFile],
    [SCIENT_PREVIOUS_TRANSACTION_FILE, previousTransactionFile],
  ] as const;
  const existingFiles = knownPaths
    .filter(([, snapshot]) => snapshot.kind !== "missing")
    .map(([relativePath]) => relativePath);
  const issues: ScientProjectIssue[] = [];
  let identity: ProjectIdentity | null = null;
  let identityContents: string | null = null;
  let transaction: ProjectInitializationTransaction | null = null;

  if (metadataDirectory.kind !== "missing" && metadataDirectory.kind !== "directory") {
    issues.push({
      path: ".scient",
      message: "The Scient metadata path is not a real directory and will not be modified.",
    });
  }

  for (const [relativePath, snapshot] of knownPaths) {
    if (snapshot.kind !== "missing" && snapshot.kind !== "file") {
      issues.push({
        path: relativePath,
        message: "This setup path is not a regular file and will not be modified.",
      });
    }
  }

  if (identityFile.kind === "file") {
    try {
      identityContents = await readBoundedFile(
        NodePath.join(root, SCIENT_IDENTITY_FILE),
        MAX_IDENTITY_BYTES,
      );
      identity = parseIdentity(identityContents);
    } catch {
      identity = null;
    }
    if (identity === null) {
      issues.push({
        path: SCIENT_IDENTITY_FILE,
        message: "The existing Scient project identity is not valid and will not be replaced.",
      });
    }
  }

  if (transactionFile.kind === "file") {
    try {
      transaction = parseTransaction(
        await readBoundedFile(NodePath.join(root, SCIENT_TRANSACTION_FILE), MAX_TRANSACTION_BYTES),
      );
    } catch {
      transaction = null;
    }
    if (transaction === null) {
      issues.push({
        path: SCIENT_TRANSACTION_FILE,
        message: "The interrupted setup record is not valid and cannot be resumed automatically.",
      });
    }
  }

  if (previousTransactionFile.kind === "file") {
    issues.push({
      path: SCIENT_PREVIOUS_TRANSACTION_FILE,
      message:
        "An unfinished setup from the previous Scient app must be recovered or rolled back there before this app writes project files.",
    });
  }

  if (transaction) {
    for (const file of transaction.files) {
      const currentPath = NodePath.join(root, file.path);
      const currentSnapshot = await snapshotPath(currentPath);
      if (currentSnapshot.kind === "missing") continue;
      let matches = false;
      if (currentSnapshot.kind === "file" && currentSnapshot.size <= MAX_GENERATED_FILE_BYTES) {
        matches =
          sha256(await readBoundedFile(currentPath, MAX_GENERATED_FILE_BYTES)) === file.sha256;
      }
      if (!matches) {
        issues.push({
          path: file.path,
          message:
            "This file changed after setup began, so Scient will preserve it and stop recovery.",
        });
      }
    }
    if (identity && identityContents !== stableJson(transaction.identity)) {
      issues.push({
        path: SCIENT_IDENTITY_FILE,
        message: "The project identity does not exactly match the interrupted setup record.",
      });
    }
  }

  if (issues.length > 0) {
    return { root, state: "conflicting", canInitialize: false, issues, existingFiles };
  }
  if (transaction) {
    return { root, state: "recoverable", canInitialize: true, issues: [], existingFiles };
  }
  if (identity) {
    return { root, state: "initialized", canInitialize: false, issues: [], existingFiles };
  }
  return { root, state: "ordinary", canInitialize: true, issues: [], existingFiles };
}

export async function inspectScientProject(root: string): Promise<ScientProjectInspection> {
  return inspectResolvedRoot(await validateRoot(root, false));
}

/** Read the durable identity without initializing or repairing an ordinary folder. */
export async function readScientProjectIdentity(
  root: string,
): Promise<ScientProjectIdentity | null> {
  const resolvedRoot = await validateRoot(root, false);
  const identityPath = NodePath.join(resolvedRoot, SCIENT_IDENTITY_FILE);
  const snapshot = await snapshotPath(identityPath);
  if (snapshot.kind === "missing") return null;
  if (snapshot.kind !== "file" || snapshot.size > MAX_IDENTITY_BYTES) return null;
  return parseIdentity(await readBoundedFile(identityPath, MAX_IDENTITY_BYTES));
}

async function writeMissingFile(
  filePath: string,
  content: string,
): Promise<"created" | "preserved"> {
  try {
    await NodeFSP.writeFile(filePath, content, { encoding: "utf8", flag: "wx" });
    return "created";
  } catch (error) {
    if (!isNodeError(error, "EEXIST")) throw error;
    const current = await readBoundedFile(filePath, MAX_GENERATED_FILE_BYTES);
    if (current === content) return "preserved";
    throw new Error(
      `${NodePath.basename(filePath)} changed while the project was being initialized.`,
      {
        cause: error,
      },
    );
  }
}

async function initializeResolvedRoot(
  root: string,
  requestedTitle?: string,
): Promise<ScientProjectInitializationResult> {
  const initialInspection = await inspectResolvedRoot(root);
  if (initialInspection.state === "conflicting") {
    return { ...initialInspection, created: [], preserved: initialInspection.existingFiles };
  }
  if (initialInspection.state === "initialized") {
    return { ...initialInspection, created: [], preserved: initialInspection.existingFiles };
  }

  const metadataPath = NodePath.join(root, ".scient");
  try {
    await NodeFSP.mkdir(metadataPath);
  } catch (error) {
    if (!isNodeError(error, "EEXIST")) throw error;
  }
  const metadataSnapshot = await snapshotPath(metadataPath);
  if (
    metadataSnapshot.kind !== "directory" ||
    (await NodeFSP.realpath(metadataPath)) !== metadataPath
  ) {
    throw new Error("The Scient metadata path is not a safe project directory.");
  }
  const existingTransactionSnapshot = await snapshotPath(
    NodePath.join(root, SCIENT_TRANSACTION_FILE),
  );
  const existingTransaction =
    existingTransactionSnapshot.kind === "file"
      ? parseTransaction(
          await readBoundedFile(
            NodePath.join(root, SCIENT_TRANSACTION_FILE),
            MAX_TRANSACTION_BYTES,
          ),
        )
      : null;
  const title = existingTransaction?.title ?? projectTitle(root, requestedTitle);
  const now = new Date().toISOString();
  const identity: ProjectIdentity = existingTransaction?.identity ?? {
    projectId: NodeCrypto.randomUUID(),
    formatVersion: PROJECT_SCHEMA_VERSION,
    createdAt: now,
  };
  const candidateFiles = [
    { path: SCIENT_PROJECT_FILE, content: renderProjectTemplate(title) },
    { path: SCIENT_AGENTS_FILE, content: renderAgentsTemplate() },
  ];
  const files: ReadonlyArray<TransactionFileEntry> =
    existingTransaction?.files ??
    candidateFiles
      .filter((file) => !initialInspection.existingFiles.includes(file.path))
      .map((file) => ({ ...file, sha256: sha256(file.content) }));
  const transaction: ProjectInitializationTransaction = existingTransaction ?? {
    schemaVersion: TRANSACTION_SCHEMA_VERSION,
    operationId: NodeCrypto.randomUUID(),
    createdAt: now,
    title,
    identity,
    files,
  };
  const transactionContents = stableJson(transaction);
  if (!existingTransaction) {
    await NodeFSP.writeFile(NodePath.join(root, SCIENT_TRANSACTION_FILE), transactionContents, {
      encoding: "utf8",
      flag: "wx",
    });
  }

  const created: string[] = [];
  const preserved = initialInspection.existingFiles.filter(
    (file) => file !== SCIENT_TRANSACTION_FILE,
  );
  for (const file of transaction.files) {
    const outcome = await writeMissingFile(NodePath.join(root, file.path), file.content);
    (outcome === "created" ? created : preserved).push(file.path);
  }
  const identityOutcome = await writeMissingFile(
    NodePath.join(root, SCIENT_IDENTITY_FILE),
    stableJson(transaction.identity),
  );
  (identityOutcome === "created" ? created : preserved).push(SCIENT_IDENTITY_FILE);
  const currentTransactionContents = await readBoundedFile(
    NodePath.join(root, SCIENT_TRANSACTION_FILE),
    MAX_TRANSACTION_BYTES,
  );
  if (currentTransactionContents !== transactionContents) {
    throw new Error("The project setup record changed before completion and will be preserved.");
  }
  await NodeFSP.rm(NodePath.join(root, SCIENT_TRANSACTION_FILE));

  return {
    root,
    state: "initialized",
    canInitialize: false,
    issues: [],
    existingFiles: [...new Set([...preserved, ...created])],
    created,
    preserved: [...new Set(preserved)],
  };
}

export async function initializeScientProject(input: {
  readonly root: string;
  readonly title?: string;
}): Promise<ScientProjectInitializationResult> {
  const root = await validateRoot(input.root, true);
  const running = initializationByRoot.get(root);
  if (running) return running;
  const operation = initializeResolvedRoot(root, input.title).finally(() => {
    initializationByRoot.delete(root);
  });
  initializationByRoot.set(root, operation);
  return operation;
}
