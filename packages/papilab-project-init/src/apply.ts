import {
  link,
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rm,
  rmdir,
  unlink,
} from "node:fs/promises";
import path from "node:path";

import {
  assertRelativePathWithinRoot,
  isNodeError,
  resolveProjectRoot,
  snapshotPath,
  snapshotsEqual,
} from "./filesystem.ts";
import { sha256 } from "./hash.ts";
import {
  readInitializationTransaction,
  serializeInitializationTransaction,
  validateInitializationTransaction,
} from "./transaction.ts";
import {
  PAPILAB_IDENTITY_FILE,
  PAPILAB_METADATA_DIRECTORY,
  PAPILAB_TRANSACTION_FILE,
  ProjectInitializationError,
  type ApplyInitializationOptions,
  type ApplyInitializationResult,
  type ApplyStep,
  type CreateOperation,
  type InitializationPlan,
  type InitializationTransaction,
  type PreserveOperation,
  type ProposeOperation,
  type RollbackInitializationResult,
} from "./types.ts";

function transactionFromPlan(plan: InitializationPlan): InitializationTransaction {
  const operations: Array<CreateOperation | PreserveOperation> = [];
  for (const operation of plan.operations) {
    if (operation.kind === "create" || operation.kind === "preserve") {
      operations.push(operation);
    } else if (operation.kind === "propose") {
      operations.push({
        kind: "preserve",
        path: operation.path,
        reason: "Preserve the existing file until its proposed update is explicitly approved.",
        expected: operation.expected,
      });
    }
  }
  return {
    transactionVersion: 1,
    transactionId: plan.transactionId,
    projectId: plan.projectId,
    createdAt: plan.createdAt,
    profileVersions: plan.profileVersions,
    operations,
  };
}

