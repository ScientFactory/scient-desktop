// FILE: check-migration-lineage.ts
// Purpose: Fail closed when Scient's released, append-only migration history changes.
// Layer: CI and release preflight

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
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
  readonly runtimeSafetyProblems?: readonly string[];
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
  readonly traversalSource?: string;
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

/**
 * Exact pre-guard source rewrites found by the one-time audit of every official
 * release tag. Each allowance pins both Git blob identities; it cannot bless a
 * new edit to either the historical or current migration.
 */
export const RELEASED_CONTENT_ALLOWANCES = new Set([
  "5:c950da76a18e2fd25609109764831ded8c84fbfe:5c49219877e23af4e795c72c2b571a81b1122e4f",
  "16:68d7baf83fa27e432e771c021052bcff9fec27d2:bce0bb7d2b82e5ba55a16002512bcb5f42fe15ea",
  "23:c34152b5f792a95398db7787d4ead6c34d098bd2:c7c7b52a7e7f4fbd00aef479daaae28fb9e4ab8c",
  "32:584318be301c5eb2b4374eb2c9850dff7fbed82c:5228231e32cb0c9d2519cdcdf403777f5d25cc93",
  "32:75ec7b220a38aa1dafc55aee7881439792477002:5228231e32cb0c9d2519cdcdf403777f5d25cc93",
  "32:ab3f15243ce0e52083570d112ddb947206b3d24a:5228231e32cb0c9d2519cdcdf403777f5d25cc93",
  "36:ccc73b97cce1ba78ddd22c013ac6474e1d67163b:4196b4113c7b465d35fd770748a745b2bddb9999",
  "39:58c3e0a0c4128dfc218296231f7c7f880d15487d:f149b299375c6fd12931618b4eb93ef1cf00b94d",
  // Migration 035 decoupled from the live model catalog: it now imports the frozen
  // v0.5.13 snapshot (migration035FrozenModelSelectionCompatibility) instead of the
  // evolving modelSelectionCompatibility, so the catalog (model.ts) can add models
  // like Opus 5 without editing shipped migration history. This one-time audited pair
  // pins the exact old (catalog-coupled) and new (frozen-snapshot) 035 blobs; behavior
  // is proven identical by migration035FrozenModelSelectionCompatibility.test.ts.
  "35:6ee14d9aef504f59ed0485f3c03942268bb87300:70612a2a845bdd42aed5b23213112e7a016232bd",
]);

/**
 * Exact, one-time dependency-graph changes found by an audit of the migration 035
 * decoupling. Each key pins a path AND its exact Git blob so the allowance can only
 * bless this specific graph delta and fails closed on anything else:
 *   removed:<path>:<baseline blob>  — a file that left the released closure
 *   added:<path>:<current blob>     — a file that entered the released closure
 * Severing migration 035's import of the live modelSelectionCompatibility removes the
 * sole bridge into @synara/contracts, so the entire contracts barrel legitimately
 * leaves the migration dependency closure and the frozen snapshot enters it. These
 * files' current contents are no longer migration-frozen (that is the point); the
 * baseline blobs below record exactly what dropped out.
 */
export const RELEASED_DEPENDENCY_GRAPH_ALLOWANCES = new Set<string>([
  // One-time audited decoupling of migration 035 from the live model catalog.
  // Migration 035 now imports migration035FrozenModelSelectionCompatibility instead of
  // the live modelSelectionCompatibility. That severs the sole bridge from migration
  // history into @synara/contracts, so modelSelectionCompatibility and the entire
  // contracts barrel legitimately leave the migration dependency closure while the
  // frozen snapshot enters it. Each key pins the exact baseline (removed) or current
  // (added) blob, so this allowance blesses only this specific graph delta and fails
  // closed on any other change. See migration035FrozenModelSelectionCompatibility.test.ts.

  // The frozen snapshot that migration 035 now depends on (enters the closure).
  "added:apps/server/src/persistence/migration035FrozenModelSelectionCompatibility.ts:05214e26a6f5011b816a40f2a01eca45eb69a24f",

  // The live helper migration 035 no longer imports (leaves the closure).
  "removed:apps/server/src/persistence/modelSelectionCompatibility.ts:276a9f520bcc4dc2b2888a8eba0dba5b3afbd3c4",

  // The @synara/contracts barrel and every module it re-exports, no longer reachable
  // from migration history once the bridge is cut (baseline v0.5.13 blobs).
  "removed:packages/contracts/package.json:66f32ae9de032dd38ef54e486c9eac6fbe9982cc",
  "removed:packages/contracts/src/agentMentions.ts:089af8b1f73ff88f0bb210a59937dd3f04ad9c23",
  "removed:packages/contracts/src/auth.ts:c0f8cd5cf17981ec98e6f9ba7582337eb53ba7fb",
  "removed:packages/contracts/src/automation.ts:2dc1df66c351c71f7625f822168fff2a140a7476",
  "removed:packages/contracts/src/baseSchemas.ts:f389d24e0131cc122bf381970489a8438f296228",
  "removed:packages/contracts/src/editor.ts:06c48331d8394f0f13b0d77aa285f1369faece2f",
  "removed:packages/contracts/src/environment.ts:8bb7ec2dc1618c659578293d548ba9dfbc035091",
  "removed:packages/contracts/src/filesystem.ts:235de34a531f5b7d848e5eacf63b9f324238bafe",
  "removed:packages/contracts/src/git.ts:5efc24396fad3b1c59e82dd99499273d0da06446",
  "removed:packages/contracts/src/index.ts:d2d9da200e45d436c8028561c14037cab7a2b643",
  "removed:packages/contracts/src/ipc.ts:ae9d9a6b449e4df3ddc04d089a517aefb6b6b3df",
  "removed:packages/contracts/src/keybindings.ts:55987a7fb5db94ccc6d482d54f8131bd81e6a46d",
  "removed:packages/contracts/src/model.ts:18fb3e50a0b0dd4925f5aa2f4f7a7032073a0cfd",
  "removed:packages/contracts/src/orchestration.ts:b2326be2c768ca82e87937765e0dc48d690c5f2f",
  "removed:packages/contracts/src/project.ts:e830be9d7a7b1eef57b96c91b9a923e0eacfb0ab",
  "removed:packages/contracts/src/projectSources.ts:dc2577cd8a2720d839700e87208583600195a1ec",
  "removed:packages/contracts/src/provider.ts:31e818ae98813acf9fe8a7656e45a798a950600a",
  "removed:packages/contracts/src/providerDiscovery.ts:b2ee551ace5d836edf483a1b264fd0da454df792",
  "removed:packages/contracts/src/providerRuntime.ts:610c91a8396c1d5db18c230e93090043c6bad314",
  "removed:packages/contracts/src/pullRequests.ts:d99edf69a7b4663218f6c55dd6c81024c2f1c071",
  "removed:packages/contracts/src/rpc.ts:3d62ebfcdd7591c6527a292606a7da9c55585e9b",
  "removed:packages/contracts/src/scientProjectInitialization.ts:b26300cd323f5c4cdf6d27014c34cb75d719c538",
  "removed:packages/contracts/src/server.ts:98f0edf93fddd6dd819ad1d223eb15af966ea380",
  "removed:packages/contracts/src/settings.ts:d1988f635562785ac3a656a078613a044c52cbd6",
  "removed:packages/contracts/src/stats.ts:b65c18d0c59a081855be9e577a1d29c9f541a93b",
  "removed:packages/contracts/src/studio.ts:7e2cf016cef8fd5c41fb008283e6031ff41c552e",
  "removed:packages/contracts/src/terminal.ts:9aa62dc01ca4cc3ecbb60e8f35d57cb6b3e60e9c",
  "removed:packages/contracts/src/ws.ts:1f08097c0a88852ceb2edeb23f0e3991998a7009",
]);

