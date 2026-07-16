import { randomUUID } from "node:crypto";
import path from "node:path";

import {
  MAX_MANAGED_TEXT_BYTES,
  readUtf8FileBounded,
  snapshotRelativePathSafely,
} from "./filesystem.ts";
import {
  renderAgentsMarkdown,
  renderProjectMarkdown,
  proposeManagedAgentsContents,
} from "./templates.ts";
import {
  PAPILAB_AGENTS_FILE,
  PAPILAB_FORMAT_VERSION,
  PAPILAB_IDENTITY_FILE,
  PAPILAB_PROJECT_FILE,
  ProjectInitializationError,
  type ConflictOperation,
  type CreateOperation,
  type InitializationPlan,
  type InitializationPlanInput,
  type InitializationPlanOperation,
  type PathSnapshot,
  type PreserveOperation,
  type ProjectProfileDescriptor,
  type ProposeOperation,
} from "./types.ts";
import {
  assertIsoTimestamp,
  assertProjectId,
  normalizeInitializationRequest,
  resolveSelectedProfiles,
  validatePortableRelativePath,
} from "./validation.ts";

function createOperation(relativePath: string, contents: string, reason: string): CreateOperation {
  return { kind: "create", path: relativePath, contents, reason, expected: { kind: "missing" } };
}

function preserveOperation(
  relativePath: string,
  expected: Exclude<PathSnapshot, { readonly kind: "missing" }>,
  reason: string,
): PreserveOperation {
  return { kind: "preserve", path: relativePath, expected, reason };
}

function conflictOperation(
  relativePath: string,
  observed: PathSnapshot,
  reason: string,
): ConflictOperation {
  return { kind: "conflict", path: relativePath, observed, reason };
}

function profileVersionRecord(
  profiles: readonly ProjectProfileDescriptor[],
): Readonly<Record<string, number>> {
  return Object.fromEntries(profiles.map((profile) => [profile.id, profile.version]));
}

async function planProjectFile(
  snapshot: PathSnapshot,
  contents: string,
): Promise<InitializationPlanOperation> {
  if (snapshot.kind === "missing") {
    return createOperation(
      PAPILAB_PROJECT_FILE,
      contents,
      "Create the human-readable project orientation.",
    );
  }
  if (snapshot.kind === "file") {
    return preserveOperation(
      PAPILAB_PROJECT_FILE,
      snapshot,
      "Preserve the existing PROJECT.md without modification.",
    );
  }
  return conflictOperation(
    PAPILAB_PROJECT_FILE,
    snapshot,
    "PROJECT.md exists but is not a regular file and cannot be initialized safely.",
  );
}

async function planAgentsFile(
  root: string,
  snapshot: PathSnapshot,
  contents: string,
  profiles: readonly ProjectProfileDescriptor[],
): Promise<InitializationPlanOperation> {
  if (snapshot.kind === "missing") {
    return createOperation(
      PAPILAB_AGENTS_FILE,
      contents,
      "Create the portable root agent guidance.",
    );
  }
  if (snapshot.kind !== "file") {
    return conflictOperation(
      PAPILAB_AGENTS_FILE,
      snapshot,
      "AGENTS.md exists but is not a regular file and cannot be initialized safely.",
    );
  }
  try {
    const existing = await readUtf8FileBounded(
      path.join(root, PAPILAB_AGENTS_FILE),
      MAX_MANAGED_TEXT_BYTES,
    );
    const proposedContents = proposeManagedAgentsContents(existing, profiles);
    if (proposedContents === existing.replace(/\r\n?/g, "\n")) {
      return preserveOperation(
        PAPILAB_AGENTS_FILE,
        snapshot,
        "Preserve the existing compatible PapiLab agent guidance.",
      );
    }
    const proposal: ProposeOperation = {
      kind: "propose",
      path: PAPILAB_AGENTS_FILE,
      expected: snapshot,
      contents: proposedContents,
      reason: "Propose the PapiLab-managed baseline without modifying the existing file.",
    };
    return proposal;
  } catch (error) {
    return conflictOperation(
      PAPILAB_AGENTS_FILE,
      snapshot,
      error instanceof Error ? error.message : "AGENTS.md cannot be reconciled safely.",
    );
  }
}

