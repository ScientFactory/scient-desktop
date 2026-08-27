// @effect-diagnostics nodeBuiltinImport:off -- Tests exercise the real project filesystem boundary.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { initializeScientProject, readScientProjectIdentity } from "@scientfactory/project-init";
import { afterEach, describe, expect, it } from "@effect/vitest";

import {
  loadProjectSkillCatalog,
  MAX_PROJECT_SKILLS,
  readSkillResource,
  skillReleaseKey,
} from "./index.ts";

const fixtures: string[] = [];

async function fixture(prefix = "scient-project-skills-"): Promise<string> {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), prefix));
  fixtures.push(root);
  return root;
}

async function writeProjectSkill(
  projectRoot: string,
  name: string,
  body = "Follow the project evidence and report uncertainty.\n",
): Promise<string> {
  const root = NodePath.join(projectRoot, ".scient", "skills", name);
  await NodeFSP.mkdir(NodePath.join(root, "references"), { recursive: true });
  await NodeFSP.writeFile(
    NodePath.join(root, "SKILL.md"),
    `---\nname: ${name}\ndescription: Applies the project's evidence-review method.\n---\n\n# Evidence review\n\n${body}`,
    "utf8",
  );
  await NodeFSP.writeFile(
    NodePath.join(root, "references", "rubric.md"),
    "Separate observations from inference.\n",
    "utf8",
  );
  return root;
}

afterEach(async () => {
  await Promise.all(
    fixtures.splice(0).map((root) => NodeFSP.rm(root, { recursive: true, force: true })),
  );
});

describe("project-scoped Scient skills", () => {
  it("derives identity and defaults from the project while preserving exact snapshot bytes", async () => {
    const projectRoot = await fixture();
    await initializeScientProject({ root: projectRoot });
    const skillRoot = await writeProjectSkill(projectRoot, "evidence-review");
    const identity = await readScientProjectIdentity(projectRoot);

    const first = await loadProjectSkillCatalog(projectRoot);
    const second = await loadProjectSkillCatalog(projectRoot);
    const release = first.releases[0]!;

    expect(first.projectId).toBe(identity.projectId);
    expect(first.diagnostics).toEqual([]);
    expect(release).toMatchObject({
      id: `project.${identity.projectId}.evidence-review`,
      version: "0.0.0",
      origin: `project:${identity.projectId}`,
      name: "evidence-review",
      supportedScopes: ["project"],
      defaultInvocationPolicy: "automatic",
    });
    expect(skillReleaseKey(second.releases[0]!)).toBe(skillReleaseKey(release));

    await NodeFSP.writeFile(
      NodePath.join(skillRoot, "references", "rubric.md"),
      "changed after the turn snapshot\n",
      "utf8",
    );
    expect(
      Buffer.from(readSkillResource(release, "references/rubric.md") ?? []).toString("utf8"),
    ).toBe("Separate observations from inference.\n");
    expect(skillReleaseKey((await loadProjectSkillCatalog(projectRoot)).releases[0]!)).not.toBe(
      skillReleaseKey(release),
    );
  });

  it("does not scan an ordinary folder even when it contains a plausible skill", async () => {
    const projectRoot = await fixture();
    await writeProjectSkill(projectRoot, "untrusted-review");

    const catalog = await loadProjectSkillCatalog(projectRoot);

    expect(catalog.releases).toEqual([]);
    expect(catalog.diagnostics).toEqual([
      expect.objectContaining({ code: "invalid-project", path: ".scient/project.json" }),
    ]);
  });

  it("quarantines invalid siblings, reserved manifests, and symlinks without hiding valid skills", async () => {
    const projectRoot = await fixture();
    await initializeScientProject({ root: projectRoot });
    await writeProjectSkill(projectRoot, "valid-review");
    const reservedRoot = await writeProjectSkill(projectRoot, "reserved-review");
    await NodeFSP.writeFile(
      NodePath.join(reservedRoot, "scient.skill.json"),
      '{"origin":{"kind":"scient"}}\n',
      "utf8",
    );
    const outside = await fixture("scient-project-skill-outside-");
    await NodeFSP.symlink(
      outside,
      NodePath.join(projectRoot, ".scient", "skills", "linked-review"),
    );
    await NodeFSP.writeFile(
      NodePath.join(projectRoot, ".scient", "skills", "not-a-directory"),
      "invalid\n",
      "utf8",
    );

    const catalog = await loadProjectSkillCatalog(projectRoot);

    expect(catalog.releases.map((release) => release.name)).toEqual(["valid-review"]);
    expect(catalog.diagnostics).toHaveLength(3);
    expect(catalog.diagnostics.every((diagnostic) => diagnostic.code === "invalid-skill")).toBe(
      true,
    );
    expect(catalog.diagnostics.map((diagnostic) => diagnostic.path)).toEqual([
      ".scient/skills/linked-review",
      ".scient/skills/not-a-directory",
      ".scient/skills/reserved-review",
    ]);
  });

  it("fails closed when the project directory count exceeds the bounded catalog", async () => {
    const projectRoot = await fixture();
    await initializeScientProject({ root: projectRoot });
    const skillsRoot = NodePath.join(projectRoot, ".scient", "skills");
    await NodeFSP.mkdir(skillsRoot, { recursive: true });
    await Promise.all(
      Array.from({ length: MAX_PROJECT_SKILLS + 1 }, (_, index) =>
        NodeFSP.mkdir(NodePath.join(skillsRoot, `skill-${String(index).padStart(2, "0")}`)),
      ),
    );

    const catalog = await loadProjectSkillCatalog(projectRoot);

    expect(catalog.releases).toEqual([]);
    expect(catalog.diagnostics).toEqual([expect.objectContaining({ code: "project-skill-limit" })]);
  });

  it("bounds aggregate snapshot memory across individually valid skills", async () => {
    const projectRoot = await fixture();
    await initializeScientProject({ root: projectRoot });
    for (let skillIndex = 0; skillIndex < 7; skillIndex += 1) {
      const skillRoot = await writeProjectSkill(projectRoot, `large-${String(skillIndex)}`);
      const assetsRoot = NodePath.join(skillRoot, "assets");
      await NodeFSP.mkdir(assetsRoot);
      await Promise.all(
        Array.from({ length: 5 }, (_, assetIndex) =>
          NodeFSP.writeFile(
            NodePath.join(assetsRoot, `${String(assetIndex)}.bin`),
            Buffer.alloc(800 * 1024, skillIndex),
          ),
        ),
      );
    }

    const catalog = await loadProjectSkillCatalog(projectRoot);

    expect(catalog.releases).toHaveLength(6);
    expect(catalog.diagnostics).toEqual([
      expect.objectContaining({ code: "project-skill-limit", path: ".scient/skills/large-6" }),
    ]);
  });
});
