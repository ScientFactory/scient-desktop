import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { inspectProjectFolder } from "./inspect.ts";
import { makeTemporaryProject } from "./testUtils.ts";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe("inspectProjectFolder", () => {
  it("classifies an empty folder without writing to it", async () => {
    const fixture = await makeTemporaryProject();
    cleanups.push(fixture.cleanup);

    const inspection = await inspectProjectFolder(fixture.root);

    expect(inspection.state).toBe("empty-uninitialized");
    expect(inspection.entries).toEqual([]);
    expect(await readFile(path.join(fixture.root, ".papilab/project.json")).catch(() => null)).toBeNull();
  });

  it("classifies a non-empty ordinary folder without modifying it", async () => {
    const fixture = await makeTemporaryProject();
    cleanups.push(fixture.cleanup);
    await writeFile(path.join(fixture.root, "README.md"), "existing\n");

    const inspection = await inspectProjectFolder(fixture.root);

    expect(inspection.state).toBe("existing-uninitialized");
    expect(inspection.entries).toEqual(["README.md"]);
    expect(await readFile(path.join(fixture.root, "README.md"), "utf8")).toBe("existing\n");
  });

  it("recognizes a compatible path-independent identity", async () => {
    const fixture = await makeTemporaryProject();
    cleanups.push(fixture.cleanup);
    await mkdir(path.join(fixture.root, ".papilab"));
    await writeFile(path.join(fixture.root, "PROJECT.md"), "# Existing\n");
    await writeFile(path.join(fixture.root, "AGENTS.md"), "# Existing\n");
    await writeFile(
      path.join(fixture.root, ".papilab/project.json"),
      `${JSON.stringify({
        projectId: "11111111-1111-4111-8111-111111111111",
        formatVersion: 1,
        createdAt: "2026-07-16T12:00:00.000Z",
      })}\n`,
    );

    const inspection = await inspectProjectFolder(fixture.root);

    expect(inspection.state).toBe("initialized-compatible");
    expect(inspection.identity?.projectId).toBe("11111111-1111-4111-8111-111111111111");
    expect(JSON.stringify(inspection.identity)).not.toContain(fixture.root);
  });

  it("classifies an empty metadata directory as repairable partial state", async () => {
    const fixture = await makeTemporaryProject();
    cleanups.push(fixture.cleanup);
    await mkdir(path.join(fixture.root, ".papilab"));

    const inspection = await inspectProjectFolder(fixture.root);

    expect(inspection.state).toBe("partially-initialized");
    expect(inspection.issues.map((issue) => issue.code)).toContain("empty-metadata-directory");
  });

  it("rejects a symlinked metadata directory", async () => {
    const fixture = await makeTemporaryProject();
    const outside = await makeTemporaryProject();
    cleanups.push(fixture.cleanup, outside.cleanup);
    await writeFile(path.join(outside.root, "project.json"), "{bad outside metadata\n");
    await symlink(outside.root, path.join(fixture.root, ".papilab"));

    const inspection = await inspectProjectFolder(fixture.root);

    expect(inspection.state).toBe("invalid-or-conflicting");
    expect(inspection.issues.map((issue) => issue.code)).toContain("metadata-path-conflict");
    expect(inspection.identityFile).toEqual({ kind: "missing" });
    expect(inspection.issues.map((issue) => issue.code)).not.toContain("invalid-identity");
  });

  it("reports malformed identity as invalid rather than guessing", async () => {
    const fixture = await makeTemporaryProject();
    cleanups.push(fixture.cleanup);
    await mkdir(path.join(fixture.root, ".papilab"));
    await writeFile(path.join(fixture.root, ".papilab/project.json"), "{bad json\n");

    const inspection = await inspectProjectFolder(fixture.root);

    expect(inspection.state).toBe("invalid-or-conflicting");
    expect(inspection.issues.map((issue) => issue.code)).toContain("invalid-identity");
  });

  it("reports a structurally invalid transaction as invalid", async () => {
    const fixture = await makeTemporaryProject();
    cleanups.push(fixture.cleanup);
    await mkdir(path.join(fixture.root, ".papilab"));
    await writeFile(
      path.join(fixture.root, ".papilab/init-transaction.json"),
      `${JSON.stringify({ transactionVersion: 1, transactionId: "missing-project-fields" })}\n`,
    );

    const inspection = await inspectProjectFolder(fixture.root);

    expect(inspection.state).toBe("invalid-or-conflicting");
    expect(inspection.issues.map((issue) => issue.code)).toContain("invalid-transaction");
  });
});
