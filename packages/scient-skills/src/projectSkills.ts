// @effect-diagnostics nodeBuiltinImport:off -- Project skill discovery is a bounded filesystem boundary.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import { readScientProjectIdentity } from "@scientfactory/project-init";

import type { SkillRelease } from "./model.ts";
import { loadProjectSkillRelease } from "./release.ts";

export const SCIENT_PROJECT_SKILLS_DIRECTORY = ".scient/skills";
export const MAX_PROJECT_SKILLS = 64;
export const MAX_PROJECT_SKILL_BYTES = 25 * 1024 * 1024;

export interface ProjectSkillDiagnostic {
  readonly code:
    | "invalid-project"
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

/**
 * Discover only skills in an initialized Scient project. Invalid entries are
 * quarantined independently; no filesystem content is executed or modified.
 */
export async function loadProjectSkillCatalog(root: string): Promise<ProjectSkillCatalog> {
  const requestedRoot = NodePath.resolve(root);
  let rootPath: string;
  let projectId: string;
  try {
    rootPath = await NodeFSP.realpath(requestedRoot);
    projectId = (await readScientProjectIdentity(rootPath)).projectId;
  } catch (error) {
    return frozenCatalog({
      rootPath: requestedRoot,
      diagnostics: [
        {
          code: "invalid-project",
          path: ".scient/project.json",
          message:
            error instanceof Error
              ? error.message
              : "This folder is not an initialized Scient project.",
        },
      ],
    });
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
