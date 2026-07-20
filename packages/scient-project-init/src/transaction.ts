import { readUtf8FileBounded, MAX_TRANSACTION_BYTES } from "./filesystem.ts";
import {
  SCIENT_AGENTS_FILE,
  SCIENT_IDENTITY_FILE,
  SCIENT_PROJECT_FILE,
  SCIENT_SKILLS_LOCK_FILE,
  SCIENT_SKILLS_LOCK_FORMAT_VERSION,
  ProjectInitializationError,
  type BuiltInSkillActivation,
  type CreateOperation,
  type InitializationTransaction,
  type PathSnapshot,
  type PreserveOperation,
  type ProposeOperation,
} from "./types.ts";
import {
  assertIsoTimestamp,
  assertProjectId,
  validatePortableRelativePath,
  validateProjectIdentity,
  validateSkillsLock,
} from "./validation.ts";

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const MAX_OPERATIONS = 256;
const MAX_OPERATION_CONTENT_BYTES = 1_048_576;
const PROFILE_ID_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;

function validateOperationPath(value: unknown): string {
  if (typeof value !== "string") {
    throw new ProjectInitializationError("INVALID_TRANSACTION", "Transaction path must be text.");
  }
  if (
    value === SCIENT_PROJECT_FILE ||
    value === SCIENT_AGENTS_FILE ||
    value === SCIENT_IDENTITY_FILE ||
    value === SCIENT_SKILLS_LOCK_FILE
  ) {
    return value;
  }
  try {
    return validatePortableRelativePath(value);
  } catch (error) {
    throw new ProjectInitializationError(
      "INVALID_TRANSACTION",
      `Unsafe transaction path: ${value}`,
      { cause: error },
    );
  }
}

function validateSnapshot(value: unknown, allowMissing: boolean): PathSnapshot {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ProjectInitializationError("INVALID_TRANSACTION", "Invalid transaction snapshot.");
  }
  const candidate = value as Record<string, unknown>;
  switch (candidate.kind) {
    case "missing":
      if (!allowMissing) break;
      return { kind: "missing" };
    case "directory":
      return { kind: "directory" };
    case "other":
      return { kind: "other" };
    case "file":
      if (
        typeof candidate.sha256 === "string" &&
        SHA256_PATTERN.test(candidate.sha256) &&
        typeof candidate.size === "number" &&
        Number.isSafeInteger(candidate.size) &&
        candidate.size >= 0
      ) {
        return { kind: "file", sha256: candidate.sha256, size: candidate.size };
      }
      break;
    case "symlink":
      if (typeof candidate.target === "string") {
        return { kind: "symlink", target: candidate.target };
      }
      break;
  }
  throw new ProjectInitializationError("INVALID_TRANSACTION", "Invalid transaction snapshot.");
}

function validateContents(value: unknown, operationPath: string): string {
  if (typeof value !== "string") {
    throw new ProjectInitializationError(
      "INVALID_TRANSACTION",
      `Transaction contents for ${operationPath} must be text.`,
    );
  }
  if (Buffer.byteLength(value, "utf8") > MAX_OPERATION_CONTENT_BYTES) {
    throw new ProjectInitializationError(
      "INVALID_TRANSACTION",
      `Transaction contents for ${operationPath} exceed the safety limit.`,
    );
  }
  return value;
}

function validateOperation(value: unknown): CreateOperation | PreserveOperation | ProposeOperation {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ProjectInitializationError("INVALID_TRANSACTION", "Invalid transaction operation.");
  }
  const candidate = value as Record<string, unknown>;
  const operationPath = validateOperationPath(candidate.path);
  const reason =
    typeof candidate.reason === "string" ? candidate.reason : "Recorded initialization operation.";
  if (candidate.kind === "create") {
    const expected = validateSnapshot(candidate.expected, true);
    if (expected.kind !== "missing") {
      throw new ProjectInitializationError(
        "INVALID_TRANSACTION",
        `Create operation for ${operationPath} must expect a missing path.`,
      );
    }
    return {
      kind: "create",
      path: operationPath,
      reason,
      contents: validateContents(candidate.contents, operationPath),
      expected,
    };
  }
  if (candidate.kind === "preserve") {
    const expected = validateSnapshot(candidate.expected, false);
    if (expected.kind === "missing") {
      throw new ProjectInitializationError(
        "INVALID_TRANSACTION",
        `Preserve operation for ${operationPath} cannot expect a missing path.`,
      );
    }
    return { kind: "preserve", path: operationPath, reason, expected };
  }
  if (candidate.kind === "propose") {
    const expected = validateSnapshot(candidate.expected, false);
    if (expected.kind !== "file") {
      throw new ProjectInitializationError(
        "INVALID_TRANSACTION",
        `Proposal operation for ${operationPath} must expect a file.`,
      );
    }
    return {
      kind: "propose",
      path: operationPath,
      reason,
      contents: validateContents(candidate.contents, operationPath),
      expected,
    };
  }
  throw new ProjectInitializationError("INVALID_TRANSACTION", "Unknown transaction operation.");
}