// Digest of every version tag reachable from origin/release/stable at the
// v0.5.14 release boundary, encoded as sorted `tag\0commit\n` records.
// A tag-triggered run may add exactly one new tag at HEAD; the manifest must be
// advanced after publication so subsequent branch runs preserve that release.
const protectedReleaseTagCount = 80;
const protectedReleaseTagDigest =
  "7f2841bdc31adb51d83bf5b7ced256fb5ee993225a2ebc73448a40962261718d";
const runtimeResolutionEvidencePath = "@scient/migration-runtime-resolution";

const numberedTypeScriptModulePattern = /^\d{3}_.+\.ts$/u;
const migrationNamePattern = /^[A-Z][A-Za-z0-9]*$/u;

const migrationImportName = (id: number): string => `Migration${String(id).padStart(4, "0")}`;
const migrationModuleName = (id: number, name: string): string =>
  `${String(id).padStart(3, "0")}_${name}.ts`;
const migrationImportPath = (id: number, name: string): string =>
  `./Migrations/${migrationModuleName(id, name)}`;

export function parseMigrationCatalog(source: string): MigrationCatalog {
  const sourceFile = ts.createSourceFile(
    migrationsSourcePath,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const declarations = sourceFile.statements.flatMap((statement) =>
    ts.isVariableStatement(statement)
      ? statement.declarationList.declarations.filter(
          (declaration) =>
            ts.isIdentifier(declaration.name) && declaration.name.text === "migrationEntries",
        )
      : [],
  );
  if (declarations.length !== 1) {
    throw new Error(`Could not locate migrationEntries in ${migrationsSourcePath}.`);
  }

  let initializer = declarations[0]!.initializer;
  while (
    initializer &&
    (ts.isAsExpression(initializer) ||
      ts.isSatisfiesExpression(initializer) ||
      ts.isParenthesizedExpression(initializer))
  ) {
    initializer = initializer.expression;
  }
  if (!initializer || !ts.isArrayLiteralExpression(initializer)) {
    throw new Error(`migrationEntries in ${migrationsSourcePath} must be an array literal.`);
  }

  const entries = initializer.elements.map((element, index) => {
    if (!ts.isArrayLiteralExpression(element) || element.elements.length !== 3) {
      throw new Error(
        `migrationEntries element ${index + 1} in ${migrationsSourcePath} must be an exact ` +
          `[numeric ID, string name, imported migration identifier] tuple; spreads, references, ` +
          `templates, and computed entries are forbidden.`,
      );
    }
    const idNode = element.elements[0]!;
    const nameNode = element.elements[1]!;
    const importNode = element.elements[2]!;
    if (
      !ts.isNumericLiteral(idNode) ||
      !ts.isStringLiteral(nameNode) ||
      !ts.isIdentifier(importNode)
    ) {
      throw new Error(
        `migrationEntries element ${index + 1} in ${migrationsSourcePath} must be an exact ` +
          `[numeric ID, string name, imported migration identifier] tuple; spreads, references, ` +
          `templates, and computed entries are forbidden.`,
      );
    }
    return {
      id: Number(idNode.text),
      name: nameNode.text,
      importName: importNode.text,
    };
  });
  if (entries.length === 0) {
    throw new Error(`Parsed zero migrations from ${migrationsSourcePath}.`);
  }

  const importPaths = new Map<string, string>();
  for (const statement of sourceFile.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !statement.importClause?.name ||
      !ts.isStringLiteralLike(statement.moduleSpecifier)
    ) {
      continue;
    }
    const importName = statement.importClause.name.text;
    if (importPaths.has(importName)) {
      throw new Error(
        `${migrationsSourcePath} imports migration binding ${importName} more than once.`,
      );
    }
    importPaths.set(importName, statement.moduleSpecifier.text);
  }
  const migratorImports = sourceFile.statements.filter(
    (statement): statement is ts.ImportDeclaration =>
      ts.isImportDeclaration(statement) &&
      ts.isStringLiteralLike(statement.moduleSpecifier) &&
      statement.moduleSpecifier.text === "effect/unstable/sql/Migrator" &&
      statement.importClause?.namedBindings !== undefined &&
      ts.isNamespaceImport(statement.importClause.namedBindings) &&
      statement.importClause.namedBindings.name.text === "Migrator",
  );
  const bindingNames = (name: ts.BindingName): readonly string[] => {
    if (ts.isIdentifier(name)) return [name.text];
    return name.elements.flatMap((element) =>
      ts.isOmittedExpression(element) ? [] : bindingNames(element.name),
    );
  };
  const topLevelBindings = sourceFile.statements.flatMap((statement): readonly string[] => {
    if (ts.isImportDeclaration(statement)) {
      const clause = statement.importClause;
      if (!clause) return [];
      return [
        ...(clause.name ? [clause.name.text] : []),
        ...(clause.namedBindings
          ? ts.isNamespaceImport(clause.namedBindings)
            ? [clause.namedBindings.name.text]
            : clause.namedBindings.elements.map((element) => element.name.text)
          : []),
      ];
    }
    if (ts.isImportEqualsDeclaration(statement)) return [statement.name.text];
    if (ts.isVariableStatement(statement)) {
      return statement.declarationList.declarations.flatMap((declaration) =>
        bindingNames(declaration.name),
      );
    }
    if (
      (ts.isFunctionDeclaration(statement) ||
        ts.isClassDeclaration(statement) ||
        ts.isEnumDeclaration(statement)) &&
      statement.name
    ) {
      return [statement.name.text];
    }
    return [];
  });
  const declarationStatement = declarations[0]!.parent.parent;
  const declarationIndex = sourceFile.statements.findIndex(
    (statement) => statement === declarationStatement,
  );
  const freezesEntry = (statement: ts.Statement | undefined): boolean => {
    if (!statement || !ts.isForOfStatement(statement)) return false;
    const declarationList = statement.initializer;
    if (
      !ts.isVariableDeclarationList(declarationList) ||
      (declarationList.flags & ts.NodeFlags.Const) === 0 ||
      declarationList.declarations.length !== 1
    ) {
      return false;
    }
    const declaration = declarationList.declarations[0]!;
    if (
      !ts.isIdentifier(declaration.name) ||
      declaration.name.text !== "migrationEntry" ||
      !ts.isIdentifier(statement.expression) ||
      statement.expression.text !== "migrationEntries"
    ) {
      return false;
    }
    const bodyStatements = ts.isBlock(statement.statement)
      ? statement.statement.statements
      : [statement.statement];
    if (bodyStatements.length !== 1 || !ts.isExpressionStatement(bodyStatements[0]!)) return false;
    const expression = bodyStatements[0]!.expression;
    return (
      ts.isCallExpression(expression) &&
      expression.arguments.length === 1 &&
      ts.isPropertyAccessExpression(expression.expression) &&
      ts.isIdentifier(expression.expression.expression) &&
      expression.expression.expression.text === "Object" &&
      expression.expression.name.text === "freeze" &&
      ts.isIdentifier(expression.arguments[0]!) &&
      expression.arguments[0]!.text === "migrationEntry"
    );
  };
  const freezesCatalog = (statement: ts.Statement | undefined): boolean => {
    if (!statement || !ts.isExpressionStatement(statement)) return false;
    const expression = statement.expression;
    return (
      ts.isCallExpression(expression) &&
      expression.arguments.length === 1 &&
      ts.isPropertyAccessExpression(expression.expression) &&
      ts.isIdentifier(expression.expression.expression) &&
      expression.expression.expression.text === "Object" &&
      expression.expression.name.text === "freeze" &&
      ts.isIdentifier(expression.arguments[0]!) &&
      expression.arguments[0]!.text === "migrationEntries"
    );
  };
  const canonicalStatement = (statement: ts.Statement | undefined): string | undefined =>
    statement
      ? ts
          .createPrinter({
            newLine: ts.NewLineKind.LineFeed,
            removeComments: true,
          })
          .printNode(ts.EmitHint.Unspecified, statement, sourceFile)
      : undefined;
  const expectedLoaderSource = ts.createSourceFile(
    "expected-migration-loader.ts",
    `export const makeMigrationLoader = (throughId?: number) =>
      Migrator.fromRecord(
        Object.fromEntries(
          migrationEntries
            .filter(([id]) => throughId === undefined || id <= throughId)
            .map(([id, name, migration]) => [\`\${id}_\${name}\`, migration]),
        ),
      );`,
    ts.ScriptTarget.Latest,
    true,
  );
  const freezesExecutableIdentity =
    declarationIndex >= 0 &&
    freezesEntry(sourceFile.statements[declarationIndex + 1]) &&
    freezesCatalog(sourceFile.statements[declarationIndex + 2]);
  const preservesLoaderMapping =
    declarationIndex >= 0 &&
    canonicalStatement(sourceFile.statements[declarationIndex + 3]) ===
      ts
        .createPrinter({
          newLine: ts.NewLineKind.LineFeed,
          removeComments: true,
        })
        .printNode(
          ts.EmitHint.Unspecified,
          expectedLoaderSource.statements[0]!,
          expectedLoaderSource,
        );
  const runtimeSafetyProblems: string[] = [];
  if (
    migratorImports.length !== 1 ||
    topLevelBindings.filter((name) => name === "Migrator").length !== 1
  ) {
    runtimeSafetyProblems.push(
      `${migrationsSourcePath} must bind Migrator exactly once as the namespace import from ` +
        `effect/unstable/sql/Migrator so the pinned loader cannot be redirected.`,
    );
  }
  if (topLevelBindings.includes("Object")) {
    runtimeSafetyProblems.push(
      `${migrationsSourcePath} must not shadow the global Object binding used by the pinned loader.`,
    );
  }
  if (!freezesExecutableIdentity) {
    runtimeSafetyProblems.push(
      `${migrationsSourcePath} must immediately freeze every migrationEntries tuple and the ` +
        `catalog itself so later runtime statements cannot rewrite executable migration identity.`,
    );
  }
  if (!preservesLoaderMapping) {
    runtimeSafetyProblems.push(
      `${migrationsSourcePath} must build makeMigrationLoader directly from the frozen ` +
        `migrationEntries IDs, names, and imported migration values.`,
    );
  }
  return { entries, importPaths, runtimeSafetyProblems };
}

