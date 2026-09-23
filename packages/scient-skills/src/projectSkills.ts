// @effect-diagnostics nodeBuiltinImport:off -- Project skill discovery is a bounded filesystem boundary.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import {
  inspectScientProject,
  readScientProjectIdentity,
  SCIENT_IDENTITY_FILE,
  SCIENT_TRANSACTION_FILE,
} from "@scientfactory/project-init";

import type { SkillRelease } from "./model.ts";
import { loadProjectSkillRelease } from "./release.ts";

export const SCIENT_PROJECT_SKILLS_DIRECTORY = ".scient/skills";
export const MAX_PROJECT_SKILLS = 64;
export const MAX_PROJECT_SKILL_BYTES = 25 * 1024 * 1024;

export interface ProjectSkillDiagnostic {
  readonly code:
    | "invalid-project"
    | "not-initialized-project"
    | "invalid-skills-directory"
    | "invalid-skill"
    | "project-skill-limit";
  readonly path: string;
  readonly message: string;
}

export interface ProjectSkillCatalog {
  readonly rootPath: string;
  readonly projectId?: string;
  readonly releases: ReadonlyArray<SkillRelease>;
  readonly diagnostics: ReadonlyArray<ProjectSkillDiagnostic>;
}

const compareStrings = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}

function frozenCatalog(input: {
  readonly rootPath: string;
  readonly projectId?: string;
  readonly releases?: ReadonlyArray<SkillRelease>;
  readonly diagnostics?: ReadonlyArray<ProjectSkillDiagnostic>;
}): ProjectSkillCatalog {
  return Object.freeze({
    rootPath: input.rootPath,
    ...(input.projectId ? { projectId: input.projectId } : {}),
    releases: Object.freeze([...(input.releases ?? [])]),
    diagnostics: Object.freeze(
      (input.diagnostics ?? []).map((diagnostic) => Object.freeze({ ...diagnostic })),
    ),
  });
}

async function identityFailureCatalog(
  requestedRoot: string,
  error: unknown,
): Promise<ProjectSkillCatalog> {
  let inspection: Awaited<ReturnType<typeof inspectScientProject>> | undefined;
  try {
    inspection = await inspectScientProject(requestedRoot);
  } catch {
    // Preserve the original identity error when project inspection also fails.
  }
  const notInitialized = inspection?.state === "ordinary";
  const recoverable = inspection?.state === "recoverable";
  const issue = inspection?.issues[0];
  return frozenCatalog({
    rootPath: inspection?.root ?? requestedRoot,
    diagnostics: [
      {
        code: notInitialized ? "not-initialized-project" : "invalid-project",
        path: notInitialized
          ? SCIENT_IDENTITY_FILE
          : (issue?.path ?? (recoverable ? SCIENT_TRANSACTION_FILE : SCIENT_IDENTITY_FILE)),
        message:
          (notInitialized ? "This folder is not an initialized Scient project." : undefined) ??
          (recoverable
            ? "Scient project setup is incomplete and must be recovered before skills can be loaded."
            : undefined) ??
          issue?.message ??
          (error instanceof Error ? error.message : "Project identity could not be read."),
      },
    ],
  });
}

/**
 * Discover only skills in an initialized Scient project. Invalid entries are
 * quarantined independently; no filesystem content is executed or modified.
 */
export async function loadProjectSkillCatalog(root: string): Promise<ProjectSkillCatalog> {
  const requestedRoot = NodePath.resolve(root);
  // Skip readScientProjectIdentity's full inspection for the common missing-identity path.
  try {
    await NodeFSP.lstat(NodePath.join(requestedRoot, SCIENT_IDENTITY_FILE));
  } catch (error) {
    if (isNodeError(error, "ENOENT")) {
      return identityFailureCatalog(
        requestedRoot,
        new Error("This folder is not an initialized Scient project.", { cause: error }),
      );
    }
    return identityFailureCatalog(requestedRoot, error);
  }

  let rootPath: string;
  let projectId: string;
  try {
    rootPath = await NodeFSP.realpath(requestedRoot);
    projectId = (await readScientProjectIdentity(rootPath)).projectId;
  } catch (error) {
    return identityFailureCatalog(requestedRoot, error);
  }

  const skillsRoot = NodePath.join(rootPath, SCIENT_PROJECT_SKILLS_DIRECTORY);
  let skillsRootStat;
  try {
    skillsRootStat = await NodeFSP.lstat(skillsRoot);
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return frozenCatalog({ rootPath, projectId });
    return frozenCatalog({
      rootPath,
      projectId,
      diagnostics: [
        {
          code: "invalid-skills-directory",
          path: SCIENT_PROJECT_SKILLS_DIRECTORY,
          message: "The project skills directory could not be inspected.",
        },
      ],
    });
  }
  if (!skillsRootStat.isDirectory() || skillsRootStat.isSymbolicLink()) {
    return frozenCatalog({
      rootPath,
      projectId,
      diagnostics: [
        {
          code: "invalid-skills-directory",
          path: SCIENT_PROJECT_SKILLS_DIRECTORY,
          message: "The project skills path must be a real directory.",
        },
      ],
    });
  }

  const entries = (await NodeFSP.readdir(skillsRoot, { withFileTypes: true })).sort((left, right) =>
    compareStrings(left.name, right.name),
  );
  if (entries.length > MAX_PROJECT_SKILLS) {
    return frozenCatalog({
      rootPath,
      projectId,
      diagnostics: [
        {
          code: "project-skill-limit",
          path: SCIENT_PROJECT_SKILLS_DIRECTORY,
          message: `A project may contain at most ${MAX_PROJECT_SKILLS} skill directories.`,
        },
      ],
    });
  }

  const releases: SkillRelease[] = [];
  const diagnostics: ProjectSkillDiagnostic[] = [];
  let totalBytes = 0;
  for (const entry of entries) {
    const relativePath = `${SCIENT_PROJECT_SKILLS_DIRECTORY}/${entry.name}`;
    if (!entry.isDirectory() || entry.isSymbolicLink()) {
      diagnostics.push({
        code: "invalid-skill",
        path: relativePath,
        message: "Each project skill must be a real directory containing SKILL.md.",
      });
      continue;
    }
    try {
      const release = await loadProjectSkillRelease(
        NodePath.join(skillsRoot, entry.name),
        projectId,
      );
      if (totalBytes + release.snapshotBytes > MAX_PROJECT_SKILL_BYTES) {
        diagnostics.push({
          code: "project-skill-limit",
          path: relativePath,
          message: "Project skill snapshots exceed the 25 MiB aggregate limit.",
        });
        break;
      }
      totalBytes += release.snapshotBytes;
      releases.push(release);
    } catch (error) {
      diagnostics.push({
        code: "invalid-skill",
        path: relativePath,
        message: error instanceof Error ? error.message : "Project skill validation failed.",
      });
    }
  }

  return frozenCatalog({ rootPath, projectId, releases, diagnostics });
}
