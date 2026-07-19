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
  SCIENT_AGENTS_FILE,
  SCIENT_FORMAT_VERSION,
  SCIENT_IDENTITY_FILE,
  SCIENT_PROJECT_FILE,
  SCIENT_BUILT_IN_ORIGIN,
  SCIENT_SKILLS_LOCK_FILE,
  SCIENT_SKILLS_LOCK_FORMAT_VERSION,
  ProjectInitializationError,
  type ConflictOperation,
  type CreateOperation,
  type InitializationPlan,
  type InitializationPlanInput,
  type InitializationPlanOperation,
  type PathSnapshot,
  type PreserveOperation,
  type ProjectProfileDescriptor,
  type BuiltInSkillDescriptor,
  type ProposeOperation,
} from "./types.ts";
import {
  assertIsoTimestamp,
  assertProjectId,
  normalizeInitializationRequest,
  resolveSelectedBuiltInSkills,
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

function skillActivationRecords(
  skills: readonly BuiltInSkillDescriptor[],
): InitializationPlan["skillActivations"] {
  return skills.map((skill) => ({
    id: skill.id,
    version: skill.version,
    digest: skill.digest,
    origin: SCIENT_BUILT_IN_ORIGIN,
  }));
}

function renderSkillsLock(skills: readonly BuiltInSkillDescriptor[]): string {
  return `${JSON.stringify(
    {
      formatVersion: SCIENT_SKILLS_LOCK_FORMAT_VERSION,
      skills: skillActivationRecords(skills),
    },
    null,
    2,
  )}\n`;
}

function portablePathKey(value: string): string {
  return value.normalize("NFC").toLowerCase();
}

function pathsOverlap(left: string, right: string): boolean {
  const leftKey = portablePathKey(left);
  const rightKey = portablePathKey(right);
  return (
    leftKey === rightKey || leftKey.startsWith(`${rightKey}/`) || rightKey.startsWith(`${leftKey}/`)
  );
}

async function planProjectFile(
  snapshot: PathSnapshot,
  contents: string,
): Promise<InitializationPlanOperation> {
  if (snapshot.kind === "missing") {
    return createOperation(
      SCIENT_PROJECT_FILE,
      contents,
      "Create the human-readable project orientation.",
    );
  }
  if (snapshot.kind === "file") {
    return preserveOperation(
      SCIENT_PROJECT_FILE,
      snapshot,
      "Preserve the existing PROJECT.md without modification.",
    );
  }
  return conflictOperation(
    SCIENT_PROJECT_FILE,
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
      SCIENT_AGENTS_FILE,
      contents,
      "Create the portable root agent guidance.",
    );
  }
  if (snapshot.kind !== "file") {
    return conflictOperation(
      SCIENT_AGENTS_FILE,
      snapshot,
      "AGENTS.md exists but is not a regular file and cannot be initialized safely.",
    );
  }
  try {
    const existing = await readUtf8FileBounded(
      path.join(root, SCIENT_AGENTS_FILE),
      MAX_MANAGED_TEXT_BYTES,
    );
    const proposedContents = proposeManagedAgentsContents(existing, profiles);
    if (proposedContents === existing) {
      return preserveOperation(
        SCIENT_AGENTS_FILE,
        snapshot,
        "Keep the existing compatible AGENTS.md unchanged.",
      );
    }
    const proposal: ProposeOperation = {
      kind: "propose",
      path: SCIENT_AGENTS_FILE,
      expected: snapshot,
      contents: proposedContents,
      reason: "Propose the Scient-managed baseline without modifying the existing file.",
    };
    return proposal;
  } catch (error) {
    return conflictOperation(
      SCIENT_AGENTS_FILE,
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
        path: validatePortableRelativePath(file.path),
        contents: file.contents,
        profileId: profile.id,
      })),
    )
    .toSorted((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
  for (const file of files) {
    const conflictingPath = [...owners.keys()].find((ownedPath) =>
      pathsOverlap(ownedPath, file.path),
    );
    if (conflictingPath) {
      const existingOwner = owners.get(conflictingPath);
      throw new ProjectInitializationError(
        "INVALID_PROFILE",
        `Profiles ${existingOwner} and ${file.profileId} define overlapping paths ${conflictingPath} and ${file.path}.`,
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
  const availableSkills = input.builtInSkills ?? [];
  const request = normalizeInitializationRequest({
    ...input.request,
    skillIds:
      input.request.skillIds ??
      availableSkills.filter((skill) => skill.defaultSelected).map((skill) => skill.id),
  });
  const profiles = resolveSelectedProfiles({
    profileIds: request.profileIds,
    profiles: input.profiles ?? [],
  });
  const skills = resolveSelectedBuiltInSkills({
    skillIds: request.skillIds,
    skills: availableSkills,
  });

  if (input.inspection.state === "initialized-compatible" && input.inspection.identity) {
    const operations: InitializationPlanOperation[] = [];
    if (input.inspection.projectFile.kind === "file") {
      operations.push(
        preserveOperation(
          SCIENT_PROJECT_FILE,
          input.inspection.projectFile,
          "Preserve the existing PROJECT.md.",
        ),
      );
    } else {
      operations.push(
        conflictOperation(
          SCIENT_PROJECT_FILE,
          input.inspection.projectFile,
          "The initialized project requires a regular PROJECT.md before it can be considered complete.",
        ),
      );
    }
    if (input.inspection.agentsFile.kind === "file") {
      operations.push(
        await planAgentsFile(
          input.inspection.root,
          input.inspection.agentsFile,
          renderAgentsMarkdown(profiles),
          profiles,
        ),
      );
    } else {
      operations.push(
        conflictOperation(
          SCIENT_AGENTS_FILE,
          input.inspection.agentsFile,
          "The initialized project requires a regular AGENTS.md before it can be considered complete.",
        ),
      );
    }
    if (input.inspection.skillsLockFile.kind === "file") {
      operations.push(
        preserveOperation(
          SCIENT_SKILLS_LOCK_FILE,
          input.inspection.skillsLockFile,
          "Preserve the existing built-in skill activation record.",
        ),
      );
    } else if (input.inspection.skillsLockFile.kind !== "missing") {
      operations.push(
        conflictOperation(
          SCIENT_SKILLS_LOCK_FILE,
          input.inspection.skillsLockFile,
          "The built-in skill activation path is not a regular file.",
        ),
      );
    }
    return {
      planVersion: 1,
      transactionId: assertProjectId(input.transactionId ?? randomUUID()),
      root: input.inspection.root,
      projectId: input.inspection.identity.projectId,
      createdAt: input.inspection.identity.createdAt,
      status: operations.some((operation) => operation.kind === "conflict")
        ? "blocked"
        : "already-initialized",
      request,
      profileVersions: profileVersionRecord(profiles),
      skillActivations: input.inspection.skillsLock?.skills ?? [],
      operations,
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
      skillActivations: skillActivationRecords(skills),
      operations: [
        conflictOperation(
          issue?.path ?? ".scient",
          input.inspection.metadataDirectory,
          issue?.message ?? "Existing Scient metadata must be repaired before initialization.",
        ),
      ],
    };
  }

  const legacyPapiLabIdentity =
    input.inspection.state === "legacy-papilab-compatible" ? input.inspection.identity : null;
  const projectId = legacyPapiLabIdentity
    ? legacyPapiLabIdentity.projectId
    : assertProjectId(input.projectId ?? randomUUID());
  const transactionId = assertProjectId(input.transactionId ?? randomUUID());
  const createdAt = legacyPapiLabIdentity
    ? legacyPapiLabIdentity.createdAt
    : assertIsoTimestamp(input.createdAt ?? new Date().toISOString());
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
      SCIENT_SKILLS_LOCK_FILE,
      renderSkillsLock(skills),
      "Record exact built-in skill activation identities without copying skill bodies.",
    ),
  );
  operations.push(
    createOperation(
      SCIENT_IDENTITY_FILE,
      `${JSON.stringify({ projectId, formatVersion: SCIENT_FORMAT_VERSION, createdAt }, null, 2)}\n`,
      legacyPapiLabIdentity
        ? "Migrate the verified PapiLab project identity into .scient without deleting rollback metadata."
        : "Create the portable Scient project identity after all other planned files.",
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
    skillActivations: skillActivationRecords(skills),
    operations,
  };
}