export function findCurrentStructureViolations(
  catalog: MigrationCatalog,
  migrationModuleNames: readonly string[],
): string[] {
  const problems: string[] = [...(catalog.runtimeSafetyProblems ?? [])];
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

export const gitBlobOid = (contents: string): string => {
  const canonical = canonicalText(contents);
  return createHash("sha1")
    .update(`blob ${Buffer.byteLength(canonical)}\0`)
    .update(canonical)
    .digest("hex");
};

export function releaseTagSetFingerprint(tagCommits: ReadonlyMap<string, string>): string {
  const records = [...tagCommits]
    .toSorted(([left], [right]) => left.localeCompare(right))
    .map(([tag, commit]) => `${tag}\0${commit}\n`)
    .join("");
  return createHash("sha256").update(records).digest("hex");
}

export function findProtectedReleaseTagSetViolations(
  tagCommits: ReadonlyMap<string, string>,
  head: string,
  expectedCount = protectedReleaseTagCount,
  expectedDigest = protectedReleaseTagDigest,
): string[] {
  if (
    tagCommits.size === expectedCount &&
    releaseTagSetFingerprint(tagCommits) === expectedDigest
  ) {
    return [];
  }
  const newHeadTags = [...tagCommits].filter(([, commit]) => commit === head);
  if (newHeadTags.length === 1 && tagCommits.size === expectedCount + 1) {
    const withoutNewHeadTag = new Map(tagCommits);
    withoutNewHeadTag.delete(newHeadTags[0]![0]);
    if (releaseTagSetFingerprint(withoutNewHeadTag) === expectedDigest) return [];
  }
  return [
    `Official release tag manifest changed: expected ${expectedCount} protected tags with digest ` +
      `${expectedDigest}, received ${tagCommits.size} tags with digest ` +
      `${releaseTagSetFingerprint(tagCommits)}. Restore the protected tag/ref history or, after ` +
      `a deliberate successful release, advance the reviewed manifest in a separate change.`,
  ];
}

export function acceptedNewHeadReleaseTag(
  tagCommits: ReadonlyMap<string, string>,
  head: string,
  expectedCount = protectedReleaseTagCount,
  expectedDigest = protectedReleaseTagDigest,
): string | undefined {
  if (
    tagCommits.size === expectedCount &&
    releaseTagSetFingerprint(tagCommits) === expectedDigest
  ) {
    return undefined;
  }
  const newHeadTags = [...tagCommits].filter(([, commit]) => commit === head);
  if (newHeadTags.length !== 1 || tagCommits.size !== expectedCount + 1) return undefined;
  const withoutNewHeadTag = new Map(tagCommits);
  withoutNewHeadTag.delete(newHeadTags[0]![0]);
  return releaseTagSetFingerprint(withoutNewHeadTag) === expectedDigest
    ? newHeadTags[0]![0]
    : undefined;
}

export function selectReleasedDependencyBaselineTag(
  releaseCommitsNewestFirst: readonly string[],
  tagCommits: ReadonlyMap<string, string>,
  newHeadReleaseTag: string | undefined,
): string | undefined {
  const eligibleTagsByCommit = new Map<string, string[]>();
  for (const [tag, commit] of tagCommits) {
    if (tag === newHeadReleaseTag) continue;
    const tags = eligibleTagsByCommit.get(commit) ?? [];
    tags.push(tag);
    eligibleTagsByCommit.set(commit, tags);
  }
  for (const commit of releaseCommitsNewestFirst) {
    const tags = eligibleTagsByCommit.get(commit);
    if (tags !== undefined) return tags.toSorted()[0];
  }
  return undefined;
}

export function findHistoricalReleasedContentViolations(
  tag: string,
  released: readonly MigrationEntry[],
  current: readonly MigrationEntry[],
  releasedContents: ReadonlyMap<string, string>,
  currentContents: ReadonlyMap<string, string>,
  allowances: ReadonlySet<string> = RELEASED_CONTENT_ALLOWANCES,
): string[] {
  const currentById = new Map(current.map((entry) => [entry.id, entry]));
  const problems: string[] = [];
  for (const releasedEntry of released) {
    const currentEntry = currentById.get(releasedEntry.id);
    if (!currentEntry) continue; // Identity validation reports the missing entry.
    const releasedPath = migrationModuleName(releasedEntry.id, releasedEntry.name);
    const currentPath = migrationModuleName(currentEntry.id, currentEntry.name);
    const releasedContent = releasedContents.get(releasedPath);
    const currentContent = currentContents.get(currentPath);
    if (releasedContent === undefined || currentContent === undefined) {
      problems.push(
        `${tag} released migration ${releasedPath} could not be compared with current ${currentPath}.`,
      );
      continue;
    }
    if (canonicalText(releasedContent) === canonicalText(currentContent)) continue;
    const allowanceKey = `${releasedEntry.id}:${gitBlobOid(releasedContent)}:${gitBlobOid(currentContent)}`;
    if (allowances.has(allowanceKey)) continue;
    problems.push(
      `${tag} released migration ${releasedPath} differs from current ${currentPath} without an ` +
        `exact audited content allowance [allowance key: ${allowanceKey}].`,
    );
  }
  return problems;
}

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
  const reportedRuntimeHazards = new Set<string>();
  const reportRuntimeHazard = (hazard: string): void => {
    if (reportedRuntimeHazards.has(hazard)) return;
    reportedRuntimeHazards.add(hazard);
    problems.push(`${path} uses ${hazard}; migration dependencies must be statically resolvable.`);
  };
  const isInsideTypeSyntax = (node: ts.Node): boolean => {
    for (let current = node.parent; current; current = current.parent) {
      if (ts.isTypeNode(current)) return true;
      if (ts.isStatement(current) || ts.isExpression(current)) return false;
    }
    return false;
  };
  const isDeclarationOrPropertyName = (node: ts.Identifier): boolean => {
    const parent = node.parent;
    return (
      (ts.isPropertyAccessExpression(parent) && parent.name === node) ||
      ((ts.isPropertyAssignment(parent) ||
        ts.isMethodDeclaration(parent) ||
        ts.isPropertyDeclaration(parent) ||
        ts.isGetAccessorDeclaration(parent) ||
        ts.isSetAccessorDeclaration(parent)) &&
        parent.name === node) ||
      ((ts.isVariableDeclaration(parent) ||
        ts.isParameter(parent) ||
        ts.isBindingElement(parent) ||
        ts.isFunctionDeclaration(parent) ||
        ts.isFunctionExpression(parent) ||
        ts.isClassDeclaration(parent) ||
        ts.isClassExpression(parent) ||
        ts.isInterfaceDeclaration(parent) ||
        ts.isTypeAliasDeclaration(parent) ||
        ts.isEnumDeclaration(parent) ||
        ts.isModuleDeclaration(parent)) &&
        parent.name === node) ||
      ts.isImportClause(parent) ||
      ts.isImportSpecifier(parent) ||
      ts.isNamespaceImport(parent) ||
      ts.isImportEqualsDeclaration(parent) ||
      ts.isExportSpecifier(parent) ||
      ts.isLabeledStatement(parent) ||
      ts.isBreakStatement(parent) ||
      ts.isContinueStatement(parent)
    );
  };
  const literalElementName = (node: ts.ElementAccessExpression): string | undefined => {
    const argument = node.argumentExpression;
    const staticString = (expression: ts.Expression): string | undefined => {
      if (ts.isStringLiteralLike(expression) || ts.isNumericLiteral(expression)) {
        return expression.text;
      }
      if (
        ts.isBinaryExpression(expression) &&
        expression.operatorToken.kind === ts.SyntaxKind.PlusToken
      ) {
        const left = staticString(expression.left);
        const right = staticString(expression.right);
        return left === undefined || right === undefined ? undefined : left + right;
      }
      return undefined;
    };
    return argument ? staticString(argument) : undefined;
  };
  const accessedPropertyName = (
    node: ts.PropertyAccessExpression | ts.ElementAccessExpression,
  ): string | undefined =>
    ts.isPropertyAccessExpression(node) ? node.name.text : literalElementName(node);
  const isNamedGlobal = (node: ts.Expression, name: string): boolean => {
    if (ts.isIdentifier(node)) return node.text === name;
    if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
      return (
        ts.isIdentifier(node.expression) &&
        (node.expression.text === "globalThis" || node.expression.text === "global") &&
        accessedPropertyName(node) === name
      );
    }
    return false;
  };

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
      if (node.moduleSpecifier.text === "node:module" || node.moduleSpecifier.text === "module") {
        problems.push(
          `${path} imports ${JSON.stringify(node.moduleSpecifier.text)}; migration dependencies ` +
            `must not create indirect runtime module loaders.`,
        );
      }
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
      if (bindings.length > 0) {
        if (node.moduleSpecifier.text === "node:module" || node.moduleSpecifier.text === "module") {
          problems.push(
            `${path} re-exports ${JSON.stringify(node.moduleSpecifier.text)}; migration dependencies ` +
              `must not expose indirect runtime module loaders.`,
          );
        }
        references.push({
          specifier: node.moduleSpecifier.text,
          bindingKey: `export:${bindings.toSorted().join(",")}`,
        });
      }
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      !node.isTypeOnly &&
      ts.isExternalModuleReference(node.moduleReference)
    ) {
      const expression = node.moduleReference.expression;
      if (expression && ts.isStringLiteralLike(expression)) {
        if (expression.text === "node:module" || expression.text === "module") {
          problems.push(
            `${path} imports ${JSON.stringify(expression.text)}; migration dependencies ` +
              `must not create indirect runtime module loaders.`,
          );
        }
        references.push({ specifier: expression.text, bindingKey: "import:*" });
      }
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      reportRuntimeHazard("dynamic import()");
    } else if (
      ts.isIdentifier(node) &&
      !isInsideTypeSyntax(node) &&
      !isDeclarationOrPropertyName(node)
    ) {
      if (node.text === "eval") reportRuntimeHazard("an eval reference");
      if (node.text === "Function") reportRuntimeHazard("a Function constructor reference");
      if (node.text === "require") reportRuntimeHazard("a require reference");
      if (node.text === "globalThis" || node.text === "global") {
        reportRuntimeHazard(`a ${node.text} runtime-global reference`);
      }
      if (node.text === "process") reportRuntimeHazard("a process runtime-global reference");
      if (node.text === "module") reportRuntimeHazard("a module runtime-global reference");
      if (node.text === "fetch") reportRuntimeHazard("a fetch runtime-global reference");
      if (node.text === "Bun") reportRuntimeHazard("a Bun runtime-global reference");
      if (
        ["Worker", "SharedWorker", "WebSocket", "EventSource", "XMLHttpRequest"].includes(node.text)
      ) {
        reportRuntimeHazard(`a ${node.text} runtime loader reference`);
      }
    } else if (
      ts.isPropertyAccessExpression(node) &&
      ts.isIdentifier(node.expression) &&
      (node.expression.text === "globalThis" || node.expression.text === "global") &&
      ["eval", "Function", "require", "process", "module"].includes(node.name.text)
    ) {
      reportRuntimeHazard(`globalThis.${node.name.text}`);
    } else if (
      ts.isElementAccessExpression(node) &&
      ts.isIdentifier(node.expression) &&
      (node.expression.text === "globalThis" || node.expression.text === "global")
    ) {
      const propertyName = literalElementName(node);
      if (
        propertyName !== undefined &&
        ["eval", "Function", "require", "process", "module"].includes(propertyName)
      ) {
        reportRuntimeHazard(`globalThis[${JSON.stringify(propertyName)}]`);
      } else if (propertyName === undefined) {
        reportRuntimeHazard("computed globalThis access");
      }
    } else if (ts.isMetaProperty(node) && node.keywordToken === ts.SyntaxKind.ImportKeyword) {
      reportRuntimeHazard("an import.meta reference");
    } else if (
      (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) &&
      isNamedGlobal(node.expression, "process") &&
      accessedPropertyName(node) === "getBuiltinModule"
    ) {
      reportRuntimeHazard("process.getBuiltinModule");
    } else if (
      (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) &&
      ts.isMetaProperty(node.expression) &&
      node.expression.keywordToken === ts.SyntaxKind.ImportKeyword &&
      accessedPropertyName(node) === "require"
    ) {
      reportRuntimeHazard("import.meta.require");
    } else if (
      (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) &&
      isNamedGlobal(node.expression, "module") &&
      accessedPropertyName(node) === "require"
    ) {
      reportRuntimeHazard("module.require");
    } else if (
      (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) &&
      accessedPropertyName(node) === "constructor"
    ) {
      reportRuntimeHazard("a constructor property reference");
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
  // Conditional export key order can change which runtime entrypoint wins, so
  // preserve the complete root export rather than only its `import` member.
  const packageName = (manifest as Record<string, unknown>).name;
  return `package-root-import:${JSON.stringify({ name: packageName, rootExport })}`;
}

