// FILE: check-migration-lineage.ts
// Purpose: Fail closed when Scient's released, append-only migration history changes.
// Layer: CI and release preflight

import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const migrationsSourcePath = "apps/server/src/persistence/Migrations.ts";
const migrationsDirectoryPath = "apps/server/src/persistence/Migrations";
const defaultReleaseRef = "refs/remotes/origin/release/stable";

export interface MigrationEntry {
  readonly id: number;
  readonly name: string;
  readonly importName: string;
}

export interface MigrationCatalog {
  readonly entries: readonly MigrationEntry[];
  readonly importPaths: ReadonlyMap<string, string>;
}

export interface ReleasedIdentityViolation {
  readonly id: number;
  readonly releasedName: string;
  readonly currentName: string | null;
}

export interface ReleasedIdentityAllowance {
  readonly id: number;
  readonly releasedName: string;
  readonly currentName: string;
}

/**
 * This rename shipped before the guard existed. Scient already repairs exactly
 * this tracker row in reconcileMigrationLineage when migrations 1..31 are
 * canonical. This is evidence for an existing Scient behavior, not permission
 * to add future aliases or rewrite migration history.
 */
export const RELEASED_IDENTITY_ALLOWANCES: readonly ReleasedIdentityAllowance[] = [
  {
    id: 32,
    releasedName: "ReconcileLegacyT3SchemaImport",
    currentName: "ReconcileImportedSchemaLineage",
  },
];

const entriesBlockPattern = /export const migrationEntries\s*=\s*\[([\s\S]*?)\]\s*as const;/u;
const entryPattern = /\[\s*(\d+)\s*,\s*"([^"]+)"\s*,\s*([A-Za-z_$][\w$]*)\s*\]/gu;
const importPattern = /import\s+([A-Za-z_$][\w$]*)\s+from\s+"(\.\/Migrations\/[^"]+\.ts)";/gu;
const numberedTypeScriptModulePattern = /^\d{3}_.+\.ts$/u;
const migrationNamePattern = /^[A-Z][A-Za-z0-9]*$/u;

const migrationImportName = (id: number): string => `Migration${String(id).padStart(4, "0")}`;
const migrationModuleName = (id: number, name: string): string =>
  `${String(id).padStart(3, "0")}_${name}.ts`;
const migrationImportPath = (id: number, name: string): string =>
  `./Migrations/${migrationModuleName(id, name)}`;

export function parseMigrationCatalog(source: string): MigrationCatalog {
  const entriesBlock = entriesBlockPattern.exec(source);
  if (entriesBlock?.[1] === undefined) {
    throw new Error(`Could not locate migrationEntries in ${migrationsSourcePath}.`);
  }

  const entries = [...entriesBlock[1].matchAll(entryPattern)].map((match) => ({
    id: Number(match[1]),
    name: match[2]!,
    importName: match[3]!,
  }));
  if (entries.length === 0) {
    throw new Error(`Parsed zero migrations from ${migrationsSourcePath}.`);
  }

  const importPaths = new Map<string, string>();
  for (const match of source.matchAll(importPattern)) {
    importPaths.set(match[1]!, match[2]!);
  }
  return { entries, importPaths };
}