async function planProfileFiles(
  root: string,
  profiles: readonly ProjectProfileDescriptor[],
): Promise<readonly InitializationPlanOperation[]> {
  const operations: InitializationPlanOperation[] = [];
  const owners = new Map<string, string>();
  const files = profiles
    .flatMap((profile) =>
      (profile.files ?? []).map((file) => ({
        ...file,
        path: validatePortableRelativePath(file.path),
        profileId: profile.id,
      })),
    )
    .toSorted((left, right) => left.path.localeCompare(right.path));
  for (const file of files) {
    const existingOwner = owners.get(file.path);
    if (existingOwner) {
      throw new ProjectInitializationError(
        "INVALID_PROFILE",
        `Profiles ${existingOwner} and ${file.profileId} both define ${file.path}.`,
      );
    }
    owners.set(file.path, file.profileId);
    const observed = await snapshotRelativePathSafely(root, file.path);
    if (observed.kind === "missing") {
      operations.push(
        createOperation(file.path, file.contents, `Create file from profile ${file.profileId}.`),
      );
    } else {
      operations.push(
        conflictOperation(
          file.path,
          observed,
          `Profile ${file.profileId} will not overwrite an existing path.`,
        ),
      );
    }
  }
  return operations;
}

export async function planProjectInitialization(
  input: InitializationPlanInput,
): Promise<InitializationPlan> {
  const request = normalizeInitializationRequest(input.request);
  const profiles = resolveSelectedProfiles({
    profileIds: request.profileIds,
    profiles: input.profiles ?? [],
  });

  if (input.inspection.state === "initialized-compatible" && input.inspection.identity) {
    return {
      planVersion: 1,
      transactionId: assertProjectId(input.transactionId ?? randomUUID()),
      root: input.inspection.root,
      projectId: input.inspection.identity.projectId,
      createdAt: input.inspection.identity.createdAt,
      status: "already-initialized",
      request,
      profileVersions: profileVersionRecord(profiles),
      operations: [],
    };
  }

  const repairableEmptyMetadataDirectory =
    input.inspection.state === "partially-initialized" &&
    input.inspection.metadataDirectory.kind === "directory" &&
    input.inspection.identityFile.kind === "missing" &&
    input.inspection.transactionFile.kind === "missing";
  if (
    input.inspection.state === "invalid-or-conflicting" ||
    (input.inspection.state === "partially-initialized" && !repairableEmptyMetadataDirectory)
  ) {
    const issue = input.inspection.issues[0];
    return {
      planVersion: 1,
      transactionId: assertProjectId(input.transactionId ?? randomUUID()),
      root: input.inspection.root,
      projectId: assertProjectId(input.projectId ?? randomUUID()),
      createdAt: assertIsoTimestamp(input.createdAt ?? new Date().toISOString()),
      status: "blocked",
      request,
      profileVersions: profileVersionRecord(profiles),
      operations: [
        conflictOperation(
          issue?.path ?? ".papilab",
          input.inspection.metadataDirectory,
          issue?.message ?? "Existing PapiLab metadata must be repaired before initialization.",
        ),
      ],
    };
  }

  const projectId = assertProjectId(input.projectId ?? randomUUID());
  const transactionId = assertProjectId(input.transactionId ?? randomUUID());
  const createdAt = assertIsoTimestamp(input.createdAt ?? new Date().toISOString());
  const operations: InitializationPlanOperation[] = [];
  operations.push(
    await planProjectFile(input.inspection.projectFile, renderProjectMarkdown(request, profiles)),
  );
  operations.push(
    await planAgentsFile(
      input.inspection.root,
      input.inspection.agentsFile,
      renderAgentsMarkdown(profiles),
      profiles,
    ),
  );
  operations.push(...(await planProfileFiles(input.inspection.root, profiles)));
  operations.push(
    createOperation(
      PAPILAB_IDENTITY_FILE,
      `${JSON.stringify({ projectId, formatVersion: PAPILAB_FORMAT_VERSION, createdAt }, null, 2)}\n`,
      "Create the portable PapiLab project identity after all other planned files.",
    ),
  );

  return {
    planVersion: 1,
    transactionId,
    root: input.inspection.root,
    projectId,
    createdAt,
    status: operations.some((operation) => operation.kind === "conflict") ? "blocked" : "ready",
    request,
    profileVersions: profileVersionRecord(profiles),
    operations,
  };
}