const readJsonObject = (
  source: string,
  path: string,
  allowJsonComments = false,
): Record<string, unknown> => {
  const parsed = allowJsonComments
    ? ts.parseConfigFileTextToJson(path, source)
    : (() => {
        try {
          return { config: JSON.parse(source) as unknown };
        } catch (error) {
          return { error: { messageText: error instanceof Error ? error.message : String(error) } };
        }
      })();
  if (parsed.error) {
    throw new Error(
      `${path} is not valid JSON: ${ts.flattenDiagnosticMessageText(parsed.error.messageText, " ")}`,
    );
  }
  if (!parsed.config || typeof parsed.config !== "object" || Array.isArray(parsed.config)) {
    throw new Error(`${path} must contain an object.`);
  }
  return parsed.config as Record<string, unknown>;
};

const objectField = (
  value: Record<string, unknown>,
  field: string,
  path: string,
): Record<string, unknown> => {
  const nested = value[field];
  if (!nested || typeof nested !== "object" || Array.isArray(nested)) {
    throw new Error(`${path} must contain object field ${JSON.stringify(field)}.`);
  }
  return nested as Record<string, unknown>;
};

const optionalObjectField = (
  value: Record<string, unknown>,
  field: string,
  path: string,
): Record<string, unknown> => {
  const nested = value[field];
  if (nested === undefined) return {};
  if (!nested || typeof nested !== "object" || Array.isArray(nested)) {
    throw new Error(`${path} field ${JSON.stringify(field)} must be an object when present.`);
  }
  return nested as Record<string, unknown>;
};

