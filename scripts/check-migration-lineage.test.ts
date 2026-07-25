import { assert, describe, it } from "@effect/vitest";

import {
  acceptedNewHeadReleaseTag,
  buildLocalDependencyClosure,
  buildScientMigrationDependencyClosure,
  findCurrentStructureViolations,
  findHistoricalReleasedContentViolations,
  findProtectedReleaseTagSetViolations,
  findReleasedDependencyViolations,
  findReleasedContentViolations,
  findReleasedIdentityViolations,
  gitBlobOid,
  parseMigrationCatalog,
  pinnedWorkspaceImportKey,
  releaseTagSetFingerprint,
  selectReleasedDependencyBaselineTag,
  type PinnedWorkspaceImport,
} from "./check-migration-lineage.ts";

const sourceFor = (entries: ReadonlyArray<readonly [number, string]>) => {
  const imports = entries
    .map(
      ([id, name]) =>
        `import Migration${String(id).padStart(4, "0")} from "./Migrations/${String(id).padStart(3, "0")}_${name}.ts";`,
    )
    .join("\n");
  const rows = entries
    .map(([id, name]) => `  [${id}, "${name}", Migration${String(id).padStart(4, "0")}],`)
    .join("\n");
  return (
    `import * as Migrator from "effect/unstable/sql/Migrator";\n` +
    `${imports}\nexport const migrationEntries = [\n${rows}\n] as const;\n` +
    `for (const migrationEntry of migrationEntries) { Object.freeze(migrationEntry); }\n` +
    `Object.freeze(migrationEntries);\n` +
    `export const makeMigrationLoader = (throughId?: number) =>\n` +
    `  Migrator.fromRecord(Object.fromEntries(migrationEntries\n` +
    `    .filter(([id]) => throughId === undefined || id <= throughId)\n` +
    `    .map(([id, name, migration]) => [\`\${id}_\${name}\`, migration])));\n`
  );
};

const catalogFor = (entries: ReadonlyArray<readonly [number, string]>) =>
  parseMigrationCatalog(sourceFor(entries));

