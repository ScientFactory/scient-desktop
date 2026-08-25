// @effect-diagnostics nodeBuiltinImport:off -- Tests exercise the real skill release filesystem boundary.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterEach, describe, expect, it } from "@effect/vitest";

import {
  catalogByReleaseKey,
  loadEmbeddedSkillRelease,
  loadSkillCatalog,
  loadSkillRelease,
  parseSkillDocument,
  parseSkillReleaseManifest,
  readSkillResource,
  skillReleaseKey,
} from "./index.ts";

const fixtures: string[] = [];

async function fixture(): Promise<string> {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "scient-skill-release-"));
  fixtures.push(root);
  return root;
}

async function writeRelease(
  parent: string,
  input: {
    readonly directoryName?: string;
    readonly id?: string;
    readonly version?: string;
    readonly name?: string;
    readonly origin?: unknown;
  } = {},
): Promise<string> {
  const directoryName = input.directoryName ?? "evidence-review";
  const root = NodePath.join(parent, directoryName);
  await NodeFSP.mkdir(NodePath.join(root, "references"), { recursive: true });
  await NodeFSP.writeFile(
    NodePath.join(root, "SKILL.md"),
    `---\nname: ${input.name ?? directoryName}\ndescription: Reviews evidence and reports bounded findings. Use for evidence review.\nmetadata:\n  author: ScientFactory\nallowed-tools: Bash(git:*)\n---\n\n# Evidence review\n\nRead [the rubric](references/rubric.md).\n`,
    "utf8",
  );
  await NodeFSP.writeFile(
    NodePath.join(root, "scient.skill.json"),
    `${JSON.stringify(
      {
        apiVersion: "scient.skills/v1alpha1",
        id: input.id ?? "scient.evidence-review",
        version: input.version ?? "0.1.0",
        category: "Evidence",
        categoryDescription: "Review evidence carefully.",
        displayOrder: 100,
        supportedScopes: ["project"],
        defaultInvocationPolicy: "automatic",
        origin: input.origin ?? { kind: "scient" },
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  await NodeFSP.writeFile(
    NodePath.join(root, "references", "rubric.md"),
    "Check support, contradiction, and uncertainty.\n",
    "utf8",
  );
  return root;
}

afterEach(async () => {
  await Promise.all(
    fixtures.splice(0).map((root) => NodeFSP.rm(root, { recursive: true, force: true })),
  );
});

describe("Scient skill releases", () => {
  it("validates current Agent Skills naming and optional metadata", () => {
    expect(() =>
      parseSkillDocument(
        "---\nname: review--evidence\ndescription: Invalid name.\n---\nInstructions\n",
        "review--evidence",
      ),
    ).toThrow("without consecutive hyphens");
    expect(() =>
      parseSkillDocument(
        "---\nname: review-evidence\ndescription: Valid metadata.\n---\nInstructions\n",
        "different-directory",
      ),
    ).toThrow("match its parent directory");
  });

  it("loads an immutable release with a reproducible digest and complete resources", async () => {
    const parent = await fixture();
    const root = await writeRelease(parent);
    const first = await loadSkillRelease(root);
    const second = await loadSkillRelease(root);

    expect(first.digest).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(second.digest).toBe(first.digest);
    expect(first.origin).toBe("scient");
    expect(first.category).toBe("Evidence");
    expect(first.categoryDescription).toBe("Review evidence carefully.");
    expect(first.displayOrder).toBe(100);
    expect(first.metadata.allowedTools).toBe("Bash(git:*)");
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.manifest)).toBe(true);
    expect(Object.isFrozen(first.resources)).toBe(true);
    expect("files" in first).toBe(false);
    expect(first.resources).toEqual([
      { path: "references/rubric.md", bytes: 47, kind: "reference" },
    ]);
    expect(
      Buffer.from(readSkillResource(first, "references/rubric.md") ?? []).toString("utf8"),
    ).toContain("uncertainty");
    expect(readSkillResource(first, "../SKILL.md")).toBeUndefined();
    expect(readSkillResource(first, "SKILL.md")).toBeUndefined();
  });

  it("serves the verified snapshot even if the source is modified later", async () => {
    const parent = await fixture();
    const root = await writeRelease(parent);
    const release = await loadSkillRelease(root);
    await NodeFSP.writeFile(NodePath.join(root, "references", "rubric.md"), "changed\n", "utf8");

    expect(
      Buffer.from(readSkillResource(release, "references/rubric.md") ?? []).toString("utf8"),
    ).toBe("Check support, contradiction, and uncertainty.\n");
  });

  it("copies embedded bytes before exposing the immutable release", () => {
    const resource = new TextEncoder().encode("original\n");
    const release = loadEmbeddedSkillRelease("embedded-review", {
      "SKILL.md":
        "---\nname: embedded-review\ndescription: Reviews an embedded release.\n---\nInstructions\n",
      "scient.skill.json": JSON.stringify({
        apiVersion: "scient.skills/v1alpha1",
        id: "scient.embedded-review",
        version: "0.1.0",
        category: "Evidence",
        categoryDescription: "Review evidence carefully.",
        displayOrder: 100,
        supportedScopes: ["user"],
        defaultInvocationPolicy: "explicit",
        origin: { kind: "scient" },
      }),
      "references/note.md": resource,
    });
    resource.fill(0);

    expect(
      Buffer.from(readSkillResource(release, "references/note.md") ?? []).toString("utf8"),
    ).toBe("original\n");
  });

  it("rejects symlinks instead of following content outside the release", async () => {
    const parent = await fixture();
    const root = await writeRelease(parent);
    const outside = NodePath.join(parent, "outside.txt");
    await NodeFSP.writeFile(outside, "secret\n", "utf8");
    await NodeFSP.symlink(outside, NodePath.join(root, "references", "outside.txt"));

    await expect(loadSkillRelease(root)).rejects.toThrow("must not be a symbolic link");
  });

  it("rejects a symlink used as the release root", async () => {
    const parent = await fixture();
    const root = await writeRelease(parent);
    const linkedRoot = NodePath.join(parent, "linked-release");
    await NodeFSP.symlink(root, linkedRoot);

    await expect(loadSkillRelease(linkedRoot)).rejects.toThrow("root must be a real directory");
  });

  it("accepts exact SemVer and rejects loose or malformed versions", async () => {
    const parent = await fixture();
    const valid = await writeRelease(NodePath.join(parent, "valid"), {
      version: "1.2.3-beta.1+build.7",
    });
    const loose = await writeRelease(NodePath.join(parent, "loose"), {
      directoryName: "loose-version",
      id: "scient.loose-version",
      version: "01.2.3",
    });

    await expect(loadSkillRelease(valid)).resolves.toMatchObject({
      version: "1.2.3-beta.1+build.7",
    });
    await expect(loadSkillRelease(loose)).rejects.toThrow("invalid id or version");
  });

  it("enforces bounded instruction, manifest, file, and release sizes", async () => {
    expect(() =>
      parseSkillDocument(
        `---\nname: bounded\ndescription: Bounded.\n---\n${"x".repeat(256 * 1024)}`,
        "bounded",
      ),
    ).toThrow("256 KiB");
    expect(() =>
      parseSkillReleaseManifest(JSON.stringify({ padding: "x".repeat(64 * 1024) })),
    ).toThrow("64 KiB");

    const oversizedParent = await fixture();
    const oversizedRoot = await writeRelease(oversizedParent);
    await NodeFSP.mkdir(NodePath.join(oversizedRoot, "assets"));
    await NodeFSP.writeFile(
      NodePath.join(oversizedRoot, "assets", "oversized.bin"),
      Buffer.alloc(1024 * 1024 + 1),
    );
    await expect(loadSkillRelease(oversizedRoot)).rejects.toThrow("1 MiB file limit");

    const crowdedParent = await fixture();
    const crowdedRoot = await writeRelease(crowdedParent);
    await NodeFSP.mkdir(NodePath.join(crowdedRoot, "assets"));
    await Promise.all(
      Array.from({ length: 198 }, (_, index) =>
        NodeFSP.writeFile(NodePath.join(crowdedRoot, "assets", `${String(index)}.txt`), "x"),
      ),
    );
    await expect(loadSkillRelease(crowdedRoot)).rejects.toThrow("more than 200 files");

    const largeParent = await fixture();
    const largeRoot = await writeRelease(largeParent);
    await NodeFSP.mkdir(NodePath.join(largeRoot, "assets"));
    await Promise.all(
      Array.from({ length: 6 }, (_, index) =>
        NodeFSP.writeFile(
          NodePath.join(largeRoot, "assets", `${String(index)}.bin`),
          Buffer.alloc(900 * 1024),
        ),
      ),
    );
    await expect(loadSkillRelease(largeRoot)).rejects.toThrow("5 MiB total limit");
  });

  it("digests identical release bytes independently of file creation order", async () => {
    const firstParent = await fixture();
    const secondParent = await fixture();
    const firstRoot = await writeRelease(firstParent);
    const secondRoot = await writeRelease(secondParent);
    await NodeFSP.writeFile(NodePath.join(firstRoot, "references", "a.md"), "A\n");
    await NodeFSP.writeFile(NodePath.join(firstRoot, "references", "z.md"), "Z\n");
    await NodeFSP.writeFile(NodePath.join(secondRoot, "references", "z.md"), "Z\n");
    await NodeFSP.writeFile(NodePath.join(secondRoot, "references", "a.md"), "A\n");

    expect((await loadSkillRelease(firstRoot)).digest).toBe(
      (await loadSkillRelease(secondRoot)).digest,
    );
  });

  it("quarantines malformed and duplicate releases without losing valid releases", async () => {
    const parent = await fixture();
    const valid = await writeRelease(NodePath.join(parent, "one"));
    const duplicate = await writeRelease(NodePath.join(parent, "two"));
    const invalid = await writeRelease(NodePath.join(parent, "three"), {
      directoryName: "invalid",
      name: "different",
      id: "scient.invalid",
    });

    const catalog = await loadSkillCatalog([invalid, duplicate, valid]);

    expect(catalog.releases).toHaveLength(1);
    expect(catalog.diagnostics.map((diagnostic) => diagnostic.code).sort()).toEqual([
      "duplicate-release",
      "invalid-release",
    ]);
    expect(catalogByReleaseKey(catalog).get(skillReleaseKey(catalog.releases[0]!))).toBe(
      catalog.releases[0],
    );
  });
});
