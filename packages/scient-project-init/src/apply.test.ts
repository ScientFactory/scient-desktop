import { link, mkdir, readFile, rename, symlink, writeFile } from "node:fs/promises";
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
  SCIENT_TRANSACTION_FILE,
  ProjectInitializationError,
  type InitializationPlan,
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
    expect(result.created).toEqual([
      ".scient/skills.lock.json",
      "AGENTS.md",
      "PROJECT.md",
      ".scient/project.json",
    ]);
    expect(result.activatedSkills).toEqual([]);
    expect(steps).toEqual([
      "marker-written:.scient/init-transaction.json",
      "file-created:.scient/skills.lock.json",
      "file-created:AGENTS.md",
      "file-created:PROJECT.md",
      "file-created:.scient/project.json",
      "completed:.scient/init-transaction.json",
    ]);
    expect(await inspectProjectFolder(fixture.root)).toMatchObject({
      state: "initialized-compatible",
      identity: { projectId: TEST_IDENTITY.projectId },
      skillsLock: { formatVersion: 1, skills: [] },
    });
    expect(
      await readFile(path.join(fixture.root, SCIENT_TRANSACTION_FILE)).catch(() => null),
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
    expect(secondResult.preserved).toEqual(["PROJECT.md", "AGENTS.md", ".scient/skills.lock.json"]);
  });

  it("migrates a PapiLab identity additively and preserves rollback metadata", async () => {
    const fixture = await makeTemporaryProject();
    cleanups.push(fixture.cleanup);
    await mkdir(path.join(fixture.root, ".papilab"));
    await writeFile(path.join(fixture.root, "PROJECT.md"), "# Existing\n");
    await writeFile(path.join(fixture.root, "AGENTS.md"), "# Existing\n");
    await writeFile(
      path.join(fixture.root, ".papilab/project.json"),
      `${JSON.stringify({
        projectId: "33333333-3333-4333-8333-333333333333",
        formatVersion: 1,
        createdAt: "2026-07-16T12:00:00.000Z",
      })}\n`,
    );

    const plan = await makePlan(fixture.root);
    expect(plan.projectId).toBe("33333333-3333-4333-8333-333333333333");
    expect(plan.operations).toContainEqual(
      expect.objectContaining({
        kind: "create",
        path: ".scient/project.json",
        reason:
          "Migrate the verified PapiLab project identity into .scient without deleting rollback metadata.",
      }),
    );

    await applyProjectInitialization(plan);

    expect((await inspectProjectFolder(fixture.root)).state).toBe("initialized-compatible");
    expect(
      JSON.parse(await readFile(path.join(fixture.root, ".scient/project.json"), "utf8")),
    ).toMatchObject({ projectId: "33333333-3333-4333-8333-333333333333" });
    expect(
      JSON.parse(await readFile(path.join(fixture.root, ".papilab/project.json"), "utf8")),
    ).toMatchObject({ projectId: "33333333-3333-4333-8333-333333333333" });
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
    expect(await readFile(path.join(movedRoot, ".scient/project.json"), "utf8")).not.toContain(
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
      await readFile(path.join(fixture.root, ".scient/project.json")).catch(() => null),
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
      const transaction = await readFile(path.join(fixture.root, SCIENT_TRANSACTION_FILE), "utf8");
      expect(transaction).not.toContain(fixture.root);

      const recovered = await recoverProjectInitialization(fixture.root);
      expect(recovered.recovered).toBe(true);
      expect((await inspectProjectFolder(fixture.root)).state).toBe("initialized-compatible");
    }
  });

  it("recovers a legacy in-flight initialization without inventing skill activation", async () => {
    const fixture = await makeTemporaryProject();
    cleanups.push(fixture.cleanup);
    await expect(
      applyProjectInitialization(await makePlan(fixture.root), {
        onStep: (step) => {
          if (step.kind === "marker-written") throw new Error("simulated pre-skills crash");
        },
      }),
    ).rejects.toThrow("simulated pre-skills crash");

    const transactionPath = path.join(fixture.root, SCIENT_TRANSACTION_FILE);
    const transaction = JSON.parse(await readFile(transactionPath, "utf8")) as {
      skillActivations?: unknown;
      operations: Array<{ path: string }>;
    };
    delete transaction.skillActivations;
    transaction.operations = transaction.operations.filter(
      (operation) => operation.path !== ".scient/skills.lock.json",
    );
    await writeFile(transactionPath, `${JSON.stringify(transaction, null, 2)}\n`);

    const recovered = await recoverProjectInitialization(fixture.root);

    expect(recovered).toMatchObject({ recovered: true, activatedSkills: [] });
    expect(await inspectProjectFolder(fixture.root)).toMatchObject({
      state: "initialized-compatible",
      skillsLockFile: { kind: "missing" },
      skillsLock: null,
    });
  });

  it("removes an attributable stale temporary hard link during recovery", async () => {
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
    const agentsPath = path.join(fixture.root, "AGENTS.md");
    const staleTemporaryPath = path.join(
      fixture.root,
      `.AGENTS.md.scient-init-${TEST_IDENTITY.transactionId}.tmp`,
    );
    await link(agentsPath, staleTemporaryPath);

    await recoverProjectInitialization(fixture.root);

    expect(await readFile(staleTemporaryPath).catch(() => null)).toBeNull();
    expect((await inspectProjectFolder(fixture.root)).state).toBe("initialized-compatible");
  });

  it("refuses recovery when a preserved file changes after the marker is written", async () => {
    const fixture = await makeTemporaryProject();
    cleanups.push(fixture.cleanup);
    await writeFile(path.join(fixture.root, "AGENTS.md"), "# Existing rules\n");
    const plan = await makePlan(fixture.root);
    await expect(
      applyProjectInitialization(plan, {
        onStep: (step) => {
          if (step.kind === "marker-written") throw new Error("simulated crash");
        },
      }),
    ).rejects.toThrow("simulated crash");
    await writeFile(path.join(fixture.root, "AGENTS.md"), "# Changed during recovery\n");

    await expect(recoverProjectInitialization(fixture.root)).rejects.toMatchObject({
      code: "RECOVERY_CONFLICT",
    });
    expect(await readFile(path.join(fixture.root, "AGENTS.md"), "utf8")).toBe(
      "# Changed during recovery\n",
    );
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
    expect(await readFile(path.join(fixture.root, SCIENT_TRANSACTION_FILE), "utf8")).toContain(
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

    const reopenedPlan = await makePlan(fixture.root);
    const reopenedResult = await applyProjectInitialization(reopenedPlan);
    expect(reopenedPlan.status).toBe("already-initialized");
    expect(reopenedResult.proposed).toEqual(["AGENTS.md"]);
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

  it("does not follow a replaced profile parent during rollback", async () => {
    const fixture = await makeTemporaryProject();
    const outside = await makeTemporaryProject();
    cleanups.push(fixture.cleanup, outside.cleanup);
    const profile: ProjectProfileDescriptor = {
      id: "test-analysis",
      version: 1,
      displayName: "Test Analysis",
      files: [{ path: "analysis/NOTES.md", contents: "# Notes\n" }],
    };
    await expect(
      applyProjectInitialization(await makePlan(fixture.root, [profile]), {
        onStep: (step) => {
          if (step.kind === "file-created" && step.path === "analysis/NOTES.md") {
            throw new Error("simulated crash");
          }
        },
      }),
    ).rejects.toThrow("simulated crash");
    await writeFile(path.join(outside.root, "NOTES.md"), "# Notes\n");
    await rename(path.join(fixture.root, "analysis"), path.join(fixture.root, "analysis-original"));
    await symlink(outside.root, path.join(fixture.root, "analysis"));

    await expect(rollbackProjectInitialization(fixture.root)).rejects.toMatchObject({
      code: "PATH_ESCAPE",
    });
    expect(await readFile(path.join(outside.root, "NOTES.md"), "utf8")).toBe("# Notes\n");
  });

  it("does not clean up a transaction through a replaced metadata parent", async () => {
    const fixture = await makeTemporaryProject();
    const outside = await makeTemporaryProject();
    cleanups.push(fixture.cleanup, outside.cleanup);
    const outsideTransactionPath = path.join(outside.root, "init-transaction.json");
    await writeFile(outsideTransactionPath, "outside transaction\n");

    await expect(
      applyProjectInitialization(await makePlan(fixture.root), {
        onStep: async (step) => {
          if (step.kind !== "file-created" || step.path !== ".scient/project.json") return;
          await rename(
            path.join(fixture.root, ".scient"),
            path.join(fixture.root, ".scient-original"),
          );
          await symlink(outside.root, path.join(fixture.root, ".scient"));
        },
      }),
    ).rejects.toMatchObject({ code: "PATH_ESCAPE" });
    expect(await readFile(outsideTransactionPath, "utf8")).toBe("outside transaction\n");
  });

  it("creates a profile file beneath a safe two-dot-prefixed directory", async () => {
    const fixture = await makeTemporaryProject();
    cleanups.push(fixture.cleanup);
    const profile: ProjectProfileDescriptor = {
      id: "dot-prefix",
      version: 1,
      displayName: "Dot prefix",
      files: [{ path: "..notes/README.md", contents: "# Notes\n" }],
    };

    await applyProjectInitialization(await makePlan(fixture.root, [profile]));

    expect(await readFile(path.join(fixture.root, "..notes/README.md"), "utf8")).toBe("# Notes\n");
  });

  it("repairs an empty metadata directory left before a marker could be written", async () => {
    const fixture = await makeTemporaryProject();
    cleanups.push(fixture.cleanup);
    await mkdir(path.join(fixture.root, ".scient"));

    await applyProjectInitialization(await makePlan(fixture.root));

    expect((await inspectProjectFolder(fixture.root)).state).toBe("initialized-compatible");
  });

  it("rejects a transaction that cannot fit inside the recovery read limit before writing", async () => {
    const fixture = await makeTemporaryProject();
    cleanups.push(fixture.cleanup);
    const profiles: readonly ProjectProfileDescriptor[] = Array.from({ length: 5 }, (_, index) => ({
      id: `large-profile-${index}`,
      version: 1,
      displayName: `Large profile ${index}`,
      files: [{ path: `large/file-${index}.txt`, contents: "x".repeat(900_000) }],
    }));
    const plan = await makePlan(fixture.root, profiles);

    await expect(applyProjectInitialization(plan)).rejects.toMatchObject({
      code: "INVALID_TRANSACTION",
    });
    expect(await inspectProjectFolder(fixture.root)).toMatchObject({
      state: "empty-uninitialized",
    });
  });

  it("rejects an unresolved conflict even if a caller marks the plan ready", async () => {
    const fixture = await makeTemporaryProject();
    cleanups.push(fixture.cleanup);
    const plan = await makePlan(fixture.root);
    const invalidPlan: InitializationPlan = {
      ...plan,
      operations: [
        ...plan.operations,
        {
          kind: "conflict",
          path: "unsafe.md",
          reason: "Synthetic invalid plan.",
          observed: { kind: "missing" },
        },
      ],
    };

    await expect(applyProjectInitialization(invalidPlan)).rejects.toMatchObject({
      code: "INVALID_PLAN",
    });
    expect(await inspectProjectFolder(fixture.root)).toMatchObject({
      state: "empty-uninitialized",
    });
  });

  it("rejects a transaction symlink when recovery is invoked directly", async () => {
    const fixture = await makeTemporaryProject();
    const outside = await makeTemporaryProject();
    cleanups.push(fixture.cleanup, outside.cleanup);
    const plan = await makePlan(fixture.root);
    await expect(
      applyProjectInitialization(plan, {
        onStep: (step) => {
          if (step.kind === "marker-written") throw new Error("simulated crash");
        },
      }),
    ).rejects.toThrow("simulated crash");
    const transactionPath = path.join(fixture.root, SCIENT_TRANSACTION_FILE);
    const outsideTransactionPath = path.join(outside.root, "transaction.json");
    await rename(transactionPath, outsideTransactionPath);
    await symlink(outsideTransactionPath, transactionPath);

    await expect(recoverProjectInitialization(fixture.root)).rejects.toMatchObject({
      code: "INVALID_TRANSACTION",
    });
  });
});