export function findCurrentStructureViolations(
  catalog: MigrationCatalog,
  migrationModuleNames: readonly string[],
): string[] {
  const problems: string[] = [];
  const seenIds = new Map<number, string>();
  const seenNames = new Map<string, number>();
  const expectedModules = new Set<string>();

  for (const [index, entry] of catalog.entries.entries()) {
    const expectedId = index + 1;
    const duplicateIdName = seenIds.get(entry.id);
    if (duplicateIdName !== undefined) {
      problems.push(
        `Migration ID ${entry.id} is duplicated by "${duplicateIdName}" and "${entry.name}".`,
      );
    }
    seenIds.set(entry.id, entry.name);

    const duplicateNameId = seenNames.get(entry.name);
    if (duplicateNameId !== undefined) {
      problems.push(
        `Migration name "${entry.name}" is duplicated at IDs ${duplicateNameId} and ${entry.id}.`,
      );
    }
    seenNames.set(entry.name, entry.id);

    if (entry.id !== expectedId) {
      problems.push(
        `Migration position ${index + 1} must use contiguous ID ${expectedId}, found ${entry.id}.`,
      );
    }
    if (!migrationNamePattern.test(entry.name)) {
      problems.push(`Migration ${entry.id} has invalid name "${entry.name}".`);
    }

    const expectedImportName = migrationImportName(entry.id);
    if (entry.importName !== expectedImportName) {
      problems.push(
        `Migration ${entry.id} must use import ${expectedImportName}, found ${entry.importName}.`,
      );
    }

    const expectedPath = migrationImportPath(entry.id, entry.name);
    const actualPath = catalog.importPaths.get(entry.importName);
    if (actualPath !== expectedPath) {
      problems.push(
        `Migration ${entry.id} must import ${expectedPath}, found ${actualPath ?? "no import"}.`,
      );
    }
    expectedModules.add(migrationModuleName(entry.id, entry.name));
  }

  const actualModules = new Set(
    migrationModuleNames.filter(
      (name) => numberedTypeScriptModulePattern.test(name) && !name.endsWith(".test.ts"),
    ),
  );
  for (const expected of expectedModules) {
    if (!actualModules.has(expected)) {
      problems.push(`Migration module ${expected} is missing.`);
    }
  }
  for (const actual of actualModules) {
    if (!expectedModules.has(actual)) {
      problems.push(`Migration module ${actual} has no matching migrationEntries entry.`);
    }
  }
  return problems;
}

export function findReleasedIdentityViolations(
  released: readonly MigrationEntry[],
  current: readonly MigrationEntry[],
  allowances: readonly ReleasedIdentityAllowance[] = RELEASED_IDENTITY_ALLOWANCES,
): ReleasedIdentityViolation[] {
  const currentNames = new Map(current.map((entry) => [entry.id, entry.name]));
  const allowed = new Set(
    allowances.map(
      ({ id, releasedName, currentName }) => `${id}\u0000${releasedName}\u0000${currentName}`,
    ),
  );

  return released.flatMap((entry) => {
    const currentName = currentNames.get(entry.id) ?? null;
    if (currentName === entry.name) return [];
    if (currentName !== null && allowed.has(`${entry.id}\u0000${entry.name}\u0000${currentName}`)) {
      return [];
    }
    return [{ id: entry.id, releasedName: entry.name, currentName }];
  });
}

const canonicalText = (contents: string): string => contents.replaceAll("\r\n", "\n");

export function findReleasedContentViolations(
  released: readonly MigrationEntry[],
  currentContents: ReadonlyMap<string, string>,
  releasedContents: ReadonlyMap<string, string>,
): string[] {
  const problems: string[] = [];
  for (const entry of released) {
    const path = migrationModuleName(entry.id, entry.name);
    const releasedContent = releasedContents.get(path);
    const currentContent = currentContents.get(path);
    if (releasedContent === undefined) {
      problems.push(`Released migration ${path} could not be read.`);
      continue;
    }
    if (currentContent === undefined) {
      problems.push(`Released migration ${path} was deleted.`);
      continue;
    }
    if (canonicalText(currentContent) !== canonicalText(releasedContent)) {
      problems.push(`Released migration ${path} was modified.`);
    }
  }
  return problems;
}

function git(args: readonly string[]): { readonly status: number; readonly stdout: string } {
  const result = spawnSync("git", [...args], { cwd: repoRoot, encoding: "utf8" });
  return { status: result.status ?? 1, stdout: result.stdout ?? "" };
}

function showFile(ref: string, path: string): string | undefined {
  const result = git(["show", `${ref}:${path}`]);
  return result.status === 0 ? result.stdout : undefined;
}

function fail(problems: readonly string[]): void {
  console.error("Scient migration lineage validation failed:");
  for (const problem of problems) console.error(`- ${problem}`);
  console.error(
    "Released migrations are append-only. Add a new migration instead of renumbering, " +
      "renaming, editing, or deleting shipped history.",
  );
  process.exitCode = 1;
}

