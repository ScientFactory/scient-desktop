import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  applyProjectInitialization,
  inspectProjectFolder,
  planProjectInitialization,
} from "@papilab/project-init";
import { afterEach, describe, expect, it } from "vitest";

import { PapiLabProjectInitializationService } from "./papilabProjectInitialization";

const roots: string[] = [];

async function makeProjectFolder(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "papilab-project-service-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("PapiLabProjectInitializationService", () => {
  it("keeps preview read-only and applies the server-owned plan by one-shot opaque ID", async () => {
    const root = await makeProjectFolder();
    const service = new PapiLabProjectInitializationService({
      createPreviewId: () => "preview-1",
    });

    const preview = await service.preview({ root, request: { title: "Safety study" } });
    const canonicalRoot = await realpath(root);

    expect(await readdir(root)).toEqual([]);
    expect(preview).toMatchObject({
      previewId: "preview-1",
      root: canonicalRoot,
      status: "ready",
      canApply: true,
      canRecover: false,
      canRollback: false,
    });

    const projectOperation = preview.operations.find(
      (operation) => operation.path === "PROJECT.md",
    );
    if (!projectOperation) throw new Error("Expected PROJECT.md preview operation.");
    (projectOperation as { contents?: string }).contents = "tampered browser contents\n";

    const result = await service.apply("preview-1");
    expect(result.created).toEqual(["AGENTS.md", "PROJECT.md", ".papilab/project.json"]);
    expect(await readFile(path.join(root, "PROJECT.md"), "utf8")).toContain("Safety study");
    expect(await readFile(path.join(root, "PROJECT.md"), "utf8")).not.toContain(
      "tampered browser contents",
    );
    await expect(service.apply("preview-1")).rejects.toThrow("expired");
  });

  it("expires previews before they can write", async () => {
    const root = await makeProjectFolder();
    let now = 1_000;
    const service = new PapiLabProjectInitializationService({
      now: () => now,
      createPreviewId: () => "preview-expiring",
      previewTtlMs: 50,
    });

    await service.preview({ root });
    now += 51;

    await expect(service.apply("preview-expiring")).rejects.toThrow("expired");
    expect(await readdir(root)).toEqual([]);
  });

  it("allows exactly one concurrent consumer of a preview", async () => {
    const root = await makeProjectFolder();
    const service = new PapiLabProjectInitializationService({
      createPreviewId: () => "preview-once",
    });
    await service.preview({ root });

    const results = await Promise.allSettled([
      service.apply("preview-once"),
      service.apply("preview-once"),
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect((await inspectProjectFolder(root)).state).toBe("initialized-compatible");
  });

  it("returns no actionable handle for an invalid folder", async () => {
    const root = await makeProjectFolder();
    await writeFile(path.join(root, ".papilab"), "not a directory\n");
    const service = new PapiLabProjectInitializationService();

    const preview = await service.preview({ root });

    expect(preview).toMatchObject({
      previewId: null,
      expiresAt: null,
      status: "blocked",
      canApply: false,
      canRecover: false,
      canRollback: false,
    });
  });

  it("keeps the existing create-missing-folder flow available without writing during preview", async () => {
    const parent = await makeProjectFolder();
    const root = path.join(parent, "new-project");
    const service = new PapiLabProjectInitializationService();

    const preview = await service.preview({ root });

    expect(preview).toMatchObject({
      previewId: null,
      folderState: "unavailable",
      status: "blocked",
      canApply: false,
    });
    await expect(readdir(root)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("offers recovery and rollback only for a validated incomplete transaction", async () => {
    const root = await makeProjectFolder();
    const inspection = await inspectProjectFolder(root);
    const plan = await planProjectInitialization({ inspection, request: {} });
    await expect(
      applyProjectInitialization(plan, {
        onStep: (step) => {
          if (step.kind === "file-created" && step.path === "AGENTS.md") {
            throw new Error("simulated interruption");
          }
        },
      }),
    ).rejects.toThrow("simulated interruption");

    const previewIds = ["recovery-preview", "rollback-preview"];
    const service = new PapiLabProjectInitializationService({
      createPreviewId: () => previewIds.shift() ?? "unexpected-preview",
    });
    const recoveryPreview = await service.preview({ root });
    expect(recoveryPreview).toMatchObject({
      previewId: "recovery-preview",
      status: "recovery-required",
      canApply: false,
      canRecover: true,
      canRollback: true,
    });

    const recovered = await service.recover("recovery-preview");
    expect(recovered.recovered).toBe(true);
    expect((await inspectProjectFolder(root)).state).toBe("initialized-compatible");

    const rollbackRoot = await makeProjectFolder();
    await mkdir(path.join(rollbackRoot, ".papilab"));
    const rollbackPlan = await planProjectInitialization({
      inspection: await inspectProjectFolder(rollbackRoot),
      request: {},
    });
    await expect(
      applyProjectInitialization(rollbackPlan, {
        onStep: (step) => {
          if (step.kind === "file-created") throw new Error("simulated interruption");
        },
      }),
    ).rejects.toThrow("simulated interruption");

    const rollbackPreview = await service.preview({ root: rollbackRoot });
    expect(rollbackPreview.previewId).toBe("rollback-preview");
    const rolledBack = await service.rollback("rollback-preview");
    expect(rolledBack.complete).toBe(true);
    expect((await inspectProjectFolder(rollbackRoot)).state).toBe("empty-uninitialized");
  });
});
