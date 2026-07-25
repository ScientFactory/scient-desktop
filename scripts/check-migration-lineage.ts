// FILE: check-migration-lineage.ts
// Purpose: Fail closed when Scient's released, append-only migration history changes.
// Layer: CI and release preflight

import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, posix, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

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

export interface LocalDependencyClosure {
  readonly contents: ReadonlyMap<string, string>;
  readonly problems: readonly string[];
}

export type ReadRepositoryFile = (path: string) => string | undefined;
export interface PinnedWorkspaceImport {
  readonly resolutionEvidence: readonly (
    | { readonly kind: "package-root-import"; readonly path: string }
    | {
        readonly kind: "named-barrel-export";
        readonly path: string;
        readonly exportName: string;
      }
  )[];
  /** The runtime source to traverse after the declaration chain is frozen. */
  readonly runtimeSourcePath: string;
}
export type PinnedWorkspaceImports = ReadonlyMap<string, PinnedWorkspaceImport>;

interface StaticModuleReference {
  readonly specifier: string;
  readonly bindingKey: string;
}

interface ResolvedDependency {
  readonly path: string;
  readonly traverse: boolean;
  readonly content?: string;
}

export function pinnedWorkspaceImportKey(
  importerPath: string,
  specifier: string,
  bindingKey: string,
): string {
  return `${importerPath}\u0000${specifier}\u0000${bindingKey}`;
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

const sourceModuleExtensions = new Set([
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
]);
const extensionlessResolutionSuffixes = [
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".json",
  "/index.ts",
  "/index.tsx",
  "/index.mts",
  "/index.cts",
  "/index.js",
  "/index.jsx",
  "/index.mjs",
  "/index.cjs",
] as const;

function collectStaticModuleSpecifiers(
  source: string,
  path: string,
): {
  readonly references: readonly StaticModuleReference[];
  readonly problems: readonly string[];
} {
  const sourceFile = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
  const parseDiagnostics = (
    sourceFile as ts.SourceFile & {
      readonly parseDiagnostics?: readonly ts.Diagnostic[];
    }
  ).parseDiagnostics;
  const problems = (parseDiagnostics ?? []).map(
    (diagnostic) =>
      `${path} has invalid syntax: ${ts.flattenDiagnosticMessageText(diagnostic.messageText, " ")}`,
  );
  const references: StaticModuleReference[] = [];

  const visit = (node: ts.Node): void => {
    if (
      ts.isImportDeclaration(node) &&
      node.moduleSpecifier &&
      ts.isStringLiteralLike(node.moduleSpecifier) &&
      !node.importClause?.isTypeOnly &&
      !(
        node.importClause?.namedBindings &&
        ts.isNamedImports(node.importClause.namedBindings) &&
        !node.importClause.name &&
        node.importClause.namedBindings.elements.length > 0 &&
        node.importClause.namedBindings.elements.every((element) => element.isTypeOnly)
      )
    ) {
      const bindings: string[] = [];
      if (!node.importClause) {
        bindings.push("side-effect");
      } else {
        if (node.importClause.name) bindings.push("default");
        const namedBindings = node.importClause.namedBindings;
        if (namedBindings && ts.isNamespaceImport(namedBindings)) {
          bindings.push("*");
        } else if (namedBindings) {
          for (const element of namedBindings.elements) {
            if (!element.isTypeOnly) bindings.push(element.propertyName?.text ?? element.name.text);
          }
        }
      }
      references.push({
        specifier: node.moduleSpecifier.text,
        bindingKey: `import:${bindings.toSorted().join(",")}`,
      });
    } else if (
      ts.isExportDeclaration(node) &&
      !node.isTypeOnly &&
      node.moduleSpecifier &&
      ts.isStringLiteralLike(node.moduleSpecifier)
    ) {
      const bindings = node.exportClause
        ? ts.isNamespaceExport(node.exportClause)
          ? ["*"]
          : node.exportClause.elements
              .filter((element) => !element.isTypeOnly)
              .map((element) => element.propertyName?.text ?? element.name.text)
        : ["*"];
      references.push({
        specifier: node.moduleSpecifier.text,
        bindingKey: `export:${bindings.toSorted().join(",")}`,
      });
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference)
    ) {
      const expression = node.moduleReference.expression;
      if (expression && ts.isStringLiteralLike(expression)) {
        references.push({ specifier: expression.text, bindingKey: "import:*" });
      }
    } else if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === "require"))
    ) {
      problems.push(
        `${path} uses ${node.expression.kind === ts.SyntaxKind.ImportKeyword ? "dynamic import()" : "require()"}; migration dependencies must be statically resolvable.`,
      );
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return { references, problems };
}

