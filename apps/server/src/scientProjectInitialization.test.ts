import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  applyProjectInitialization,
  inspectProjectFolder,
  planProjectInitialization,
} from "@scientfactory/project-init";
import { afterEach, describe, expect, it } from "vitest";

import { ScientProjectInitializationService } from "./scientProjectInitialization";

const roots: string[] = [];

async function makeProjectFolder(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "scient-project-service-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("ScientProjectInitializationService", () => {
  it("keeps preview read-only and applies the server-owned plan by one-shot opaque ID", async () => {
    const root = await makeProjectFolder();
    const service = new ScientProjectInitializationService({
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
      skills: [
        expect.objectContaining({
          id: "scient.evidence-to-note",
          selected: false,
          defaultSelected: false,
          readiness: "latent",
        }),
      ],
    });

    const projectOperation = preview.operations.find(
      (operation) => operation.path === "PROJECT.md",
    );
    if (!projectOperation) throw new Error("Expected PROJECT.md preview operation.");
    (projectOperation as { contents?: string }).contents = "tampered browser contents\n";

    const result = await service.apply("preview-1");
    expect(result.created).toEqual([
      ".scient/skills.lock.json",
      "AGENTS.md",
      "PROJECT.md",
      ".scient/project.json",
    ]);
    expect(result.activatedSkills).toEqual([]);
    expect(await readFile(path.join(root, "PROJECT.md"), "utf8")).toContain("Safety study");
    expect(await readFile(path.join(root, "PROJECT.md"), "utf8")).not.toContain(
      "tampered browser contents",
    );
    await expect(service.apply("preview-1")).rejects.toThrow("expired");
  });

  it("offers Evidence to Note as latent and records it only when explicitly selected", async () => {
    const root = await makeProjectFolder();
    const service = new ScientProjectInitializationService({
      createPreviewId: () => "evidence-to-note-preview",
    });

    const preview = await service.preview({
      root,
      request: { title: "Evidence project", skillIds: ["scient.evidence-to-note"] },
    });
    const skill = preview.skills.find((candidate) => candidate.id === "scient.evidence-to-note");
    if (!skill) throw new Error("Expected Evidence to Note in the initialization preview.");

    expect(skill).toMatchObject({
      displayName: "Evidence to Note",
      selected: true,
      defaultSelected: false,
      readiness: "latent",
      capabilities: {
        network: false,
        codeExecution: false,
        projectWrites: "proposal-only",
      },
    });
    expect(skill?.prerequisites).toContain("Project object: selected source evidence");
    expect(skill?.prerequisites).toContain("Operation: propose evidence-linked note");

    const result = await service.apply("evidence-to-note-preview");
    expect(result.activatedSkills).toEqual([
      {
        id: "scient.evidence-to-note",
        version: "0.1.0",
        digest: skill.digest,
        origin: "scient:builtin",
      },
    ]);
    expect(JSON.parse(await readFile(path.join(root, ".scient/skills.lock.json"), "utf8"))).toEqual(
      {
        formatVersion: 1,
        skills: result.activatedSkills,
      },
    );
  });

  it("previews and records only explicitly selected researcher-facing built-ins", async () => {
    const root = await makeProjectFolder();
    const skill = {
      id: "scient.test-skill",
      version: "0.1.0",
      digest: `sha256:${"1".repeat(64)}` as const,
      origin: "scient:builtin" as const,
      displayName: "Test Skill",
      description: "A researcher-facing skill used to verify initialization selection.",
      role: "constructive" as const,
      defaultSelected: false,
      readiness: "available" as const,
      prerequisites: [],
      capabilities: {
        network: false,
        codeExecution: false,
        projectWrites: "proposal-only" as const,
      },
    };
    const service = new ScientProjectInitializationService({
      createPreviewId: () => "skills-preview",
      builtInSkills: [skill],
    });

    const preview = await service.preview({
      root,
      request: { skillIds: [skill.id] },
    });

    expect(preview.skills).toEqual([
      expect.objectContaining({ id: skill.id, selected: true, readiness: "available" }),
    ]);
    const result = await service.apply("skills-preview");
    expect(result.activatedSkills).toEqual([
      {
        id: skill.id,
        version: skill.version,
        digest: skill.digest,
        origin: skill.origin,
      },
    ]);
    expect(JSON.parse(await readFile(path.join(root, ".scient/skills.lock.json"), "utf8"))).toEqual(
      {
        formatVersion: 1,
        skills: result.activatedSkills,
      },
    );
  });

  it("fails safely when preview ID generation keeps colliding", async () => {
    const firstRoot = await makeProjectFolder();
    const secondRoot = await makeProjectFolder();
    const service = new ScientProjectInitializationService({
      createPreviewId: () => "repeated-preview-id",
    });

    await service.preview({ root: firstRoot });

    await expect(service.preview({ root: secondRoot })).rejects.toThrow(
      "Unable to generate a unique project initialization preview ID.",
    );
  });

  it("expires previews before they can write", async () => {
    const root = await makeProjectFolder();
    let now = 1_000;
    const service = new ScientProjectInitializationService({
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
    const service = new ScientProjectInitializationService({
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
    await writeFile(path.join(root, ".scient"), "not a directory\n");
    const service = new ScientProjectInitializationService();

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
    const service = new ScientProjectInitializationService();

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
    const service = new ScientProjectInitializationService({
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
    await mkdir(path.join(rollbackRoot, ".scient"));
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
