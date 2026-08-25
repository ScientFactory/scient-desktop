import {
  skillReleaseKey,
  toSkillReleaseSummary,
  type SkillRelease,
  type SkillReleaseRef,
  type SkillReleaseSummary,
} from "./model.ts";
import { loadSkillRelease } from "./release.ts";

const compareStrings = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

export interface SkillCatalogDiagnostic {
  readonly code: "duplicate-release" | "invalid-release";
  readonly rootPath: string;
  readonly message: string;
}

export interface SkillCatalog {
  readonly releases: ReadonlyArray<SkillRelease>;
  readonly diagnostics: ReadonlyArray<SkillCatalogDiagnostic>;
}

export function createSkillCatalog(
  entries: ReadonlyArray<{ readonly source: string; readonly release: SkillRelease }>,
): SkillCatalog {
  const releases: SkillRelease[] = [];
  const diagnostics: SkillCatalogDiagnostic[] = [];
  const byIdentity = new Map<string, SkillRelease>();
  for (const { source, release } of [...entries].sort((left, right) =>
    compareStrings(left.source, right.source),
  )) {
    const identity = `${release.id}@${release.version}`;
    if (byIdentity.has(identity)) {
      diagnostics.push({
        code: "duplicate-release",
        rootPath: source,
        message: `Skill release '${identity}' is already registered.`,
      });
      continue;
    }
    byIdentity.set(identity, release);
    releases.push(release);
  }
  releases.sort(
    (left, right) =>
      compareStrings(left.id, right.id) ||
      compareStrings(right.version, left.version) ||
      compareStrings(left.digest, right.digest),
  );
  return Object.freeze({
    releases: Object.freeze(releases),
    diagnostics: Object.freeze(diagnostics.map((diagnostic) => Object.freeze(diagnostic))),
  });
}

/** Quarantine invalid roots independently so one release cannot prevent startup. */
export async function loadSkillCatalog(roots: ReadonlyArray<string>): Promise<SkillCatalog> {
  const diagnostics: SkillCatalogDiagnostic[] = [];
  const entries: Array<{ readonly source: string; readonly release: SkillRelease }> = [];
  for (const rootPath of [...roots].sort(compareStrings)) {
    let release: SkillRelease;
    try {
      release = await loadSkillRelease(rootPath);
    } catch (error) {
      diagnostics.push({
        code: "invalid-release",
        rootPath,
        message: error instanceof Error ? error.message : "Skill release validation failed.",
      });
      continue;
    }
    entries.push({ source: rootPath, release });
  }
  const catalog = createSkillCatalog(entries);
  return Object.freeze({
    releases: catalog.releases,
    diagnostics: Object.freeze(
      [...diagnostics, ...catalog.diagnostics].map((diagnostic) => Object.freeze(diagnostic)),
    ),
  });
}

export function resolveExactSkillRelease(
  catalog: SkillCatalog,
  reference: SkillReleaseRef,
): SkillRelease | undefined {
  return catalog.releases.find(
    (release) =>
      release.id === reference.id &&
      release.version === reference.version &&
      release.digest === reference.digest &&
      release.origin === reference.origin,
  );
}

export function listSkillReleaseSummaries(
  catalog: SkillCatalog,
): ReadonlyArray<SkillReleaseSummary> {
  return catalog.releases.map(toSkillReleaseSummary);
}

export function catalogByReleaseKey(catalog: SkillCatalog): ReadonlyMap<string, SkillRelease> {
  return new Map(catalog.releases.map((release) => [skillReleaseKey(release), release] as const));
}