async function syncDirectory(directoryPath: string): Promise<void> {
  try {
    const handle = await open(directoryPath, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch {
    // Some platforms do not allow fsync on directories. File fsync and the
    // recoverable transaction marker still preserve the product guarantee.
  }
}

async function writeExclusiveAtomic(input: {
  readonly root: string;
  readonly relativePath: string;
  readonly targetPath: string;
  readonly contents: string;
  readonly transactionId: string;
  readonly mode: number;
}): Promise<void> {
  const directoryPath = path.dirname(input.targetPath);
  const temporaryPath = path.join(
    directoryPath,
    `.${path.basename(input.targetPath)}.papilab-init-${input.transactionId}.tmp`,
  );
  const staleTemporary = await snapshotPath(temporaryPath);
  if (staleTemporary.kind !== "missing") {
    if (
      staleTemporary.kind !== "file" ||
      staleTemporary.sha256 !== sha256(input.contents) ||
      staleTemporary.size !== Buffer.byteLength(input.contents, "utf8")
    ) {
      throw new ProjectInitializationError(
        "RECOVERY_CONFLICT",
        `A stale temporary file conflicts with ${input.relativePath}.`,
      );
    }
    await unlink(temporaryPath);
  }
  assertCanonicalChild(input.root, await realpath(directoryPath), input.relativePath);
  const handle = await open(temporaryPath, "wx", input.mode);
  try {
    await handle.writeFile(input.contents, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    assertCanonicalChild(input.root, await realpath(directoryPath), input.relativePath);
    await link(temporaryPath, input.targetPath);
    await syncDirectory(directoryPath);
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

async function removeMatchingTemporaryFile(input: {
  readonly targetPath: string;
  readonly contents: string;
  readonly transactionId: string;
}): Promise<void> {
  const temporaryPath = path.join(
    path.dirname(input.targetPath),
    `.${path.basename(input.targetPath)}.papilab-init-${input.transactionId}.tmp`,
  );
  const observed = await snapshotPath(temporaryPath);
  if (observed.kind === "missing") return;
  if (
    observed.kind !== "file" ||
    observed.sha256 !== sha256(input.contents) ||
    observed.size !== Buffer.byteLength(input.contents, "utf8")
  ) {
    throw new ProjectInitializationError(
      "RECOVERY_CONFLICT",
      `A stale temporary file cannot be attributed safely to ${input.targetPath}.`,
    );
  }
  await unlink(temporaryPath);
}

function assertCanonicalChild(root: string, candidate: string, relativePath: string): void {
  const relative = path.relative(root, candidate);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new ProjectInitializationError(
      "PATH_ESCAPE",
      `Path resolves outside the project root: ${relativePath}`,
    );
  }
}

async function ensureSafeParentDirectories(root: string, relativePath: string): Promise<string> {
  const targetPath = assertRelativePathWithinRoot(root, relativePath);
  const segments = relativePath.split("/").slice(0, -1);
  let current = root;
  for (const segment of segments) {
    current = path.join(current, segment);
    try {
      const stat = await lstat(current);
      if (stat.isSymbolicLink() || !stat.isDirectory()) {
        throw new ProjectInitializationError(
          "PATH_ESCAPE",
          `A parent of ${relativePath} is not a real directory: ${segment}`,
        );
      }
    } catch (error) {
      if (!isNodeError(error, "ENOENT")) throw error;
      try {
        await mkdir(current, { mode: 0o755 });
      } catch (mkdirError) {
        if (!isNodeError(mkdirError, "EEXIST")) throw mkdirError;
      }
      const stat = await lstat(current);
      if (stat.isSymbolicLink() || !stat.isDirectory()) {
        throw new ProjectInitializationError(
          "PATH_ESCAPE",
          `A parent of ${relativePath} changed during initialization.`,
        );
      }
    }
    const canonicalParent = await realpath(current);
    assertCanonicalChild(root, canonicalParent, relativePath);
  }
  return targetPath;
}

async function assertOperationPrecondition(
  root: string,
  operation: CreateOperation | PreserveOperation | ProposeOperation,
): Promise<void> {
  const targetPath = assertRelativePathWithinRoot(root, operation.path);
  const observed = await snapshotPath(targetPath);
  if (operation.kind === "create") {
    if (observed.kind !== "missing") {
      throw new ProjectInitializationError(
        "CONCURRENT_CHANGE",
        `${operation.path} changed after the initialization preview.`,
      );
    }
    return;
  }
  if (!snapshotsEqual(observed, operation.expected)) {
    throw new ProjectInitializationError(
      "CONCURRENT_CHANGE",
      `${operation.path} changed after the initialization preview.`,
    );
  }
}

async function prepareMetadataDirectory(root: string): Promise<void> {
  const metadataPath = path.join(root, PAPILAB_METADATA_DIRECTORY);
  const observed = await snapshotPath(metadataPath);
  if (observed.kind === "missing") {
    try {
      await mkdir(metadataPath, { mode: 0o755 });
    } catch (error) {
      if (!isNodeError(error, "EEXIST")) throw error;
    }
  }
  const current = await snapshotPath(metadataPath);
  if (current.kind !== "directory") {
    throw new ProjectInitializationError(
      "CONCURRENT_CHANGE",
      ".papilab is no longer an available metadata directory.",
    );
  }
  const canonicalMetadata = await realpath(metadataPath);
  assertCanonicalChild(root, canonicalMetadata, PAPILAB_METADATA_DIRECTORY);
  const entries = await readdir(metadataPath);
  if (entries.length > 0) {
    throw new ProjectInitializationError(
      "CONCURRENT_CHANGE",
      ".papilab changed after the initialization preview.",
    );
  }
}

async function emitStep(
  options: ApplyInitializationOptions,
  step: ApplyStep,
): Promise<void> {
  await options.onStep?.(step);
}

async function runTransaction(input: {
  readonly root: string;
  readonly transaction: InitializationTransaction;
  readonly recovered: boolean;
  readonly options: ApplyInitializationOptions;
}): Promise<ApplyInitializationResult> {
  const creates = input.transaction.operations.filter(
    (operation): operation is CreateOperation => operation.kind === "create",
  );
  const orderedCreates = creates.toSorted((left, right) => {
    if (left.path === PAPILAB_IDENTITY_FILE) return 1;
    if (right.path === PAPILAB_IDENTITY_FILE) return -1;
    return left.path.localeCompare(right.path);
  });
  const preserved = input.transaction.operations
    .filter((operation) => operation.kind === "preserve")
    .map((operation) => operation.path);
  let stepIndex = 1;

  for (const operation of input.transaction.operations) {
    if (operation.kind !== "preserve") continue;
    const observed = await snapshotPath(assertRelativePathWithinRoot(input.root, operation.path));
    if (!snapshotsEqual(observed, operation.expected)) {
      throw new ProjectInitializationError(
        "RECOVERY_CONFLICT",
        `${operation.path} changed while initialization was incomplete.`,
      );
    }
  }

  for (const operation of orderedCreates) {
    const targetPath = await ensureSafeParentDirectories(input.root, operation.path);
    const observed = await snapshotPath(targetPath);
    const intendedHash = sha256(operation.contents);
    if (
      observed.kind === "file" &&
      observed.sha256 === intendedHash &&
      observed.size === Buffer.byteLength(operation.contents, "utf8")
    ) {
      await removeMatchingTemporaryFile({
        targetPath,
        contents: operation.contents,
        transactionId: input.transaction.transactionId,
      });
      continue;
    }
    if (observed.kind !== "missing") {
      throw new ProjectInitializationError(
        "RECOVERY_CONFLICT",
        `${operation.path} conflicts with the incomplete initialization.`,
      );
    }
    await writeExclusiveAtomic({
      root: input.root,
      relativePath: operation.path,
      targetPath,
      contents: operation.contents,
      transactionId: input.transaction.transactionId,
      mode: operation.path.startsWith(`${PAPILAB_METADATA_DIRECTORY}/`) ? 0o600 : 0o644,
    });
    await emitStep(input.options, {
      index: stepIndex,
      kind: "file-created",
      path: operation.path,
    });
    stepIndex += 1;
  }

  await unlink(path.join(input.root, PAPILAB_TRANSACTION_FILE));
  await syncDirectory(path.join(input.root, PAPILAB_METADATA_DIRECTORY));
  await emitStep(input.options, {
    index: stepIndex,
    kind: "completed",
    path: PAPILAB_TRANSACTION_FILE,
  });
  return {
    projectId: input.transaction.projectId,
    created: orderedCreates.map((operation) => operation.path),
    preserved,
    proposed: [],
    recovered: input.recovered,
  };
}

export async function applyProjectInitialization(
  plan: InitializationPlan,
  options: ApplyInitializationOptions = {},
): Promise<ApplyInitializationResult> {
  if (plan.status === "blocked") {
    throw new ProjectInitializationError(
      "APPLY_BLOCKED",
      "Initialization plan contains unresolved conflicts.",
    );
  }
  if (plan.status === "already-initialized") {
    return {
      projectId: plan.projectId,
      created: [],
      preserved: [],
      proposed: [],
      recovered: false,
    };
  }
  const root = await resolveProjectRoot(plan.root);
  if (root !== plan.root) {
    throw new ProjectInitializationError(
      "CONCURRENT_CHANGE",
      "The project root changed after the initialization preview.",
    );
  }
  const transaction = validateInitializationTransaction(transactionFromPlan(plan));
  for (const operation of transaction.operations) {
    await assertOperationPrecondition(root, operation);
  }
  await prepareMetadataDirectory(root);
  const transactionPath = await ensureSafeParentDirectories(root, PAPILAB_TRANSACTION_FILE);
  await writeExclusiveAtomic({
    root,
    relativePath: PAPILAB_TRANSACTION_FILE,
    targetPath: transactionPath,
    contents: serializeInitializationTransaction(transaction),
    transactionId: transaction.transactionId,
    mode: 0o600,
  });
  await emitStep(options, { index: 0, kind: "marker-written", path: PAPILAB_TRANSACTION_FILE });
  const result = await runTransaction({ root, transaction, recovered: false, options });
  return {
    ...result,
    proposed: plan.operations
      .filter((operation) => operation.kind === "propose")
      .map((operation) => operation.path),
  };
}

export async function recoverProjectInitialization(
  requestedRoot: string,
  options: ApplyInitializationOptions = {},
): Promise<ApplyInitializationResult> {
  const root = await resolveProjectRoot(requestedRoot);
  const transaction = await readInitializationTransaction(path.join(root, PAPILAB_TRANSACTION_FILE));
  return runTransaction({ root, transaction, recovered: true, options });
}

async function removeEmptyCreatedParents(root: string, relativePaths: readonly string[]): Promise<void> {
  const candidates = new Set<string>();
  for (const relativePath of relativePaths) {
    const segments = relativePath.split("/").slice(0, -1);
    while (segments.length > 0) {
      const candidate = segments.join("/");
      if (candidate !== PAPILAB_METADATA_DIRECTORY) candidates.add(candidate);
      segments.pop();
    }
  }
  const ordered = [...candidates].toSorted((left, right) => right.length - left.length);
  for (const relativePath of ordered) {
    try {
      await rmdir(assertRelativePathWithinRoot(root, relativePath));
    } catch (error) {
      if (!isNodeError(error, "ENOENT") && !isNodeError(error, "ENOTEMPTY")) throw error;
    }
  }
}

export async function rollbackProjectInitialization(
  requestedRoot: string,
): Promise<RollbackInitializationResult> {
  const root = await resolveProjectRoot(requestedRoot);
  const transactionPath = path.join(root, PAPILAB_TRANSACTION_FILE);
  const transaction = await readInitializationTransaction(transactionPath);
  const removed: string[] = [];
  const preserved: string[] = [];
  const createOperations = transaction.operations
    .filter((operation): operation is CreateOperation => operation.kind === "create")
    .toReversed();
  for (const operation of createOperations) {
    const targetPath = assertRelativePathWithinRoot(root, operation.path);
    const observed = await snapshotPath(targetPath);
    await removeMatchingTemporaryFile({
      targetPath,
      contents: operation.contents,
      transactionId: transaction.transactionId,
    });
    if (observed.kind === "missing") continue;
    if (
      observed.kind === "file" &&
      observed.sha256 === sha256(operation.contents) &&
      observed.size === Buffer.byteLength(operation.contents, "utf8")
    ) {
      await unlink(targetPath);
      removed.push(operation.path);
    } else {
      preserved.push(operation.path);
    }
  }
  await removeEmptyCreatedParents(root, createOperations.map((operation) => operation.path));
  if (preserved.length > 0) {
    return { complete: false, removed, preserved };
  }
  await unlink(transactionPath);
  try {
    await rmdir(path.join(root, PAPILAB_METADATA_DIRECTORY));
  } catch (error) {
    if (!isNodeError(error, "ENOTEMPTY") && !isNodeError(error, "ENOENT")) throw error;
  }
  return { complete: true, removed, preserved };
}