const relevantRuntimePatches = (patches: Record<string, unknown>): Record<string, string> =>
  Object.fromEntries(
    Object.entries(patches)
      .filter(([packageName]) =>
        ["effect@", "@effect/", "@synara/contracts@"].some((prefix) =>
          packageName.startsWith(prefix),
        ),
      )
      .map(([packageName, patchPath]) => {
        if (typeof patchPath !== "string" || patchPath.length === 0) {
          throw new Error(`Runtime patch ${packageName} must resolve to a non-empty path.`);
        }
        return [packageName, patchPath];
      }),
  );

export function scientRuntimeResolutionFingerprint(readFile: ReadRepositoryFile): string {
  const required = [
    "package.json",
    "apps/server/package.json",
    "packages/contracts/package.json",
    "bun.lock",
  ] as const;
  const sources = new Map(required.map((path) => [path, readFile(path)]));
  for (const path of required) {
    if (sources.get(path) === undefined) {
      throw new Error(`Migration runtime resolution evidence ${path} could not be read.`);
    }
  }
  const root = readJsonObject(sources.get("package.json")!, "package.json");
  const server = readJsonObject(
    sources.get("apps/server/package.json")!,
    "apps/server/package.json",
  );
  const contracts = readJsonObject(
    sources.get("packages/contracts/package.json")!,
    "packages/contracts/package.json",
  );
  const lock = readJsonObject(sources.get("bun.lock")!, "bun.lock", true);
  const rootWorkspaces = objectField(root, "workspaces", "package.json");
  const rootCatalog = objectField(rootWorkspaces, "catalog", "package.json#workspaces");
  const serverDependencies = objectField(server, "dependencies", "apps/server/package.json");
  const serverDevDependencies = objectField(server, "devDependencies", "apps/server/package.json");
  const contractsDependencies = objectField(
    contracts,
    "dependencies",
    "packages/contracts/package.json",
  );
  const lockWorkspaces = objectField(lock, "workspaces", "bun.lock");
  const lockServer = objectField(lockWorkspaces, "apps/server", "bun.lock#workspaces");
  const lockContracts = objectField(lockWorkspaces, "packages/contracts", "bun.lock#workspaces");
  const lockPackages = objectField(lock, "packages", "bun.lock");
  const rootRuntimePatches = relevantRuntimePatches(
    optionalObjectField(root, "patchedDependencies", "package.json"),
  );
  const lockRuntimePatches = relevantRuntimePatches(
    optionalObjectField(lock, "patchedDependencies", "bun.lock"),
  );
  const patchPaths = new Set([
    ...Object.values(rootRuntimePatches),
    ...Object.values(lockRuntimePatches),
  ]);
  const patchContents = Object.fromEntries(
    [...patchPaths].toSorted().map((patchPath) => {
      const contents = readFile(patchPath);
      if (contents === undefined) {
        throw new Error(`Migration runtime patch ${patchPath} could not be read.`);
      }
      return [patchPath, canonicalText(contents)];
    }),
  );

  return JSON.stringify({
    workspacePackages: rootWorkspaces.packages,
    effectCatalog: rootCatalog.effect,
    serverEffect: objectField(lockServer, "dependencies", "bun.lock#apps/server").effect,
    serverManifestEffect: serverDependencies.effect,
    serverContracts: serverDevDependencies["@synara/contracts"],
    lockServerContracts: objectField(lockServer, "devDependencies", "bun.lock#apps/server")[
      "@synara/contracts"
    ],
    contractsName: contracts.name,
    contractsEffect: contractsDependencies.effect,
    lockContractsName: lockContracts.name,
    lockContractsEffect: objectField(lockContracts, "dependencies", "bun.lock#packages/contracts")
      .effect,
    lockContractsPackage: lockPackages["@synara/contracts"],
    lockEffectPackage: lockPackages.effect,
    rootRuntimePatches,
    lockRuntimePatches,
    patchContents,
  });
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

function canonicalRuntimeModuleSource(source: string, path: string): string {
  const sourceFile = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
  const printer = ts.createPrinter({
    newLine: ts.NewLineKind.LineFeed,
    removeComments: true,
  });
  const runtimeStatements = sourceFile.statements.flatMap((statement): ts.Statement[] => {
    const modifiers = ts.canHaveModifiers(statement) ? ts.getModifiers(statement) : undefined;
    if (modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.DeclareKeyword)) return [];
    if (ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement)) return [];
    if (ts.isImportEqualsDeclaration(statement) && statement.isTypeOnly) return [];
    if (ts.isImportDeclaration(statement)) {
      if (statement.importClause?.isTypeOnly) return [];
      const bindings = statement.importClause?.namedBindings;
      if (bindings && ts.isNamedImports(bindings)) {
        const runtimeElements = bindings.elements.filter((element) => !element.isTypeOnly);
        if (!statement.importClause?.name && runtimeElements.length === 0) return [];
        const importClause = ts.factory.updateImportClause(
          statement.importClause!,
          false,
          statement.importClause?.name,
          ts.factory.updateNamedImports(bindings, runtimeElements),
        );
        return [
          ts.factory.updateImportDeclaration(
            statement,
            statement.modifiers,
            importClause,
            statement.moduleSpecifier,
            statement.attributes,
          ),
        ];
      }
    }
    if (ts.isExportDeclaration(statement)) {
      if (statement.isTypeOnly) return [];
      if (statement.exportClause && ts.isNamedExports(statement.exportClause)) {
        const runtimeElements = statement.exportClause.elements.filter(
          (element) => !element.isTypeOnly,
        );
        if (runtimeElements.length === 0) return [];
        return [
          ts.factory.updateExportDeclaration(
            statement,
            statement.modifiers,
            false,
            ts.factory.updateNamedExports(statement.exportClause, runtimeElements),
            statement.moduleSpecifier,
            statement.attributes,
          ),
        ];
      }
    }
    return [statement];
  });
  return runtimeStatements
    .map((statement) => printer.printNode(ts.EmitHint.Unspecified, statement, sourceFile))
    .join("\n");
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
      for (const element of statement.exportClause.elements) {
        if (element.isTypeOnly || element.name.text !== exportName) continue;
        const sourceBinding = element.propertyName?.text ?? element.name.text;
        const resolved = resolveLocalDependency(
          path,
          { specifier, bindingKey: `export:${sourceBinding}` },
          readFile,
          new Map(),
        );
        const targetPath = resolved.dependencies?.[0]?.path;
        const targetSource = targetPath ? readFile(targetPath) : undefined;
        if (resolved.problem) throw new Error(resolved.problem);
        if (
          !targetPath ||
          !targetSource ||
          !declaresRuntimeExport(targetSource, targetPath, sourceBinding)
        ) {
          throw new Error(
            `${path} export ${exportName} from ${JSON.stringify(specifier)} ` +
              `does not resolve runtime source binding ${sourceBinding}.`,
          );
        }
        sources.push(`${sourceBinding}:${targetPath}`);
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
      sources.push(`${exportName}:${targetPath}`);
    }
  }
  if (sources.length === 0) {
    throw new Error(`${path} does not resolve runtime export ${exportName}.`);
  }
  // Freeze runtime statements without making comments, formatting, or separate
  // type-only declarations part of the released migration contract.
  return (
    `named-barrel-export:${exportName}:${sources.toSorted().join(",")}:` +
    canonicalRuntimeModuleSource(source, path)
  );
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
          dependencies.push({
            path: evidence.path,
            traverse: evidence.kind === "named-barrel-export",
            content,
            ...(evidence.kind === "named-barrel-export" ? { traversalSource: source } : {}),
          });
        } catch (error) {
          return {
            problem: error instanceof Error ? error.message : String(error),
          };
        }
      }
      dependencies.push({
        path: pinnedWorkspaceImport.runtimeSourcePath,
        traverse: true,
      });
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
    if (specifier === "effect" || specifier.startsWith("effect/")) return {};
    return {
      problem:
        `${importerPath} imports unreviewed external runtime ${JSON.stringify(specifier)}; ` +
        `released migration dependencies must be statically bounded.`,
    };
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
  const pending: ResolvedDependency[] = entryPaths.map((path) => ({
    path,
    traverse: true,
  }));
  const traversed = new Set<string>();

  while (pending.length > 0) {
    const dependency = pending.pop()!;
    const { path } = dependency;
    const fileSource = readFile(path);
    const content = dependency.content ?? fileSource;
    if (content === undefined) {
      problems.push(`Migration dependency ${path} could not be read.`);
      continue;
    }
    contents.set(path, content);
    if (
      !dependency.traverse ||
      traversed.has(path) ||
      !sourceModuleExtensions.has(posix.extname(path))
    ) {
      continue;
    }
    traversed.add(path);

    const traversalSource = dependency.traversalSource ?? fileSource ?? content;
    const parsed = collectStaticModuleSpecifiers(traversalSource, path);
    problems.push(...parsed.problems);
    for (const reference of parsed.references) {
      const resolved = resolveLocalDependency(path, reference, readFile, pinnedWorkspaceImports);
      if (resolved.problem) problems.push(resolved.problem);
      if (resolved.dependencies) pending.push(...resolved.dependencies);
    }
  }

  return { contents, problems };
}

