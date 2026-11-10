// @effect-diagnostics nodeBuiltinImport:off -- Personal skill discovery is a bounded filesystem boundary.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import type { SkillRelease } from "./model.ts";
import { loadPersonalSkillRelease } from "./release.ts";

export const MAX_PERSONAL_SKILLS = 200;
export const MAX_PERSONAL_SKILL_BYTES = 100 * 1024 * 1024;

export interface PersonalSkillDiagnostic {
  readonly code: "invalid-skills-directory" | "invalid-skill" | "personal-skill-limit";
  /** The skill folder's name, or empty for the skills folder itself. */
  readonly path: string;
  readonly message: string;
}

export interface PersonalSkillCatalog {
  readonly rootPath: string;
  readonly releases: ReadonlyArray<SkillRelease>;
  readonly diagnostics: ReadonlyArray<PersonalSkillDiagnostic>;
}

const compareStrings = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

const frozen = (catalog: PersonalSkillCatalog): PersonalSkillCatalog =>
  Object.freeze({
    rootPath: catalog.rootPath,
    releases: Object.freeze([...catalog.releases]),
    diagnostics: Object.freeze(catalog.diagnostics.map((item) => Object.freeze({ ...item }))),
  });

/**
 * Every skill folder in Scient's personal skills folder. Each folder is checked on its own, so
 * one broken skill never hides the others. Names starting with a dot are Scient's own
 * in-progress folders and are skipped.
 */
export async function loadPersonalSkillCatalog(root: string): Promise<PersonalSkillCatalog> {
  const rootPath = NodePath.resolve(root);
  let entries;
  try {
    const stat = await NodeFSP.lstat(rootPath);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      return frozen({
        rootPath,
        releases: [],
        diagnostics: [
          {
            code: "invalid-skills-directory",
            path: "",
            message: "The skills folder must be a real folder.",
          },
        ],
      });
    }
    entries = (await NodeFSP.readdir(rootPath, { withFileTypes: true }))
      .filter((entry) => !entry.name.startsWith("."))
      .sort((left, right) => compareStrings(left.name, right.name));
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return frozen({ rootPath, releases: [], diagnostics: [] });
    }
    throw error;
  }
  const releases: SkillRelease[] = [];
  const diagnostics: PersonalSkillDiagnostic[] = [];
  let totalBytes = 0;
  for (const entry of entries) {
    if (releases.length >= MAX_PERSONAL_SKILLS) {
      diagnostics.push({
        code: "personal-skill-limit",
        path: entry.name,
        message: `Scient keeps at most ${MAX_PERSONAL_SKILLS} personal skills.`,
      });
      break;
    }
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    try {
      const release = await loadPersonalSkillRelease(NodePath.join(rootPath, entry.name));
      if (totalBytes + release.snapshotBytes > MAX_PERSONAL_SKILL_BYTES) {
        diagnostics.push({
          code: "personal-skill-limit",
          path: entry.name,
          message: "Personal skills exceed the 100 MiB total limit.",
        });
        break;
      }
      totalBytes += release.snapshotBytes;
      releases.push(release);
    } catch (error) {
      diagnostics.push({
        code: "invalid-skill",
        path: entry.name,
        message: error instanceof Error ? error.message : "This skill could not be read.",
      });
    }
  }
  return frozen({ rootPath, releases, diagnostics });
}
