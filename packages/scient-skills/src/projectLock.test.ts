// @effect-diagnostics nodeBuiltinImport:off -- Tests exercise the real project lock filesystem boundary.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { initializeScientProject } from "@scientfactory/project-init";
import { afterEach, describe, expect, it } from "@effect/vitest";

import {
  readProjectSkillLock,
  renderProjectSkillLock,
  SCIENT_SKILLS_LOCK_FILE,
  writeProjectSkillLock,
  type SkillReleaseRef,
} from "./index.ts";

const fixtures: string[] = [];
const release: SkillReleaseRef = {
  id: "scient.evidence-review",
  version: "0.1.0",
  digest: `sha256:${"a".repeat(64)}`,
  origin: "scient",
};
const secondRelease: SkillReleaseRef = {
  id: "scient.reproducible-research",
  version: "0.2.0",
  digest: `sha256:${"b".repeat(64)}`,
  origin: "scient",
};

async function fixture(): Promise<string> {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "scient-skill-lock-"));
  fixtures.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(
    fixtures.splice(0).map((root) => NodeFSP.rm(root, { recursive: true, force: true })),
  );
});

describe("Scient project skill lock", () => {
  it("keeps ordinary folder inspection zero-write", async () => {
    const root = await fixture();

    expect(await readProjectSkillLock(root)).toMatchObject({ status: "absent" });
    await expect(NodeFSP.stat(NodePath.join(root, ".scient"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("writes only after explicit activation and verifies project identity plus lock digest", async () => {
    const root = await fixture();
    await initializeScientProject({ root });

    const result = await writeProjectSkillLock(root, [release]);

    expect(result.lock.skills).toEqual([release]);
    expect(result.lockDigest).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(result.projectId).toMatch(/^[0-9a-f-]{36}$/u);
    expect(await NodeFSP.readFile(NodePath.join(root, SCIENT_SKILLS_LOCK_FILE), "utf8")).toBe(
      renderProjectSkillLock([release]),
    );
  });

  it("refuses activation writes in an ordinary folder", async () => {
    const root = await fixture();

    await expect(writeProjectSkillLock(root, [release])).rejects.toThrow(
      "not an initialized Scient project",
    );
  });

  it("rejects duplicate identities and symlinked locks", async () => {
    expect(() => renderProjectSkillLock([release, release])).toThrow("duplicate");
    expect(renderProjectSkillLock([release, secondRelease])).toBe(
      renderProjectSkillLock([secondRelease, release]),
    );
    const root = await fixture();
    await initializeScientProject({ root });
    const outside = NodePath.join(root, "outside-lock.json");
    await NodeFSP.writeFile(outside, renderProjectSkillLock([release]), "utf8");
    await NodeFSP.symlink(outside, NodePath.join(root, SCIENT_SKILLS_LOCK_FILE));

    expect(await readProjectSkillLock(root)).toMatchObject({ status: "invalid" });
  });

  it("does not read or write through a symlinked .scient directory", async () => {
    const root = await fixture();
    await initializeScientProject({ root });
    const realMetadata = NodePath.join(root, "real-scient-metadata");
    await NodeFSP.rename(NodePath.join(root, ".scient"), realMetadata);
    await NodeFSP.symlink(realMetadata, NodePath.join(root, ".scient"));
    await NodeFSP.writeFile(
      NodePath.join(realMetadata, "skills.lock.json"),
      renderProjectSkillLock([release]),
      "utf8",
    );

    expect(await readProjectSkillLock(root)).toMatchObject({
      status: "invalid",
      message: "The project .scient path must be a real directory.",
    });
    await expect(writeProjectSkillLock(root, [release])).rejects.toThrow(
      ".scient path must be a real directory",
    );
  });

  it("treats exact lock bytes as trust-relevant state", async () => {
    const root = await fixture();
    await initializeScientProject({ root });
    const first = await writeProjectSkillLock(root, [release]);
    await NodeFSP.writeFile(
      NodePath.join(root, SCIENT_SKILLS_LOCK_FILE),
      renderProjectSkillLock([{ ...release, digest: `sha256:${"b".repeat(64)}` }]),
      "utf8",
    );
    const second = await readProjectSkillLock(root);

    expect(second.status).toBe("valid");
    if (second.status !== "valid") throw new Error("expected valid lock");
    expect(second.lockDigest).not.toBe(first.lockDigest);
  });
});