export function buildScientMigrationDependencyClosure(
  entryPaths: readonly string[],
  sourceReader: ReadRepositoryFile,
  pinnedWorkspaceImports: PinnedWorkspaceImports,
): LocalDependencyClosure {
  const closure = buildLocalDependencyClosure(entryPaths, sourceReader, pinnedWorkspaceImports);
  const contents = new Map(closure.contents);
  const problems = [...closure.problems];
  try {
    contents.set(runtimeResolutionEvidencePath, scientRuntimeResolutionFingerprint(sourceReader));
  } catch (error) {
    problems.push(error instanceof Error ? error.message : String(error));
  }
  return { contents, problems };
}

export function findReleasedDependencyViolations(
  releasedContents: ReadonlyMap<string, string>,
  currentContents: ReadonlyMap<string, string>,
  migrationModulePaths: ReadonlySet<string> = new Set(),
  allowances: ReadonlySet<string> = RELEASED_DEPENDENCY_GRAPH_ALLOWANCES,
): string[] {
  const problems: string[] = [];
  for (const [path, releasedContent] of releasedContents) {
    if (migrationModulePaths.has(path)) continue;
    const currentContent = currentContents.get(path);
    if (currentContent === undefined) {
      const allowanceKey = `removed:${path}:${gitBlobOid(releasedContent)}`;
      if (allowances.has(allowanceKey)) continue;
      problems.push(
        `Released migration dependency ${path} was deleted or is no longer reachable ` +
          `without an exact audited graph allowance [allowance key: ${allowanceKey}].`,
      );
    } else if (canonicalText(currentContent) !== canonicalText(releasedContent)) {
      // A dependency that remains reachable but changed content is never blessed by
      // the one-time decoupling allowance; that is a genuine frozen-content violation.
      problems.push(`Released migration dependency ${path} was modified.`);
    }
  }
  for (const [path, currentContent] of currentContents) {
    if (migrationModulePaths.has(path) || releasedContents.has(path)) continue;
    const allowanceKey = `added:${path}:${gitBlobOid(currentContent)}`;
    if (allowances.has(allowanceKey)) continue;
    problems.push(
      `Released migration dependency closure gained ${path} ` +
        `without an exact audited graph allowance [allowance key: ${allowanceKey}].`,
    );
  }
  return problems.toSorted();
}

