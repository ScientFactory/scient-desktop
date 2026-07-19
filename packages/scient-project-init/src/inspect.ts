import { readdir } from "node:fs/promises";
import path from "node:path";

import {
  MAX_IDENTITY_BYTES,
  MAX_SKILLS_LOCK_BYTES,
  readUtf8FileBounded,
  resolveProjectRoot,
  snapshotRelativePathSafely,
} from "./filesystem.ts";
import { readInitializationTransaction } from "./transaction.ts";
import {
  LEGACY_PAPILAB_IDENTITY_FILE,
  LEGACY_PAPILAB_METADATA_DIRECTORY,
  SCIENT_AGENTS_FILE,
  SCIENT_IDENTITY_FILE,
  SCIENT_METADATA_DIRECTORY,
  SCIENT_PROJECT_FILE,
  SCIENT_SKILLS_LOCK_FILE,
  SCIENT_TRANSACTION_FILE,
  type InspectionIssue,
  type ScientProjectIdentity,
  type ScientSkillsLock,
  type ProjectFolderInspection,
  type ProjectFolderState,
} from "./types.ts";
import { validateProjectIdentity, validateSkillsLock } from "./validation.ts";

export async function inspectProjectFolder(
  requestedRoot: string,
): Promise<ProjectFolderInspection> {
  const root = await resolveProjectRoot(requestedRoot);
  const entries = (await readdir(root)).toSorted();
  const projectFile = await snapshotRelativePathSafely(root, SCIENT_PROJECT_FILE);
  const agentsFile = await snapshotRelativePathSafely(root, SCIENT_AGENTS_FILE);
  const metadataDirectory = await snapshotRelativePathSafely(root, SCIENT_METADATA_DIRECTORY);
  const identityFile =
    metadataDirectory.kind === "directory"
      ? await snapshotRelativePathSafely(root, SCIENT_IDENTITY_FILE)
      : ({ kind: "missing" } as const);
  const transactionFile =
    metadataDirectory.kind === "directory"
      ? await snapshotRelativePathSafely(root, SCIENT_TRANSACTION_FILE)
      : ({ kind: "missing" } as const);
  const skillsLockFile =
    metadataDirectory.kind === "directory"
      ? await snapshotRelativePathSafely(root, SCIENT_SKILLS_LOCK_FILE)
      : ({ kind: "missing" } as const);
  const legacyPapiLabMetadataDirectory = await snapshotRelativePathSafely(
    root,
    LEGACY_PAPILAB_METADATA_DIRECTORY,
  );
  const legacyPapiLabIdentityFile =
    legacyPapiLabMetadataDirectory.kind === "directory"
      ? await snapshotRelativePathSafely(root, LEGACY_PAPILAB_IDENTITY_FILE)
      : ({ kind: "missing" } as const);
  const issues: InspectionIssue[] = [];
  let identity: ScientProjectIdentity | null = null;
  let skillsLock: ScientSkillsLock | null = null;
  let legacyPapiLabIdentity: ScientProjectIdentity | null = null;
  let transactionValid = false;

  if (identityFile.kind === "file") {
    try {
      identity = validateProjectIdentity(
        JSON.parse(
          await readUtf8FileBounded(path.join(root, SCIENT_IDENTITY_FILE), MAX_IDENTITY_BYTES),
        ),
      );
    } catch (error) {
      issues.push({
        code: "invalid-identity",
        path: SCIENT_IDENTITY_FILE,
        message: error instanceof Error ? error.message : "Invalid Scient project identity.",
      });
    }
  } else if (identityFile.kind !== "missing") {
    issues.push({
      code: "metadata-path-conflict",
      path: SCIENT_IDENTITY_FILE,
      message: "The Scient project identity path is not a regular file.",
    });
  }

  if (skillsLockFile.kind === "file") {
    try {
      skillsLock = validateSkillsLock(
        JSON.parse(
          await readUtf8FileBounded(
            path.join(root, SCIENT_SKILLS_LOCK_FILE),
            MAX_SKILLS_LOCK_BYTES,
          ),
        ),
      );
    } catch (error) {
      issues.push({
        code: "invalid-skills-lock",
        path: SCIENT_SKILLS_LOCK_FILE,
        message:
          error instanceof Error ? error.message : "Invalid built-in skill activation record.",
      });
    }
  } else if (skillsLockFile.kind !== "missing") {
    issues.push({
      code: "metadata-path-conflict",
      path: SCIENT_SKILLS_LOCK_FILE,
      message: "The built-in skill activation path is not a regular file.",
    });
  }

  if (
    legacyPapiLabMetadataDirectory.kind !== "missing" &&
    legacyPapiLabMetadataDirectory.kind !== "directory"
  ) {
    issues.push({
      code: "metadata-path-conflict",
      path: LEGACY_PAPILAB_METADATA_DIRECTORY,
      message: "The legacy .papilab path is not a real directory.",
    });
  } else if (legacyPapiLabIdentityFile.kind === "file") {
    try {
      legacyPapiLabIdentity = validateProjectIdentity(
        JSON.parse(
          await readUtf8FileBounded(
            path.join(root, LEGACY_PAPILAB_IDENTITY_FILE),
            MAX_IDENTITY_BYTES,
          ),
        ),
      );
    } catch (error) {
      issues.push({
        code: "invalid-identity",
        path: LEGACY_PAPILAB_IDENTITY_FILE,
        message:
          error instanceof Error ? error.message : "Invalid legacy PapiLab project identity.",
      });
    }
  } else if (
    legacyPapiLabMetadataDirectory.kind === "directory" &&
    legacyPapiLabIdentityFile.kind !== "missing"
  ) {
    issues.push({
      code: "metadata-path-conflict",
      path: LEGACY_PAPILAB_IDENTITY_FILE,
      message: "The legacy PapiLab project identity path is not a regular file.",
    });
  } else if (
    legacyPapiLabMetadataDirectory.kind === "directory" &&
    legacyPapiLabIdentityFile.kind === "missing"
  ) {
    issues.push({
      code: "invalid-identity",
      path: LEGACY_PAPILAB_IDENTITY_FILE,
      message: "The legacy .papilab directory has no valid project identity.",
    });
  }

  if (identity && legacyPapiLabIdentity && identity.projectId !== legacyPapiLabIdentity.projectId) {
    issues.push({
      code: "metadata-path-conflict",
      path: LEGACY_PAPILAB_IDENTITY_FILE,
      message: "The .scient and .papilab project identities disagree; migration requires review.",
    });
  }

  if (transactionFile.kind === "file") {
    try {
      await readInitializationTransaction(path.join(root, SCIENT_TRANSACTION_FILE));
      transactionValid = true;
      issues.push({
        code: "incomplete-transaction",
        path: SCIENT_TRANSACTION_FILE,
        message: "A recoverable project initialization is incomplete.",
      });
    } catch (error) {
      issues.push({
        code: "invalid-transaction",
        path: SCIENT_TRANSACTION_FILE,
        message: error instanceof Error ? error.message : "Invalid initialization transaction.",
      });
    }
  } else if (transactionFile.kind !== "missing") {
    issues.push({
      code: "metadata-path-conflict",
      path: SCIENT_TRANSACTION_FILE,
      message: "The initialization transaction path is not a regular file.",
    });
  }

  let state: ProjectFolderState;
  if (
    issues.some(
      (issue) =>
        issue.path.startsWith(LEGACY_PAPILAB_METADATA_DIRECTORY) ||
        issue.path === LEGACY_PAPILAB_IDENTITY_FILE,
    )
  ) {
    state = "invalid-or-conflicting";
  } else if (metadataDirectory.kind === "missing" && legacyPapiLabIdentity) {
    state = "legacy-papilab-compatible";
    identity = legacyPapiLabIdentity;
  } else if (metadataDirectory.kind === "missing") {
    state = entries.length === 0 ? "empty-uninitialized" : "existing-uninitialized";
  } else if (metadataDirectory.kind !== "directory") {
    state = "invalid-or-conflicting";
    issues.push({
      code: "metadata-path-conflict",
      path: SCIENT_METADATA_DIRECTORY,
      message: "The .scient path is not a real directory.",
    });
  } else if (transactionValid) {
    state = "partially-initialized";
  } else if (
    transactionFile.kind !== "missing" ||
    issues.some(
      (issue) =>
        issue.code === "invalid-identity" ||
        issue.code === "invalid-skills-lock" ||
        issue.code === "metadata-path-conflict",
    )
  ) {
    state = "invalid-or-conflicting";
  } else if (identity) {
    state = "initialized-compatible";
  } else {
    const metadataEntries = await readdir(path.join(root, SCIENT_METADATA_DIRECTORY));
    if (metadataEntries.length === 0) {
      state = "partially-initialized";
      issues.push({
        code: "empty-metadata-directory",
        path: SCIENT_METADATA_DIRECTORY,
        message: "The empty .scient directory may be repaired by retrying initialization.",
      });
    } else {
      state = "invalid-or-conflicting";
      issues.push({
        code: "metadata-path-conflict",
        path: SCIENT_METADATA_DIRECTORY,
        message: "The .scient directory contains unrecognized state.",
      });
    }
  }

  if (identity && projectFile.kind === "missing") {
    issues.push({
      code: "missing-project-file",
      path: SCIENT_PROJECT_FILE,
      message: "PROJECT.md is missing from this initialized project.",
    });
  }
  if (identity && agentsFile.kind === "missing") {
    issues.push({
      code: "missing-agents-file",
      path: SCIENT_AGENTS_FILE,
      message: "AGENTS.md is missing from this initialized project.",
    });
  }

  return {
    requestedRoot,
    root,
    state,
    entries,
    projectFile,
    agentsFile,
    metadataDirectory,
    identityFile,
    skillsLockFile,
    transactionFile,
    legacyPapiLabMetadataDirectory,
    legacyPapiLabIdentityFile,
    legacyPapiLabIdentity,
    identity,
    skillsLock,
    issues,
  };
}