export function validateInitializationTransaction(value: unknown): InitializationTransaction {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ProjectInitializationError("INVALID_TRANSACTION", "Transaction must be an object.");
  }
  const candidate = value as Record<string, unknown>;
  if (candidate.transactionVersion !== 1 || typeof candidate.transactionId !== "string") {
    throw new ProjectInitializationError("INVALID_TRANSACTION", "Unsupported transaction format.");
  }
  if (!Array.isArray(candidate.operations) || candidate.operations.length > MAX_OPERATIONS) {
    throw new ProjectInitializationError("INVALID_TRANSACTION", "Invalid transaction operations.");
  }
  if (
    typeof candidate.profileVersions !== "object" ||
    candidate.profileVersions === null ||
    Array.isArray(candidate.profileVersions)
  ) {
    throw new ProjectInitializationError("INVALID_TRANSACTION", "Invalid profile version record.");
  }
  const profileVersions: Record<string, number> = {};
  for (const [profileId, version] of Object.entries(candidate.profileVersions)) {
    if (!PROFILE_ID_PATTERN.test(profileId)) {
      throw new ProjectInitializationError("INVALID_TRANSACTION", "Invalid profile ID.");
    }
    if (!Number.isSafeInteger(version) || (version as number) < 1) {
      throw new ProjectInitializationError("INVALID_TRANSACTION", "Invalid profile version.");
    }
    profileVersions[profileId] = version as number;
  }
  const operations = candidate.operations.map(validateOperation);
  const hasSkillActivationRecord = candidate.skillActivations !== undefined;
  let skillActivations: BuiltInSkillActivation[] = [];
  if (hasSkillActivationRecord) {
    try {
      skillActivations = [
        ...validateSkillsLock({
          formatVersion: SCIENT_SKILLS_LOCK_FORMAT_VERSION,
          skills: candidate.skillActivations,
        }).skills,
      ];
    } catch (error) {
      throw new ProjectInitializationError(
        "INVALID_TRANSACTION",
        "Transaction contains an invalid built-in skill activation record.",
        { cause: error },
      );
    }
  }
  const paths = new Set<string>();
  for (const operation of operations) {
    if (paths.has(operation.path)) {
      throw new ProjectInitializationError(
        "INVALID_TRANSACTION",
        `Transaction repeats path ${operation.path}.`,
      );
    }
    paths.add(operation.path);
  }
  if (typeof candidate.projectId !== "string" || typeof candidate.createdAt !== "string") {
    throw new ProjectInitializationError(
      "INVALID_TRANSACTION",
      "Transaction identity fields are invalid.",
    );
  }
  const transactionId = assertProjectId(candidate.transactionId);
  const projectId = assertProjectId(candidate.projectId);
  const createdAt = assertIsoTimestamp(candidate.createdAt);
  const identityOperations = operations.filter(
    (operation): operation is CreateOperation =>
      operation.kind === "create" && operation.path === SCIENT_IDENTITY_FILE,
  );
  if (identityOperations.length !== 1) {
    throw new ProjectInitializationError(
      "INVALID_TRANSACTION",
      "Transaction must contain exactly one Scient identity creation.",
    );
  }
  const identityOperation = identityOperations[0];
  if (!identityOperation) {
    throw new ProjectInitializationError(
      "INVALID_TRANSACTION",
      "Transaction identity creation is missing.",
    );
  }
  let identity;
  try {
    identity = validateProjectIdentity(JSON.parse(identityOperation.contents));
  } catch (error) {
    throw new ProjectInitializationError(
      "INVALID_TRANSACTION",
      "Transaction contains an invalid Scient project identity.",
      { cause: error },
    );
  }
  if (identity.projectId !== projectId || identity.createdAt !== createdAt) {
    throw new ProjectInitializationError(
      "INVALID_TRANSACTION",
      "Transaction identity does not match its project metadata.",
    );
  }
  const skillsLockOperations = operations.filter(
    (operation): operation is CreateOperation =>
      operation.kind === "create" && operation.path === SCIENT_SKILLS_LOCK_FILE,
  );
  if (skillsLockOperations.length !== (hasSkillActivationRecord ? 1 : 0)) {
    throw new ProjectInitializationError(
      "INVALID_TRANSACTION",
      hasSkillActivationRecord
        ? "Transaction must contain exactly one built-in skills lock creation."
        : "Legacy transaction cannot contain a built-in skills lock creation.",
    );
  }
  if (hasSkillActivationRecord) {
    let skillsLock;
    try {
      skillsLock = validateSkillsLock(JSON.parse(skillsLockOperations[0]!.contents));
    } catch (error) {
      throw new ProjectInitializationError(
        "INVALID_TRANSACTION",
        "Transaction contains an invalid built-in skills lock.",
        { cause: error },
      );
    }
    if (JSON.stringify(skillsLock.skills) !== JSON.stringify(skillActivations)) {
      throw new ProjectInitializationError(
        "INVALID_TRANSACTION",
        "Transaction skill activations do not match its built-in skills lock.",
      );
    }
  }
  return {
    transactionVersion: 1,
    transactionId,
    projectId,
    createdAt,
    profileVersions,
    skillActivations,
    operations,
  };
}

export async function readInitializationTransaction(
  transactionPath: string,
): Promise<InitializationTransaction> {
  const contents = await readUtf8FileBounded(transactionPath, MAX_TRANSACTION_BYTES);
  try {
    return validateInitializationTransaction(JSON.parse(contents));
  } catch (error) {
    if (error instanceof ProjectInitializationError) throw error;
    throw new ProjectInitializationError(
      "INVALID_TRANSACTION",
      `Could not parse initialization transaction at ${transactionPath}.`,
      { cause: error },
    );
  }
}

export function serializeInitializationTransaction(transaction: InitializationTransaction): string {
  const serialized = `${JSON.stringify(transaction, null, 2)}\n`;
  if (Buffer.byteLength(serialized, "utf8") > MAX_TRANSACTION_BYTES) {
    throw new ProjectInitializationError(
      "INVALID_TRANSACTION",
      `Initialization transaction exceeds the ${MAX_TRANSACTION_BYTES}-byte recovery limit.`,
    );
  }
  return serialized;
}