describe("Scient migration lineage guard", () => {
  it("accepts Scient's contiguous entry, import, and module convention", () => {
    const catalog = catalogFor([
      [1, "CreateProjects"],
      [2, "AddThreadState"],
    ]);

    assert.deepEqual(
      findCurrentStructureViolations(catalog, [
        "001_CreateProjects.ts",
        "002_AddThreadState.ts",
        "002_AddThreadState.test.ts",
        "schemaHelpers.ts",
      ]),
      [],
    );
  });

  it("rejects every migration catalog element that is not an exact static tuple", () => {
    const valid = sourceFor([[1, "CreateProjects"]]);
    const hiddenReference = valid.replace("\n] as const;", "\n  HiddenMigration,\n] as const;");
    const hiddenSpread = valid.replace("\n] as const;", "\n  ...extraMigrations,\n] as const;");
    const computedName = valid.replace('"CreateProjects"', "`CreateProjects`");

    assert.throws(() => parseMigrationCatalog(hiddenReference), /element 2.*exact/u);
    assert.throws(() => parseMigrationCatalog(hiddenSpread), /element 2.*exact/u);
    assert.throws(() => parseMigrationCatalog(computedName), /element 1.*exact/u);
  });

  it("requires the executable migration registry and every tuple to be frozen", () => {
    const source = sourceFor([[1, "CreateProjects"]]);
    const unfrozen = source.replace(
      /for \(const migrationEntry[\s\S]*Object\.freeze\(migrationEntries\);\n/u,
      "",
    );
    const catalog = parseMigrationCatalog(unfrozen);

    assert.isTrue(
      findCurrentStructureViolations(catalog, ["001_CreateProjects.ts"]).some((problem) =>
        problem.includes("must immediately freeze"),
      ),
    );
  });

  it("rejects changes to the executable migration loader mapping", () => {
    const source = sourceFor([[1, "CreateProjects"]]).replace(
      "[`${id}_${name}`, migration]",
      "[`rewritten_${name}`, migration]",
    );
    const catalog = parseMigrationCatalog(source);

    assert.isTrue(
      findCurrentStructureViolations(catalog, ["001_CreateProjects.ts"]).some((problem) =>
        problem.includes("must build makeMigrationLoader directly"),
      ),
    );
  });

  it("pins the loader's Migrator import and global Object binding", () => {
    const valid = sourceFor([[1, "CreateProjects"]]);
    const redirectedMigrator = valid.replace(
      'import * as Migrator from "effect/unstable/sql/Migrator";',
      'import * as Migrator from "./WrappedMigrator.ts";',
    );
    const shadowedObject = `${valid}\nconst Object = { fromEntries: () => ({}) };\n`;

    assert.isTrue(
      findCurrentStructureViolations(parseMigrationCatalog(redirectedMigrator), [
        "001_CreateProjects.ts",
      ]).some((problem) => problem.includes("must bind Migrator exactly once")),
    );
    assert.isTrue(
      findCurrentStructureViolations(parseMigrationCatalog(shadowedObject), [
        "001_CreateProjects.ts",
      ]).some((problem) => problem.includes("must not shadow the global Object")),
    );
  });

  it("binds every catalog tuple to a real default import instead of comments or aliases", () => {
    const source = [
      '/* import Migration0001 from "./Migrations/001_CreateProjects.ts"; */',
      'import Migration0002 from "./Migrations/002_AddThreadState.ts";',
      "const Migration0001 = Migration0002;",
      "export const migrationEntries = [",
      '  [1, "CreateProjects", Migration0001],',
      '  [2, "AddThreadState", Migration0002],',
      "] as const;",
    ].join("\n");
    const catalog = parseMigrationCatalog(source);

    assert.isTrue(
      findCurrentStructureViolations(catalog, [
        "001_CreateProjects.ts",
        "002_AddThreadState.ts",
      ]).some((problem) => problem.includes("Migration 1 must import")),
    );
  });

  it("fails fixtures with gaps, duplicate IDs, duplicate names, or orphaned modules", () => {
    const catalog = {
      entries: [
        { id: 1, name: "CreateProjects", importName: "Migration0001" },
        { id: 1, name: "AddThreadState", importName: "Migration0001" },
        { id: 3, name: "CreateProjects", importName: "Migration0003" },
      ],
      importPaths: new Map([
        ["Migration0001", "./Migrations/001_CreateProjects.ts"],
        ["Migration0003", "./Migrations/003_CreateProjects.ts"],
      ]),
    };
    const problems = findCurrentStructureViolations(catalog, [
      "001_CreateProjects.ts",
      "002_OrphanedMigration.ts",
      "004_Invalid-Name.ts",
    ]);

    assert.isTrue(problems.some((problem) => problem.includes("duplicated")));
    assert.isTrue(problems.some((problem) => problem.includes("contiguous ID 2")));
    assert.isTrue(problems.some((problem) => problem.includes('name "CreateProjects"')));
    assert.isTrue(problems.some((problem) => problem.includes("has no matching")));
    assert.isTrue(problems.some((problem) => problem.includes("004_Invalid-Name.ts")));
  });

  it("fails fixtures that rename, renumber, or delete released identities", () => {
    const released = catalogFor([
      [1, "CreateProjects"],
      [2, "AddThreadState"],
    ]).entries;

    assert.deepEqual(
      findReleasedIdentityViolations(
        released,
        catalogFor([
          [1, "CreateProjectsV2"],
          [3, "AddThreadState"],
        ]).entries,
        [],
      ),
      [
        {
          id: 1,
          releasedName: "CreateProjects",
          currentName: "CreateProjectsV2",
        },
        { id: 2, releasedName: "AddThreadState", currentName: null },
      ],
    );
  });

  it("allows only Scient's exact, already-repaired migration 32 rename", () => {
    const released = [
      {
        id: 32,
        name: "ReconcileLegacyT3SchemaImport",
        importName: "Migration0032",
      },
    ];
    const current = [
      {
        id: 32,
        name: "ReconcileImportedSchemaLineage",
        importName: "Migration0032",
      },
    ];

    assert.deepEqual(findReleasedIdentityViolations(released, current), []);
    assert.lengthOf(
      findReleasedIdentityViolations(released, [
        { id: 32, name: "AnotherRename", importName: "Migration0032" },
      ]),
      1,
    );
  });

  it("fails fixtures that modify or delete the latest shipped migration content", () => {
    const released = catalogFor([
      [1, "CreateProjects"],
      [2, "AddThreadState"],
    ]).entries;
    const releasedContents = new Map([
      ["001_CreateProjects.ts", "export default 'one';\n"],
      ["002_AddThreadState.ts", "export default 'two';\n"],
    ]);
    const currentContents = new Map([["001_CreateProjects.ts", "export default 'changed';\n"]]);

    assert.deepEqual(findReleasedContentViolations(released, currentContents, releasedContents), [
      "Released migration 001_CreateProjects.ts was modified.",
      "Released migration 002_AddThreadState.ts was deleted.",
    ]);
  });

  it("does not let the protected official tag manifest shrink or accept a stray old tag", () => {
    const protectedTags = new Map([
      ["v1.0.0", "a"],
      ["v1.1.0", "b"],
    ]);
    const digest = releaseTagSetFingerprint(protectedTags);

    assert.deepEqual(findProtectedReleaseTagSetViolations(protectedTags, "head", 2, digest), []);
    assert.isUndefined(acceptedNewHeadReleaseTag(protectedTags, "b", 2, digest));
    assert.equal(
      selectReleasedDependencyBaselineTag(["b", "a"], protectedTags, undefined),
      "v1.1.0",
    );
    assert.lengthOf(
      findProtectedReleaseTagSetViolations(new Map([["v1.0.0", "a"]]), "head", 2, digest),
      1,
    );
    assert.lengthOf(
      findProtectedReleaseTagSetViolations(
        new Map([...protectedTags, ["v9.0.0", "old"]]),
        "head",
        2,
        digest,
      ),
      1,
    );
    assert.deepEqual(
      findProtectedReleaseTagSetViolations(
        new Map([...protectedTags, ["v1.2.0", "head"]]),
        "head",
        2,
        digest,
      ),
      [],
    );
    assert.equal(
      acceptedNewHeadReleaseTag(new Map([...protectedTags, ["v1.2.0", "head"]]), "head", 2, digest),
      "v1.2.0",
    );
    assert.equal(
      selectReleasedDependencyBaselineTag(
        ["head", "b", "a"],
        new Map([...protectedTags, ["v1.2.0", "head"]]),
        "v1.2.0",
      ),
      "v1.1.0",
    );
  });

  it("selects the latest released dependency baseline by release ancestry, not version", () => {
    const tags = new Map([
      ["v1.0.0", "old"],
      ["v2.0.0", "middle"],
      ["v1.1.0", "latest"],
    ]);

    assert.equal(
      selectReleasedDependencyBaselineTag(["latest", "middle", "old"], tags, undefined),
      "v1.1.0",
    );
    assert.equal(
      selectReleasedDependencyBaselineTag(
        ["new-head", "latest", "middle", "old"],
        new Map([...tags, ["v0.9.0", "new-head"]]),
        "v0.9.0",
      ),
      "v1.1.0",
    );
  });

  it("audits every historical released migration against exact content allowances", () => {
    const released = [{ id: 1, name: "CreateProjects", importName: "Migration0001" }];
    const current = [{ id: 1, name: "CreateProjects", importName: "Migration0001" }];
    const releasedContents = new Map([["001_CreateProjects.ts", "released\n"]]);
    const currentContents = new Map([["001_CreateProjects.ts", "current\n"]]);
    const allowance = new Set([`1:${gitBlobOid("released\n")}:${gitBlobOid("current\n")}`]);

    assert.lengthOf(
      findHistoricalReleasedContentViolations(
        "v1.0.0",
        released,
        current,
        releasedContents,
        currentContents,
        new Set(),
      ),
      1,
    );
    assert.deepEqual(
      findHistoricalReleasedContentViolations(
        "v1.0.0",
        released,
        current,
        releasedContents,
        currentContents,
        allowance,
      ),
      [],
    );
    assert.lengthOf(
      findHistoricalReleasedContentViolations(
        "v1.0.0",
        released,
        current,
        releasedContents,
        new Map([["001_CreateProjects.ts", "another current\n"]]),
        allowance,
      ),
      1,
    );
  });

  it("normalizes checkout line endings without weakening content comparison", () => {
    const released = catalogFor([[1, "CreateProjects"]]).entries;
    assert.deepEqual(
      findReleasedContentViolations(
        released,
        new Map([["001_CreateProjects.ts", "line one\r\nline two\r\n"]]),
        new Map([["001_CreateProjects.ts", "line one\nline two\n"]]),
      ),
      [],
    );
  });

  it("freezes repository-local transitive dependencies of released migrations", () => {
    const releasedFiles = new Map([
      [
        "apps/server/src/persistence/Migrations/035_Normalize.ts",
        [
          'import { helper } from "./schemaHelpers.ts";',
          'import { normalize } from "../modelSelectionCompatibility.ts";',
        ].join("\n"),
      ],
      [
        "apps/server/src/persistence/Migrations/schemaHelpers.ts",
        "export const helper = 'released';\n",
      ],
      [
        "apps/server/src/persistence/modelSelectionCompatibility.ts",
        'import { MODEL_OPTIONS_BY_PROVIDER } from "@synara/contracts";\nexport const normalize = MODEL_OPTIONS_BY_PROVIDER;\n',
      ],
      ["packages/contracts/package.json", '{"exports":{".":{"import":"./src/index.ts"}}}\n'],
      ["packages/contracts/src/index.ts", 'export * from "./model.ts";\n'],
      ["packages/contracts/src/model.ts", "export const MODEL_OPTIONS_BY_PROVIDER = 'released';\n"],
    ]);
    const currentFiles = new Map(releasedFiles);
    currentFiles.set(
      "apps/server/src/persistence/Migrations/schemaHelpers.ts",
      'export const helper = "changed";\n',
    );
    currentFiles.set(
      "packages/contracts/src/model.ts",
      "export const MODEL_OPTIONS_BY_PROVIDER = 'changed';\n",
    );
    const localPackages = new Map<string, PinnedWorkspaceImport>([
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

    const released = buildLocalDependencyClosure(
      ["apps/server/src/persistence/Migrations/035_Normalize.ts"],
      (path) => releasedFiles.get(path),
      localPackages,
    );
    const current = buildLocalDependencyClosure(
      ["apps/server/src/persistence/Migrations/035_Normalize.ts"],
      (path) => currentFiles.get(path),
      localPackages,
    );

    assert.deepEqual(released.problems, []);
    assert.deepEqual(current.problems, []);
    assert.deepEqual(
      findReleasedDependencyViolations(
        released.contents,
        current.contents,
        new Set(["apps/server/src/persistence/Migrations/035_Normalize.ts"]),
      ),
      [
        "Released migration dependency apps/server/src/persistence/Migrations/schemaHelpers.ts was modified.",
        "Released migration dependency packages/contracts/src/model.ts was modified.",
      ],
    );
  });

  it("pins workspace imports to the exact importer and runtime bindings", () => {
    const files = new Map([
      [
        "persistence/modelSelectionCompatibility.ts",
        'import { OTHER_EXPORT } from "@synara/contracts";\n',
      ],
      [
        "persistence/anotherCompatibility.ts",
        'import { MODEL_OPTIONS_BY_PROVIDER } from "@synara/contracts";\n',
      ],
      ["contracts/package.json", "{}\n"],
      ["contracts/index.ts", 'export * from "./model.ts";\n'],
      ["contracts/model.ts", "export {};\n"],
    ]);
    const pins = new Map<string, PinnedWorkspaceImport>([
      [
        pinnedWorkspaceImportKey(
          "persistence/modelSelectionCompatibility.ts",
          "@synara/contracts",
          "import:MODEL_OPTIONS_BY_PROVIDER",
        ),
        {
          resolutionEvidence: [
            { kind: "package-root-import", path: "contracts/package.json" },
            {
              kind: "named-barrel-export",
              path: "contracts/index.ts",
              exportName: "MODEL_OPTIONS_BY_PROVIDER",
            },
          ],
          runtimeSourcePath: "contracts/model.ts",
        },
      ],
    ]);

    const wrongBinding = buildLocalDependencyClosure(
      ["persistence/modelSelectionCompatibility.ts"],
      (path) => files.get(path),
      pins,
    );
    const wrongImporter = buildLocalDependencyClosure(
      ["persistence/anotherCompatibility.ts"],
      (path) => files.get(path),
      pins,
    );

    assert.isTrue(
      wrongBinding.problems.some((problem) =>
        problem.includes("import:OTHER_EXPORT) has no exact pinned"),
      ),
    );
    assert.isTrue(
      wrongImporter.problems.some((problem) =>
        problem.includes("import:MODEL_OPTIONS_BY_PROVIDER) has no exact pinned"),
      ),
    );
  });

  it("pins the actual workspace and Effect catalog/lock resolution chain", () => {
    const releasedFiles = new Map([
      ["migration.ts", 'import { Effect } from "effect";\n'],
      [
        "package.json",
        JSON.stringify({
          workspaces: {
            packages: ["apps/*", "packages/*"],
            catalog: { effect: "effect-reviewed" },
          },
        }),
      ],
      [
        "apps/server/package.json",
        JSON.stringify({
          dependencies: { effect: "catalog:" },
          devDependencies: { "@synara/contracts": "workspace:*" },
        }),
      ],
      [
        "packages/contracts/package.json",
        JSON.stringify({
          name: "@synara/contracts",
          dependencies: { effect: "catalog:" },
          exports: { ".": { import: "./src/index.ts" } },
        }),
      ],
      [
        "bun.lock",
        JSON.stringify({
          workspaces: {
            "apps/server": {
              dependencies: { effect: "catalog:" },
              devDependencies: { "@synara/contracts": "workspace:*" },
            },
            "packages/contracts": {
              name: "@synara/contracts",
              dependencies: { effect: "catalog:" },
            },
          },
          packages: {
            "@synara/contracts": ["@synara/contracts@workspace:packages/contracts"],
            effect: ["effect@effect-reviewed"],
          },
        }),
      ],
    ]);
    const released = buildScientMigrationDependencyClosure(
      ["migration.ts"],
      (path) => releasedFiles.get(path),
      new Map(),
    );
    assert.deepEqual(released.problems, []);

    const mutations = [
      ["package.json", releasedFiles.get("package.json")!.replace("effect-reviewed", "effect-new")],
      [
        "packages/contracts/package.json",
        releasedFiles
          .get("packages/contracts/package.json")!
          .replace("@synara/contracts", "@synara/redirected"),
      ],
      [
        "bun.lock",
        releasedFiles
          .get("bun.lock")!
          .replace("workspace:packages/contracts", "workspace:packages/replacement"),
      ],
      [
        "bun.lock",
        releasedFiles.get("bun.lock")!.replace("effect@effect-reviewed", "effect@effect-new"),
      ],
    ] as const;

    for (const [path, contents] of mutations) {
      const currentFiles = new Map(releasedFiles);
      currentFiles.set(path, contents);
      const current = buildScientMigrationDependencyClosure(
        ["migration.ts"],
        (candidate) => currentFiles.get(candidate),
        new Map(),
      );
      assert.deepEqual(current.problems, []);
      assert.deepEqual(findReleasedDependencyViolations(released.contents, current.contents), [
        "Released migration dependency @scient/migration-runtime-resolution was modified.",
      ]);
    }

    const patchedFiles = new Map(releasedFiles);
    const root = JSON.parse(patchedFiles.get("package.json")!) as Record<string, unknown>;
    root.patchedDependencies = { "effect@effect-reviewed": "patches/effect.patch" };
    patchedFiles.set("package.json", JSON.stringify(root));
    const lock = JSON.parse(patchedFiles.get("bun.lock")!) as Record<string, unknown>;
    lock.patchedDependencies = { "effect@effect-reviewed": "patches/effect.patch" };
    patchedFiles.set("bun.lock", JSON.stringify(lock));
    patchedFiles.set("patches/effect.patch", "reviewed patch bytes\n");
    const patched = buildScientMigrationDependencyClosure(
      ["migration.ts"],
      (candidate) => patchedFiles.get(candidate),
      new Map(),
    );
    assert.deepEqual(patched.problems, []);
    assert.deepEqual(findReleasedDependencyViolations(released.contents, patched.contents), [
      "Released migration dependency @scient/migration-runtime-resolution was modified.",
    ]);
  });

  it("freezes the package manifest and barrel that resolve a pinned workspace import", () => {
    const releasedFiles = new Map([
      [
        "persistence/modelSelectionCompatibility.ts",
        'import { MODEL_OPTIONS_BY_PROVIDER } from "@synara/contracts";\n',
      ],
      ["contracts/package.json", '{"exports":{".":{"import":"./index.ts"}}}\n'],
      ["contracts/index.ts", 'export { MODEL_OPTIONS_BY_PROVIDER } from "./model.ts";\n'],
      ["contracts/model.ts", "export const MODEL_OPTIONS_BY_PROVIDER = {};\n"],
    ]);
    const currentFiles = new Map(releasedFiles);
    currentFiles.set("contracts/package.json", '{"exports":{".":{"import":"./redirect.ts"}}}\n');
    currentFiles.set(
      "contracts/index.ts",
      'export { MODEL_OPTIONS_BY_PROVIDER } from "./redirect.ts";\n',
    );
    currentFiles.set("contracts/redirect.ts", "export const MODEL_OPTIONS_BY_PROVIDER = {};\n");
    const pins = new Map<string, PinnedWorkspaceImport>([
      [
        pinnedWorkspaceImportKey(
          "persistence/modelSelectionCompatibility.ts",
          "@synara/contracts",
          "import:MODEL_OPTIONS_BY_PROVIDER",
        ),
        {
          resolutionEvidence: [
            { kind: "package-root-import", path: "contracts/package.json" },
            {
              kind: "named-barrel-export",
              path: "contracts/index.ts",
              exportName: "MODEL_OPTIONS_BY_PROVIDER",
            },
          ],
          runtimeSourcePath: "contracts/model.ts",
        },
      ],
    ]);
    const released = buildLocalDependencyClosure(
      ["persistence/modelSelectionCompatibility.ts"],
      (path) => releasedFiles.get(path),
      pins,
    );
    const current = buildLocalDependencyClosure(
      ["persistence/modelSelectionCompatibility.ts"],
      (path) => currentFiles.get(path),
      pins,
    );

    assert.deepEqual(released.problems, []);
    assert.deepEqual(current.problems, []);
    assert.deepEqual(findReleasedDependencyViolations(released.contents, current.contents), [
      "Released migration dependency closure gained contracts/redirect.ts.",
      "Released migration dependency contracts/index.ts was modified.",
      "Released migration dependency contracts/package.json was modified.",
    ]);
  });

  it("detects a same-module alias redirect of a pinned runtime export", () => {
    const releasedFiles = new Map([
      [
        "persistence/modelSelectionCompatibility.ts",
        'import { MODEL_OPTIONS_BY_PROVIDER } from "@synara/contracts";\n',
      ],
      ["contracts/package.json", '{"exports":{".":{"import":"./index.ts"}}}\n'],
      ["contracts/index.ts", 'export { MODEL_OPTIONS_BY_PROVIDER } from "./model.ts";\n'],
      [
        "contracts/model.ts",
        "export const MODEL_OPTIONS_BY_PROVIDER = {};\nexport const ALTERNATE_MODEL_OPTIONS = {};\n",
      ],
    ]);
    const currentFiles = new Map(releasedFiles);
    currentFiles.set(
      "contracts/index.ts",
      'export { ALTERNATE_MODEL_OPTIONS as MODEL_OPTIONS_BY_PROVIDER } from "./model.ts";\n',
    );
    const pins = new Map<string, PinnedWorkspaceImport>([
      [
        pinnedWorkspaceImportKey(
          "persistence/modelSelectionCompatibility.ts",
          "@synara/contracts",
          "import:MODEL_OPTIONS_BY_PROVIDER",
        ),
        {
          resolutionEvidence: [
            { kind: "package-root-import", path: "contracts/package.json" },
            {
              kind: "named-barrel-export",
              path: "contracts/index.ts",
              exportName: "MODEL_OPTIONS_BY_PROVIDER",
            },
          ],
          runtimeSourcePath: "contracts/model.ts",
        },
      ],
    ]);
    const released = buildLocalDependencyClosure(
      ["persistence/modelSelectionCompatibility.ts"],
      (path) => releasedFiles.get(path),
      pins,
    );
    const current = buildLocalDependencyClosure(
      ["persistence/modelSelectionCompatibility.ts"],
      (path) => currentFiles.get(path),
      pins,
    );

    assert.deepEqual(released.problems, []);
    assert.deepEqual(current.problems, []);
    assert.deepEqual(findReleasedDependencyViolations(released.contents, current.contents), [
      "Released migration dependency contracts/index.ts was modified.",
    ]);
  });

  it("freezes even equivalent-looking pinned barrel rewrites", () => {
    const releasedFiles = new Map([
      [
        "persistence/modelSelectionCompatibility.ts",
        'import { MODEL_OPTIONS_BY_PROVIDER } from "@synara/contracts";\n',
      ],
      ["contracts/package.json", '{"exports":{".":{"import":"./index.ts"}}}\n'],
      ["contracts/index.ts", 'export { MODEL_OPTIONS_BY_PROVIDER } from "./model";\n'],
      ["contracts/model.ts", "export const MODEL_OPTIONS_BY_PROVIDER = {};\n"],
    ]);
    const currentFiles = new Map(releasedFiles);
    currentFiles.set(
      "contracts/index.ts",
      'export { MODEL_OPTIONS_BY_PROVIDER } from "./model.ts";\n',
    );
    const pins = new Map<string, PinnedWorkspaceImport>([
      [
        pinnedWorkspaceImportKey(
          "persistence/modelSelectionCompatibility.ts",
          "@synara/contracts",
          "import:MODEL_OPTIONS_BY_PROVIDER",
        ),
        {
          resolutionEvidence: [
            { kind: "package-root-import", path: "contracts/package.json" },
            {
              kind: "named-barrel-export",
              path: "contracts/index.ts",
              exportName: "MODEL_OPTIONS_BY_PROVIDER",
            },
          ],
          runtimeSourcePath: "contracts/model.ts",
        },
      ],
    ]);
    const released = buildLocalDependencyClosure(
      ["persistence/modelSelectionCompatibility.ts"],
      (path) => releasedFiles.get(path),
      pins,
    );
    const current = buildLocalDependencyClosure(
      ["persistence/modelSelectionCompatibility.ts"],
      (path) => currentFiles.get(path),
      pins,
    );

    assert.deepEqual(released.problems, []);
    assert.deepEqual(current.problems, []);
    assert.deepEqual(findReleasedDependencyViolations(released.contents, current.contents), [
      "Released migration dependency contracts/index.ts was modified.",
    ]);
  });

  it("tracks every runtime barrel export while ignoring unrelated package metadata", () => {
    const releasedFiles = new Map([
      [
        "persistence/modelSelectionCompatibility.ts",
        'import { MODEL_OPTIONS_BY_PROVIDER } from "@synara/contracts";\n',
      ],
      [
        "contracts/package.json",
        '{"name":"contracts","version":"1.0.0","exports":{".":{"import":"./index.ts"}}}\n',
      ],
      ["contracts/index.ts", 'export * from "./model.ts";\nexport * from "./unrelated.ts";\n'],
      ["contracts/model.ts", "export const MODEL_OPTIONS_BY_PROVIDER = {};\n"],
      ["contracts/unrelated.ts", "export const UNRELATED = true;\n"],
    ]);
    const currentFiles = new Map(releasedFiles);
    currentFiles.set(
      "contracts/package.json",
      '{"name":"contracts","version":"2.0.0","scripts":{"build":"changed"},"exports":{".":{"import":"./index.ts"}}}\n',
    );
    currentFiles.set(
      "contracts/unrelated.ts",
      'throw new Error("changed runtime side effect");\nexport const UNRELATED = true;\n',
    );
    const pins = new Map<string, PinnedWorkspaceImport>([
      [
        pinnedWorkspaceImportKey(
          "persistence/modelSelectionCompatibility.ts",
          "@synara/contracts",
          "import:MODEL_OPTIONS_BY_PROVIDER",
        ),
        {
          resolutionEvidence: [
            { kind: "package-root-import", path: "contracts/package.json" },
            {
              kind: "named-barrel-export",
              path: "contracts/index.ts",
              exportName: "MODEL_OPTIONS_BY_PROVIDER",
            },
          ],
          runtimeSourcePath: "contracts/model.ts",
        },
      ],
    ]);
    const released = buildLocalDependencyClosure(
      ["persistence/modelSelectionCompatibility.ts"],
      (path) => releasedFiles.get(path),
      pins,
    );
    const current = buildLocalDependencyClosure(
      ["persistence/modelSelectionCompatibility.ts"],
      (path) => currentFiles.get(path),
      pins,
    );

    assert.deepEqual(released.problems, []);
    assert.deepEqual(current.problems, []);
    assert.deepEqual(findReleasedDependencyViolations(released.contents, current.contents), [
      "Released migration dependency contracts/unrelated.ts was modified.",
    ]);
  });

  it("ignores comment, formatting, and separate type-only barrel changes", () => {
    const releasedFiles = new Map([
      [
        "persistence/modelSelectionCompatibility.ts",
        'import { MODEL_OPTIONS_BY_PROVIDER } from "@synara/contracts";\n',
      ],
      ["contracts/package.json", '{"exports":{".":{"import":"./index.ts"}}}\n'],
      ["contracts/index.ts", 'export * from "./model.ts";\n'],
      ["contracts/model.ts", "export const MODEL_OPTIONS_BY_PROVIDER = {};\n"],
    ]);
    const currentFiles = new Map(releasedFiles);
    currentFiles.set(
      "contracts/index.ts",
      '// documentation only\nimport type Types = require("./types.ts");\nexport   *   from "./model.ts";\nexport { type Metadata } from "./types.ts";\n',
    );
    currentFiles.set("contracts/types.ts", "export interface Metadata {}\n");
    const pins = new Map<string, PinnedWorkspaceImport>([
      [
        pinnedWorkspaceImportKey(
          "persistence/modelSelectionCompatibility.ts",
          "@synara/contracts",
          "import:MODEL_OPTIONS_BY_PROVIDER",
        ),
        {
          resolutionEvidence: [
            { kind: "package-root-import", path: "contracts/package.json" },
            {
              kind: "named-barrel-export",
              path: "contracts/index.ts",
              exportName: "MODEL_OPTIONS_BY_PROVIDER",
            },
          ],
          runtimeSourcePath: "contracts/model.ts",
        },
      ],
    ]);
    const released = buildLocalDependencyClosure(
      ["persistence/modelSelectionCompatibility.ts"],
      (path) => releasedFiles.get(path),
      pins,
    );
    const current = buildLocalDependencyClosure(
      ["persistence/modelSelectionCompatibility.ts"],
      (path) => currentFiles.get(path),
      pins,
    );

    assert.deepEqual(released.problems, []);
    assert.deepEqual(current.problems, []);
    assert.deepEqual(findReleasedDependencyViolations(released.contents, current.contents), []);
  });

  it("ignores inline type-only barrel additions while freezing runtime exports", () => {
    const released = new Map([
      ["migration.ts", 'import { VALUE } from "@synara/contracts";'],
      ["contracts/package.json", '{"exports":{".":{"import":"./index.ts"}}}'],
      ["contracts/index.ts", 'export { VALUE } from "./model.ts";'],
      ["contracts/model.ts", "export const VALUE = 1;"],
    ]);
    const current = new Map(released);
    current.set("contracts/index.ts", 'export { VALUE, type Metadata } from "./model.ts";');
    const pins = new Map<string, PinnedWorkspaceImport>([
      [
        pinnedWorkspaceImportKey("migration.ts", "@synara/contracts", "import:VALUE"),
        {
          resolutionEvidence: [
            { kind: "package-root-import", path: "contracts/package.json" },
            {
              kind: "named-barrel-export",
              path: "contracts/index.ts",
              exportName: "VALUE",
            },
          ],
          runtimeSourcePath: "contracts/model.ts",
        },
      ],
    ]);

    const releasedClosure = buildLocalDependencyClosure(
      ["migration.ts"],
      (path) => released.get(path),
      pins,
    );
    const currentClosure = buildLocalDependencyClosure(
      ["migration.ts"],
      (path) => current.get(path),
      pins,
    );

    assert.deepEqual(releasedClosure.problems, []);
    assert.deepEqual(currentClosure.problems, []);
    assert.deepEqual(
      findReleasedDependencyViolations(releasedClosure.contents, currentClosure.contents),
      [],
    );
  });

  it("keeps a runtime default import when every named companion is type-only", () => {
    const files = new Map([
      ["migration.ts", 'import RuntimeDefault, { type Metadata } from "./helper.ts";\n'],
      ["helper.ts", "export default 1;\n"],
    ]);
    const closure = buildLocalDependencyClosure(["migration.ts"], (path) => files.get(path));

    assert.deepEqual(closure.problems, []);
    assert.isTrue(closure.contents.has("helper.ts"));
  });

  it("does not traverse a type-only import-equals dependency", () => {
    const files = new Map([
      ["migration.ts", 'import type Types = require("./types.ts");\nexport const VALUE = 1;'],
      ["types.ts", "export interface Metadata {}"],
    ]);
    const closure = buildLocalDependencyClosure(["migration.ts"], (path) => files.get(path));

    assert.deepEqual(closure.problems, []);
    assert.deepEqual([...closure.contents.keys()], ["migration.ts"]);
  });

  it("fails closed for unresolved, escaping, ambiguous, or dynamic local dependencies", () => {
    const files = new Map([
      [
        "Migrations/001_CreateProjects.ts",
        [
          'import "./missing.ts";',
          'import "../../../outside.ts";',
          'import "./ambiguous";',
          'const module = import("./dynamic.ts");',
        ].join("\n"),
      ],
      ["Migrations/ambiguous.ts", "export {};\n"],
      ["Migrations/ambiguous/index.ts", "export {};\n"],
    ]);
    const closure = buildLocalDependencyClosure(["Migrations/001_CreateProjects.ts"], (path) =>
      files.get(path),
    );

    assert.isTrue(closure.problems.some((problem) => problem.includes("could not be resolved")));
    assert.isTrue(closure.problems.some((problem) => problem.includes("escapes the repository")));
    assert.isTrue(closure.problems.some((problem) => problem.includes("is ambiguous")));
    assert.isTrue(closure.problems.some((problem) => problem.includes("dynamic import()")));
  });

  it("rejects indirect Node module loaders and runtime code generation", () => {
    const files = new Map([
      [
        "Migrations/001_CreateProjects.ts",
        [
          'import { createRequire } from "node:module";',
          "const load = createRequire(import.meta.url);",
          'load("./hidden.ts");',
          '(0, eval)("require(\\"./fifth-hidden.ts\\")");',
          'Function("return import(\\"./fourth-hidden.ts\\")")();',
          'new Function("return require(\\"./third-hidden.ts\\")");',
          "const indirectEval = eval;",
          "const indirectFunction = Function;",
          'globalThis["eval"]("void 0");',
          'Reflect.construct(Function, ["return 1"]);',
          'new globalThis.Function("return 1");',
          'process.getBuiltinModule("node:module").createRequire(import.meta.url);',
        ].join("\n"),
      ],
    ]);
    const closure = buildLocalDependencyClosure(["Migrations/001_CreateProjects.ts"], (path) =>
      files.get(path),
    );

    assert.isTrue(closure.problems.some((problem) => problem.includes('imports "node:module"')));
    assert.isTrue(closure.problems.some((problem) => problem.includes("eval")));
    assert.isTrue(closure.problems.some((problem) => problem.includes("Function")));
    assert.isTrue(closure.problems.some((problem) => problem.includes("getBuiltinModule")));
  });

  it("rejects every indirect runtime loader spelling independently", () => {
    const unsafeSources = [
      "const execute = eval; execute('void 0');",
      "const Build = Function; new (Build)('return 1');",
      'globalThis["eval"]("void 0");',
      'Reflect.construct(Function, ["return 1"]);',
      'new globalThis.Function("return 1");',
      'process.getBuiltinModule("node:module").createRequire(import.meta.url);',
      'globalThis.process.getBuiltinModule("node:module").createRequire(import.meta.url);',
      'globalThis["process"]["get" + "BuiltinModule"]("node:module");',
      "const proc = globalThis.process; proc.getBuiltinModule('node:module');",
      'import.meta.require("./hidden.ts");',
      "const meta = import.meta; meta.require('./hidden.ts');",
      'module.require("./hidden.ts");',
      "const commonJsModule = module; commonJsModule.require('./hidden.ts');",
      'global.eval("void 0");',
      'Reflect.construct((() => {}).constructor, ["return 1"]);',
      'globalThis.constructor.constructor("return 1")();',
      'import { runInThisContext } from "node:vm"; runInThisContext("void 0");',
      'process.mainModule.require("./hidden.ts");',
      'const key = "getBuiltinModule"; process[key]("node:module");',
      'const key = "require"; module[key]("./hidden.ts");',
      'const key = "require"; import.meta[key]("./hidden.ts");',
      'fetch("https://example.invalid/migration.sql");',
      'Bun.file("./migration.sql");',
      'new Worker("./hidden-migration.ts");',
      'new WebSocket("wss://example.invalid");',
    ];

    for (const source of unsafeSources) {
      const closure = buildLocalDependencyClosure(["migration.ts"], (path) =>
        path === "migration.ts" ? source : undefined,
      );
      assert.isTrue(closure.problems.length > 0, source);
    }
  });

  it("does not confuse unrelated object methods with runtime code generators", () => {
    const files = new Map([
      ["migration.ts", ["schema.eval();", "validator.Function();", "loader.require();"].join("\n")],
    ]);
    const closure = buildLocalDependencyClosure(["migration.ts"], (path) => files.get(path));

    assert.deepEqual(closure.problems, []);
  });

  it("allows only the reviewed Effect external runtime family", () => {
    const effect = buildLocalDependencyClosure(["migration.ts"], (path) =>
      path === "migration.ts" ? 'import { Effect } from "effect";' : undefined,
    );
    const arbitrary = buildLocalDependencyClosure(["migration.ts"], (path) =>
      path === "migration.ts" ? 'import loader from "arbitrary-runtime-loader";' : undefined,
    );

    assert.deepEqual(effect.problems, []);
    assert.isTrue(arbitrary.problems.some((problem) => problem.includes("unreviewed external")));
  });

  it("rejects Node module loaders re-exported through local dependencies", () => {
    const files = new Map([
      ["migration.ts", 'import { createRequire } from "./loader.ts";\n'],
      ["loader.ts", 'export { createRequire } from "node:module";\n'],
    ]);
    const closure = buildLocalDependencyClosure(["migration.ts"], (path) => files.get(path));

    assert.isTrue(closure.problems.some((problem) => problem.includes('re-exports "node:module"')));
  });
});
