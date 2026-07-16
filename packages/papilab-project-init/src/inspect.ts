import { readdir } from "node:fs/promises";
import path from "node:path";

import {
  MAX_IDENTITY_BYTES,
  readUtf8FileBounded,
  resolveProjectRoot,
  snapshotRelativePathSafely,
  snapshotPath,
} from "./filesystem.ts";
import { readInitializationTransaction } from "./transaction.ts";
import {
  PAPILAB_AGENTS_FILE,
  PAPILAB_IDENTITY_FILE,
  PAPILAB_METADATA_DIRECTORY,
  PAPILAB_PROJECT_FILE,
  PAPILAB_TRANSACTION_FILE,
  type InspectionIssue,
  type PapiLabProjectIdentity,
  type ProjectFolderInspection,
  type ProjectFolderState,
} from "./types.ts";
import { validateProjectIdentity } from "./validation.ts";

export async function inspectProjectFolder(requestedRoot: string): Promise<ProjectFolderInspection> {
  const root = await resolveProjectRoot(requestedRoot);
  const entries = (await readdir(root)).toSorted();
  const projectFile = await snapshotPath(path.join(root, PAPILAB_PROJECT_FILE));
  const agentsFile = await snapshotPath(path.join(root, PAPILAB_AGENTS_FILE));
  const metadataDirectory = await snapshotPath(path.join(root, PAPILAB_METADATA_DIRECTORY));
  const identityFile =
    metadataDirectory.kind === "directory"
      ? await snapshotRelativePathSafely(root, PAPILAB_IDENTITY_FILE)
      : ({ kind: "missing" } as const);
  const transactionFile =
    metadataDirectory.kind === "directory"
      ? await snapshotRelativePathSafely(root, PAPILAB_TRANSACTION_FILE)
      : ({ kind: "missing" } as const);
  const issues: InspectionIssue[] = [];
  let identity: PapiLabProjectIdentity | null = null;
  let transactionValid = false;

  if (identityFile.kind === "file") {
    try {
      identity = validateProjectIdentity(
        JSON.parse(await readUtf8FileBounded(path.join(root, PAPILAB_IDENTITY_FILE), MAX_IDENTITY_BYTES)),
      );
    } catch (error) {
      issues.push({
        code: "invalid-identity",
        path: PAPILAB_IDENTITY_FILE,
        message: error instanceof Error ? error.message : "Invalid PapiLab project identity.",
      });
    }
  } else if (identityFile.kind !== "missing") {
    issues.push({
      code: "metadata-path-conflict",
      path: PAPILAB_IDENTITY_FILE,
      message: "The PapiLab project identity path is not a regular file.",
    });
  }

  if (transactionFile.kind === "file") {
    try {
      await readInitializationTransaction(path.join(root, PAPILAB_TRANSACTION_FILE));
      transactionValid = true;
      issues.push({
        code: "incomplete-transaction",
        path: PAPILAB_TRANSACTION_FILE,
        message: "A recoverable project initialization is incomplete.",
      });
    } catch (error) {
      issues.push({
        code: "invalid-transaction",
        path: PAPILAB_TRANSACTION_FILE,
        message: error instanceof Error ? error.message : "Invalid initialization transaction.",
      });
    }
  } else if (transactionFile.kind !== "missing") {
    issues.push({
      code: "metadata-path-conflict",
      path: PAPILAB_TRANSACTION_FILE,
      message: "The initialization transaction path is not a regular file.",
    });
  }

  let state: ProjectFolderState;
  if (metadataDirectory.kind === "missing") {
    state = entries.length === 0 ? "empty-uninitialized" : "existing-uninitialized";
  } else if (metadataDirectory.kind !== "directory") {
    state = "invalid-or-conflicting";
    issues.push({
      code: "metadata-path-conflict",
      path: PAPILAB_METADATA_DIRECTORY,
      message: "The .papilab path is not a real directory.",
    });
  } else if (transactionValid) {
    state = "partially-initialized";
  } else if (
    transactionFile.kind !== "missing" ||
    issues.some(
      (issue) => issue.code === "invalid-identity" || issue.code === "metadata-path-conflict",
    )
  ) {
    state = "invalid-or-conflicting";
  } else if (identity) {
    state = "initialized-compatible";
  } else {
    const metadataEntries = await readdir(path.join(root, PAPILAB_METADATA_DIRECTORY));
    if (metadataEntries.length === 0) {
      state = "partially-initialized";
      issues.push({
        code: "empty-metadata-directory",
        path: PAPILAB_METADATA_DIRECTORY,
        message: "The empty .papilab directory may be repaired by retrying initialization.",
      });
    } else {
      state = "invalid-or-conflicting";
      issues.push({
        code: "metadata-path-conflict",
        path: PAPILAB_METADATA_DIRECTORY,
        message: "The .papilab directory contains unrecognized state.",
      });
    }
  }

  if (identity && projectFile.kind === "missing") {
    issues.push({
      code: "missing-project-file",
      path: PAPILAB_PROJECT_FILE,
      message: "PROJECT.md is missing from this initialized project.",
    });
  }
  if (identity && agentsFile.kind === "missing") {
    issues.push({
      code: "missing-agents-file",
      path: PAPILAB_AGENTS_FILE,
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
    transactionFile,
    identity,
    issues,
  };
}