function packageRootImportFingerprint(source: string, path: string): string {
  let manifest: unknown;
  try {
    manifest = JSON.parse(source);
  } catch (error) {
    throw new Error(
      `${path} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    throw new Error(`${path} must contain a package manifest object.`);
  }
  const exportsField = (manifest as Record<string, unknown>).exports;
  if (!exportsField || typeof exportsField !== "object" || Array.isArray(exportsField)) {
    throw new Error(`${path} must declare an exports object.`);
  }
  const rootExport = (exportsField as Record<string, unknown>)["."];
  const importTarget =
    rootExport && typeof rootExport === "object" && !Array.isArray(rootExport)
      ? (rootExport as Record<string, unknown>).import
      : undefined;
  if (typeof importTarget !== "string" || importTarget.length === 0) {
    throw new Error(`${path} must declare exports["."].import as a non-empty string.`);
  }
  return `package-root-import:${importTarget}`;
}

function declaresRuntimeExport(source: string, path: string, exportName: string): boolean {
  const sourceFile = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
  return sourceFile.statements.some((statement) => {
    const modifiers = ts.canHaveModifiers(statement) ? ts.getModifiers(statement) : undefined;
    if (!modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)) return false;
    if (ts.isVariableStatement(statement)) {
      return statement.declarationList.declarations.some(
        (declaration) => ts.isIdentifier(declaration.name) && declaration.name.text === exportName,
      );
    }
    return (
      (ts.isFunctionDeclaration(statement) ||
        ts.isClassDeclaration(statement) ||
        ts.isEnumDeclaration(statement)) &&
      statement.name?.text === exportName
    );
  });
}

function namedBarrelExportFingerprint(
  source: string,
  path: string,
  exportName: string,
  readFile: ReadRepositoryFile,
): string {
  const sourceFile = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
  const sources: string[] = [];
  for (const statement of sourceFile.statements) {
    if (!ts.isExportDeclaration(statement) || statement.isTypeOnly || !statement.moduleSpecifier) {
      continue;
    }
    if (!ts.isStringLiteralLike(statement.moduleSpecifier)) continue;
    const specifier = statement.moduleSpecifier.text;
    if (statement.exportClause && ts.isNamedExports(statement.exportClause)) {
      if (
        statement.exportClause.elements.some(
          (element) => !element.isTypeOnly && element.name.text === exportName,
        )
      ) {
        sources.push(specifier);
      }
      continue;
    }
    if (statement.exportClause) continue;

    const resolved = resolveLocalDependency(
      path,
      { specifier, bindingKey: "export:*" },
      readFile,
      new Map(),
    );
    const targetPath = resolved.dependencies?.[0]?.path;
    const targetSource = targetPath ? readFile(targetPath) : undefined;
    if (targetPath && targetSource && declaresRuntimeExport(targetSource, targetPath, exportName)) {
      sources.push(specifier);
    }
  }
  if (sources.length === 0) {
    throw new Error(`${path} does not resolve runtime export ${exportName}.`);
  }
  return `named-barrel-export:${exportName}:${sources.toSorted().join(",")}`;
}

function resolveLocalDependency(
  importerPath: string,
  reference: StaticModuleReference,
  readFile: ReadRepositoryFile,
  pinnedWorkspaceImports: PinnedWorkspaceImports,
): {
  readonly dependencies?: readonly ResolvedDependency[];
  readonly problem?: string;
} {
  const { specifier } = reference;
  if (specifier.startsWith("/")) {
    return {
      problem: `${importerPath} imports absolute path ${JSON.stringify(specifier)}.`,
    };
  }
  if (!specifier.startsWith("./") && !specifier.startsWith("../")) {
    const pinnedWorkspaceImport = pinnedWorkspaceImports.get(
      pinnedWorkspaceImportKey(importerPath, specifier, reference.bindingKey),
    );
    if (pinnedWorkspaceImport) {
      const dependencies: ResolvedDependency[] = [];
      for (const evidence of pinnedWorkspaceImport.resolutionEvidence) {
        const source = readFile(evidence.path);
        if (source === undefined) {
          return {
            problem:
              `${importerPath} workspace import ${JSON.stringify(specifier)} resolves through ` +
              `missing ${evidence.path}.`,
          };
        }
        try {
          const content =
            evidence.kind === "package-root-import"
              ? packageRootImportFingerprint(source, evidence.path)
              : namedBarrelExportFingerprint(source, evidence.path, evidence.exportName, readFile);
          dependencies.push({ path: evidence.path, traverse: false, content });
        } catch (error) {
          return {
            problem: error instanceof Error ? error.message : String(error),
          };
        }
      }
      dependencies.push({ path: pinnedWorkspaceImport.runtimeSourcePath, traverse: true });
      return { dependencies };
    }
    if (
      specifier.startsWith("@synara/") ||
      specifier.startsWith("@scientfactory/") ||
      specifier === "effect-acp" ||
      specifier.startsWith("effect-acp/")
    ) {
      return {
        problem:
          `${importerPath} workspace import ${JSON.stringify(specifier)} ` +
          `(${reference.bindingKey}) has no exact pinned repository-local entrypoint.`,
      };
    }
    return {};
  }

  const candidateBase = posix.normalize(posix.join(posix.dirname(importerPath), specifier));
  if (candidateBase === ".." || candidateBase.startsWith("../")) {
    return {
      problem: `${importerPath} local import ${JSON.stringify(specifier)} escapes the repository.`,
    };
  }

  const suffixes = posix.extname(candidateBase) ? ([""] as const) : extensionlessResolutionSuffixes;
  const matches = suffixes
    .map((suffix) => `${candidateBase}${suffix}`)
    .filter((candidate) => readFile(candidate) !== undefined);
  if (matches.length === 0) {
    return {
      problem: `${importerPath} local import ${JSON.stringify(specifier)} could not be resolved.`,
    };
  }
  if (matches.length > 1) {
    return {
      problem:
        `${importerPath} local import ${JSON.stringify(specifier)} is ambiguous: ` +
        matches.join(", "),
    };
  }
  return { dependencies: [{ path: matches[0]!, traverse: true }] };
}

export function buildLocalDependencyClosure(
  entryPaths: readonly string[],
  sourceReader: ReadRepositoryFile,
  pinnedWorkspaceImports: PinnedWorkspaceImports = new Map(),
): LocalDependencyClosure {
  const contents = new Map<string, string>();
  const problems: string[] = [];
  const readCache = new Map<string, string | undefined>();
  const readFile = (path: string): string | undefined => {
    if (!readCache.has(path)) readCache.set(path, sourceReader(path));
    return readCache.get(path);
  };
  const pending: ResolvedDependency[] = entryPaths.map((path) => ({ path, traverse: true }));
  const traversed = new Set<string>();

  while (pending.length > 0) {
    const dependency = pending.pop()!;
    const { path } = dependency;
    const source = dependency.content ?? readFile(path);
    if (source === undefined) {
      problems.push(`Migration dependency ${path} could not be read.`);
      continue;
    }
    contents.set(path, source);
    if (
      !dependency.traverse ||
      traversed.has(path) ||
      !sourceModuleExtensions.has(posix.extname(path))
    ) {
      continue;
    }
    traversed.add(path);

    const parsed = collectStaticModuleSpecifiers(source, path);
    problems.push(...parsed.problems);
    for (const reference of parsed.references) {
      const resolved = resolveLocalDependency(path, reference, readFile, pinnedWorkspaceImports);
      if (resolved.problem) problems.push(resolved.problem);
      if (resolved.dependencies) pending.push(...resolved.dependencies);
    }
  }

  return { contents, problems };
}

export function findReleasedDependencyViolations(
  releasedContents: ReadonlyMap<string, string>,
  currentContents: ReadonlyMap<string, string>,
  migrationModulePaths: ReadonlySet<string> = new Set(),
): string[] {
  const problems: string[] = [];
  for (const [path, releasedContent] of releasedContents) {
    if (migrationModulePaths.has(path)) continue;
    const currentContent = currentContents.get(path);
    if (currentContent === undefined) {
      problems.push(`Released migration dependency ${path} was deleted or is no longer reachable.`);
    } else if (canonicalText(currentContent) !== canonicalText(releasedContent)) {
      problems.push(`Released migration dependency ${path} was modified.`);
    }
  }
  for (const path of currentContents.keys()) {
    if (migrationModulePaths.has(path) || releasedContents.has(path)) continue;
    problems.push(`Released migration dependency closure gained ${path}.`);
  }
  return problems.toSorted();
}

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

function git(args: readonly string[]): {
  readonly status: number;
  readonly stdout: string;
} {
  const result = spawnSync("git", [...args], {
    cwd: repoRoot,
    encoding: "utf8",
  });
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
  const migrationModulePaths = new Set<string>();
  for (const entry of contentBaseline.catalog.entries) {
    const moduleName = migrationModuleName(entry.id, entry.name);
    migrationModulePaths.add(`${migrationsDirectoryPath}/${moduleName}`);
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

  const readCurrentFile: ReadRepositoryFile = (path) => {
    try {
      return readFileSync(resolve(repoRoot, path), "utf8");
    } catch {
      return undefined;
    }
  };
  const pinnedWorkspaceImports: PinnedWorkspaceImports = new Map([
    [
      pinnedWorkspaceImportKey(
        "apps/server/src/persistence/modelSelectionCompatibility.ts",
        "@synara/contracts",
        "import:MODEL_OPTIONS_BY_PROVIDER",
      ),
      {
        resolutionEvidence: [
          { kind: "package-root-import", path: "packages/contracts/package.json" },
          {
            kind: "named-barrel-export",
            path: "packages/contracts/src/index.ts",
            exportName: "MODEL_OPTIONS_BY_PROVIDER",
          },
        ],
        runtimeSourcePath: "packages/contracts/src/model.ts",
      },
    ],
  ]);
  const releasedClosure = buildLocalDependencyClosure(
    [...migrationModulePaths],
    (path) => showFile(contentBaseline.tag, path),
    pinnedWorkspaceImports,
  );
  const currentReleasedClosure = buildLocalDependencyClosure(
    [...migrationModulePaths],
    readCurrentFile,
    pinnedWorkspaceImports,
  );
  const currentMigrationModulePaths = currentCatalog.entries.map(
    (entry) => `${migrationsDirectoryPath}/${migrationModuleName(entry.id, entry.name)}`,
  );
  const currentSafetyClosure = buildLocalDependencyClosure(
    currentMigrationModulePaths,
    readCurrentFile,
    pinnedWorkspaceImports,
  );
  const dependencyProblems = [
    ...releasedClosure.problems.map(
      (problem) =>
        `Released dependency graph is unsafe: ${problem} (baseline: ${contentBaseline.tag})`,
    ),
    ...currentSafetyClosure.problems.map(
      (problem) => `Current dependency graph is unsafe: ${problem}`,
    ),
    ...findReleasedDependencyViolations(
      releasedClosure.contents,
      currentReleasedClosure.contents,
      migrationModulePaths,
    ).map((problem) => `${problem} (baseline: ${contentBaseline.tag})`),
  ];
  const problems = [...identityProblems, ...contentProblems, ...dependencyProblems];
  if (problems.length > 0) {
    fail(problems);
    return;
  }

  console.log(
    `Scient migration lineage passed: ${currentCatalog.entries.length} contiguous migrations; ` +
      `${checkedTags} official release tags checked; shipped migration code and local dependencies ` +
      `match ${contentBaseline.tag}.`,
  );
}

if (import.meta.main) main();