export function findReleasedContentViolations(
  released: readonly MigrationEntry[],
  currentContents: ReadonlyMap<string, string>,
  releasedContents: ReadonlyMap<string, string>,
  allowances: ReadonlySet<string> = RELEASED_CONTENT_ALLOWANCES,
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
    if (canonicalText(currentContent) === canonicalText(releasedContent)) continue;
    const allowanceKey = `${entry.id}:${gitBlobOid(releasedContent)}:${gitBlobOid(currentContent)}`;
    if (allowances.has(allowanceKey)) continue;
    problems.push(
      `Released migration ${path} was modified without an exact audited content ` +
        `allowance [allowance key: ${allowanceKey}].`,
    );
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

  const head = git(["rev-parse", "HEAD"]).stdout.trim();
  const tagCommits = new Map(
    tags.map((tag) => [tag, git(["rev-list", "-n", "1", tag]).stdout.trim()] as const),
  );
  const tagManifestProblems = findProtectedReleaseTagSetViolations(tagCommits, head);
  if (tagManifestProblems.length > 0) {
    fail(tagManifestProblems);
    return;
  }
  const newHeadReleaseTag = acceptedNewHeadReleaseTag(tagCommits, head);
  const releaseCommits = git(["rev-list", "--first-parent", releaseRef])
    .stdout.split("\n")
    .map((commit) => commit.trim())
    .filter(Boolean);
  const dependencyBaselineTag = selectReleasedDependencyBaselineTag(
    releaseCommits,
    tagCommits,
    newHeadReleaseTag,
  );

  const identityProblems: string[] = [];
  const historicalContentProblems: string[] = [];
  const currentHistoricalContents = new Map<string, string>();
  for (const entry of currentCatalog.entries) {
    const moduleName = migrationModuleName(entry.id, entry.name);
    try {
      currentHistoricalContents.set(
        moduleName,
        readFileSync(resolve(repoRoot, migrationsDirectoryPath, moduleName), "utf8"),
      );
    } catch {
      // Per-tag content validation reports the missing current migration.
    }
  }
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
    // A newly accepted tag at HEAD cannot prove its own history was append-only,
    // so compare it with the previous protected release. An already-manifested
    // tag at HEAD is itself authoritative and remains the dependency baseline.
    if (contentBaseline === undefined && tag === dependencyBaselineTag) {
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
    const tagContents = new Map<string, string>();
    for (const entry of releasedCatalog.entries) {
      const moduleName = migrationModuleName(entry.id, entry.name);
      const content = showFile(tag, `${migrationsDirectoryPath}/${moduleName}`);
      if (content !== undefined) tagContents.set(moduleName, content);
    }
    historicalContentProblems.push(
      ...findHistoricalReleasedContentViolations(
        tag,
        releasedCatalog.entries,
        currentCatalog.entries,
        tagContents,
        currentHistoricalContents,
      ),
    );
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
          {
            kind: "package-root-import",
            path: "packages/contracts/package.json",
          },
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
  const releasedClosure = buildScientMigrationDependencyClosure(
    [...migrationModulePaths],
    (path) => showFile(contentBaseline.tag, path),
    pinnedWorkspaceImports,
  );
  const currentReleasedClosure = buildScientMigrationDependencyClosure(
    [...migrationModulePaths],
    readCurrentFile,
    pinnedWorkspaceImports,
  );
  const currentMigrationModulePaths = currentCatalog.entries.map(
    (entry) => `${migrationsDirectoryPath}/${migrationModuleName(entry.id, entry.name)}`,
  );
  const currentSafetyClosure = buildScientMigrationDependencyClosure(
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
  const problems = [
    ...identityProblems,
    ...historicalContentProblems,
    ...contentProblems,
    ...dependencyProblems,
  ];
  if (problems.length > 0) {
    fail(problems);
    return;
  }

  console.log(
    `Scient migration lineage passed: ${currentCatalog.entries.length} contiguous migrations; ` +
      `${checkedTags} protected official release tags checked; all historical migration code and ` +
      `the latest shipped dependency resolution ` +
      `match ${contentBaseline.tag}.`,
  );
}

if (import.meta.main) main();
