import { mkdir, readFile, rename, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  applyProjectInitialization,
  recoverProjectInitialization,
  rollbackProjectInitialization,
} from "./apply.ts";
import { inspectProjectFolder } from "./inspect.ts";
import { planProjectInitialization } from "./plan.ts";
import { makeTemporaryProject, TEST_IDENTITY } from "./testUtils.ts";
import {
  PAPILAB_TRANSACTION_FILE,
  ProjectInitializationError,
  type ProjectProfileDescriptor,
} from "./types.ts";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

async function makePlan(root: string, profiles: readonly ProjectProfileDescriptor[] = []) {
  return planProjectInitialization({
    inspection: await inspectProjectFolder(root),
    request: { title: "Safe Project", profileIds: profiles.map((profile) => profile.id) },
    profiles,
    ...TEST_IDENTITY,
  });
}

describe("applyProjectInitialization", () => {
  it("creates the universal foundation and writes identity last", async () => {
    const fixture = await makeTemporaryProject();
    cleanups.push(fixture.cleanup);
    const plan = await makePlan(fixture.root);
    const steps: string[] = [];

    const result = await applyProjectInitialization(plan, {
      onStep: (step) => {
        steps.push(`${step.kind}:${step.path}`);
      },
    });

    expect(result.projectId).toBe(TEST_IDENTITY.projectId);
    expect(result.created).toEqual(["AGENTS.md", "PROJECT.md", ".papilab/project.json"]);
    expect(steps).toEqual([
      "marker-written:.papilab/init-transaction.json",
      "file-created:AGENTS.md",
      "file-created:PROJECT.md",
      "file-created:.papilab/project.json",
      "completed:.papilab/init-transaction.json",
    ]);
    expect(await inspectProjectFolder(fixture.root)).toMatchObject({
      state: "initialized-compatible",
      identity: { projectId: TEST_IDENTITY.projectId },
    });
    expect(
      await readFile(path.join(fixture.root, PAPILAB_TRANSACTION_FILE)).catch(() => null),
    ).toBeNull();
  });

  it("is idempotent after successful initialization", async () => {
    const fixture = await makeTemporaryProject();
    cleanups.push(fixture.cleanup);
    await applyProjectInitialization(await makePlan(fixture.root));

    const secondPlan = await makePlan(fixture.root);
    const secondResult = await applyProjectInitialization(secondPlan);

    expect(secondPlan.status).toBe("already-initialized");
    expect(secondResult.created).toEqual([]);
    expect(secondResult.projectId).toBe(TEST_IDENTITY.projectId);
  });

  it("keeps identity portable when the initialized folder moves", async () => {
    const fixture = await makeTemporaryProject();
    const destinationParent = await makeTemporaryProject();
    cleanups.push(destinationParent.cleanup);
    await applyProjectInitialization(await makePlan(fixture.root));
    const movedRoot = path.join(destinationParent.root, "moved-project");
    await rename(fixture.root, movedRoot);

    const inspection = await inspectProjectFolder(movedRoot);

    expect(inspection.state).toBe("initialized-compatible");
    expect(inspection.identity?.projectId).toBe(TEST_IDENTITY.projectId);
    expect(await readFile(path.join(movedRoot, ".papilab/project.json"), "utf8")).not.toContain(
      fixture.root,
    );
  });

  it("aborts before writing when a previewed path changes", async () => {
    const fixture = await makeTemporaryProject();
    cleanups.push(fixture.cleanup);
    const plan = await makePlan(fixture.root);
    await writeFile(path.join(fixture.root, "PROJECT.md"), "# Human race winner\n");

    await expect(applyProjectInitialization(plan)).rejects.toMatchObject({
      code: "CONCURRENT_CHANGE",
    });
    expect(await readFile(path.join(fixture.root, "PROJECT.md"), "utf8")).toBe(
      "# Human race winner\n",
    );
    expect(
      await readFile(path.join(fixture.root, ".papilab/project.json")).catch(() => null),
    ).toBeNull();
  });

  it("recovers after interruption at every created-file boundary", async () => {
    for (const interruptAfter of [0, 1, 2, 3]) {
      const fixture = await makeTemporaryProject();
      cleanups.push(fixture.cleanup);
      const plan = await makePlan(fixture.root);
      await expect(
        applyProjectInitialization(plan, {
          onStep: (step) => {
            if (step.index === interruptAfter) throw new Error(`simulated crash ${interruptAfter}`);
          },
        }),
      ).rejects.toThrow(`simulated crash ${interruptAfter}`);

      const partial = await inspectProjectFolder(fixture.root);
      expect(partial.state).toBe("partially-initialized");
      const transaction = await readFile(path.join(fixture.root, PAPILAB_TRANSACTION_FILE), "utf8");
      expect(transaction).not.toContain(fixture.root);

      const recovered = await recoverProjectInitialization(fixture.root);
      expect(recovered.recovered).toBe(true);
      expect((await inspectProjectFolder(fixture.root)).state).toBe("initialized-compatible");
    }
  });

  it("rolls back only unchanged files created by the interrupted transaction", async () => {
    const fixture = await makeTemporaryProject();
    cleanups.push(fixture.cleanup);
    const plan = await makePlan(fixture.root);
    await expect(
      applyProjectInitialization(plan, {
        onStep: (step) => {
          if (step.kind === "file-created" && step.path === "PROJECT.md") {
            throw new Error("simulated crash");
          }
        },
      }),
    ).rejects.toThrow("simulated crash");

    const result = await rollbackProjectInitialization(fixture.root);

    expect(result.complete).toBe(true);
    expect(result.removed).toEqual(expect.arrayContaining(["PROJECT.md", "AGENTS.md"]));
    expect(await inspectProjectFolder(fixture.root)).toMatchObject({
      state: "empty-uninitialized",
    });
  });

  it("preserves a user-modified partial file during rollback", async () => {
    const fixture = await makeTemporaryProject();
    cleanups.push(fixture.cleanup);
    const plan = await makePlan(fixture.root);
    await expect(
      applyProjectInitialization(plan, {
        onStep: (step) => {
          if (step.kind === "file-created" && step.path === "PROJECT.md") {
            throw new Error("simulated crash");
          }
        },
      }),
    ).rejects.toThrow("simulated crash");
    await writeFile(path.join(fixture.root, "PROJECT.md"), "# User recovered this file\n");

    const result = await rollbackProjectInitialization(fixture.root);

    expect(result.complete).toBe(false);
    expect(result.preserved).toContain("PROJECT.md");
    expect(await readFile(path.join(fixture.root, "PROJECT.md"), "utf8")).toBe(
      "# User recovered this file\n",
    );
    expect(await readFile(path.join(fixture.root, PAPILAB_TRANSACTION_FILE), "utf8")).toContain(
      TEST_IDENTITY.transactionId,
    );
  });

  it("never applies an existing AGENTS.md proposal automatically", async () => {
    const fixture = await makeTemporaryProject();
    cleanups.push(fixture.cleanup);
    await writeFile(path.join(fixture.root, "AGENTS.md"), "# User rules\n");
    const plan = await makePlan(fixture.root);

    const result = await applyProjectInitialization(plan);

    expect(result.proposed).toEqual(["AGENTS.md"]);
    expect(await readFile(path.join(fixture.root, "AGENTS.md"), "utf8")).toBe("# User rules\n");
    expect((await inspectProjectFolder(fixture.root)).state).toBe("initialized-compatible");
  });

  it("rejects a profile target whose parent is an escaping symlink", async () => {
    const fixture = await makeTemporaryProject();
    const outside = await makeTemporaryProject();
    cleanups.push(fixture.cleanup, outside.cleanup);
    await symlink(outside.root, path.join(fixture.root, "analysis"));
    const profile: ProjectProfileDescriptor = {
      id: "test-analysis",
      version: 1,
      displayName: "Test Analysis",
      files: [{ path: "analysis/NOTES.md", contents: "# Notes\n" }],
    };
    const plan = await makePlan(fixture.root, [profile]);

    await expect(applyProjectInitialization(plan)).rejects.toBeInstanceOf(
      ProjectInitializationError,
    );
    expect(await readFile(path.join(outside.root, "NOTES.md")).catch(() => null)).toBeNull();
  });

  it("repairs an empty metadata directory left before a marker could be written", async () => {
    const fixture = await makeTemporaryProject();
    cleanups.push(fixture.cleanup);
    await mkdir(path.join(fixture.root, ".papilab"));

    await applyProjectInitialization(await makePlan(fixture.root));

    expect((await inspectProjectFolder(fixture.root)).state).toBe("initialized-compatible");
  });
});