function main(): void {
  const currentSource = readFileSync(resolve(repoRoot, migrationsSourcePath), "utf8");
  const currentCatalog = parseMigrationCatalog(currentSource);
  const moduleNames = readdirSync(resolve(repoRoot, migrationsDirectoryPath));
  const structureProblems = findCurrentStructureViolations(currentCatalog, moduleNames);
  if (structureProblems.length > 0) {
    fail(structureProblems);
    return;
  }

  const releaseRef = process.env.SCIENT_MIGRATION_RELEASE_REF ?? defaultReleaseRef;
  if (git(["rev-parse", "--verify", "--quiet", `${releaseRef}^{commit}`]).status !== 0) {
    fail([
      `Official release reference ${releaseRef} is unavailable. Fetch origin/release/stable before running the guard.`,
    ]);
    return;
  }

  const tagResult = git(["tag", "--merged", releaseRef, "--list", "v[0-9]*", "--sort=-v:refname"]);
  const tags = tagResult.stdout
    .split("\n")
    .map((tag) => tag.trim())
    .filter(Boolean);
  if (tagResult.status !== 0 || tags.length === 0) {
    fail([`No official release tags are reachable from ${releaseRef}.`]);
    return;
  }

  const identityProblems: string[] = [];
  const head = git(["rev-parse", "HEAD"]).stdout.trim();
  let contentBaseline: { readonly tag: string; readonly catalog: MigrationCatalog } | undefined;
  let checkedTags = 0;
  for (const tag of tags) {
    const releasedSource = showFile(tag, migrationsSourcePath);
    if (releasedSource === undefined) continue;

    let releasedCatalog: MigrationCatalog;
    try {
      releasedCatalog = parseMigrationCatalog(releasedSource);
    } catch (error) {
      identityProblems.push(
        `${tag} contains an unreadable migration catalog: ${error instanceof Error ? error.message : String(error)}`,
      );
      continue;
    }
    checkedTags += 1;
    const tagCommit = git(["rev-list", "-n", "1", tag]).stdout.trim();
    // On a tag-triggered release run, the new tag already points at HEAD. It
    // cannot prove its own history was append-only, so compare content with the
    // previous shipped tag instead. Identity is still checked across all tags.
    if (contentBaseline === undefined && tagCommit !== head) {
      contentBaseline = { tag, catalog: releasedCatalog };
    }
    for (const violation of findReleasedIdentityViolations(
      releasedCatalog.entries,
      currentCatalog.entries,
    )) {
      identityProblems.push(
        `${tag} shipped migration ${violation.id} as "${violation.releasedName}", but current ` +
          `history has ${violation.currentName === null ? "no entry" : `"${violation.currentName}"`}.`,
      );
    }
  }

  if (contentBaseline === undefined || checkedTags === 0) {
    fail([
      `No prior released migration catalog could be read from official tags reachable from ${releaseRef}.`,
    ]);
    return;
  }

  const currentContents = new Map<string, string>();
  const releasedContents = new Map<string, string>();
  for (const entry of contentBaseline.catalog.entries) {
    const moduleName = migrationModuleName(entry.id, entry.name);
    try {
      currentContents.set(
        moduleName,
        readFileSync(resolve(repoRoot, migrationsDirectoryPath, moduleName), "utf8"),
      );
    } catch {
      // Reported as a deletion by findReleasedContentViolations.
    }
    const releasedContent = showFile(
      contentBaseline.tag,
      `${migrationsDirectoryPath}/${moduleName}`,
    );
    if (releasedContent !== undefined) releasedContents.set(moduleName, releasedContent);
  }

  const contentProblems = findReleasedContentViolations(
    contentBaseline.catalog.entries,
    currentContents,
    releasedContents,
  ).map((problem) => `${problem} (baseline: ${contentBaseline.tag})`);
  const problems = [...identityProblems, ...contentProblems];
  if (problems.length > 0) {
    fail(problems);
    return;
  }

  console.log(
    `Scient migration lineage passed: ${currentCatalog.entries.length} contiguous migrations; ` +
      `${checkedTags} official release tags checked; shipped content matches ${contentBaseline.tag}.`,
  );
}

if (import.meta.main) main();
