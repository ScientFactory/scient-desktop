import { assert, describe, it } from "@effect/vitest";

import {
  findCurrentStructureViolations,
  findReleasedContentViolations,
  findReleasedIdentityViolations,
  parseMigrationCatalog,
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
  return `${imports}\nexport const migrationEntries = [\n${rows}\n] as const;\n`;
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

  it("fails fixtures with gaps, duplicate IDs, duplicate names, or orphaned modules", () => {
    const catalog = catalogFor([
      [1, "CreateProjects"],
      [1, "AddThreadState"],
      [3, "CreateProjects"],
    ]);
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
        { id: 1, releasedName: "CreateProjects", currentName: "CreateProjectsV2" },
        { id: 2, releasedName: "AddThreadState", currentName: null },
      ],
    );
  });

  it("allows only Scient's exact, already-repaired migration 32 rename", () => {
    const released = [
      { id: 32, name: "ReconcileLegacyT3SchemaImport", importName: "Migration0032" },
    ];
    const current = [
      { id: 32, name: "ReconcileImportedSchemaLineage", importName: "Migration0032" },
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
});
