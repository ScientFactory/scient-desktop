import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { inspectProjectFolder } from "./inspect.ts";
import { planProjectInitialization } from "./plan.ts";
import { renderAgentsMarkdown } from "./templates.ts";
import { makeTemporaryProject, TEST_IDENTITY } from "./testUtils.ts";
import {
  ProjectInitializationError,
  type BuiltInSkillDescriptor,
  type ProjectProfileDescriptor,
} from "./types.ts";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

async function deterministicPlan(root: string, profiles: readonly ProjectProfileDescriptor[] = []) {
  return planProjectInitialization({
    inspection: await inspectProjectFolder(root),
    request: {
      title: "  Example Project  ",
      purpose: "Test portable initialization.",
      profileIds: profiles.map((profile) => profile.id),
    },
    profiles,
    ...TEST_IDENTITY,
  });
}

describe("planProjectInitialization", () => {
  it("records an exact selected built-in identity without copying its body", async () => {
    const fixture = await makeTemporaryProject();
    cleanups.push(fixture.cleanup);
    const skill: BuiltInSkillDescriptor = {
      id: "scient.test-skill",
      version: "0.1.0",
      digest: `sha256:${"2".repeat(64)}`,
      origin: "scient:builtin",
      displayName: "Test Skill",
      description: "A test built-in skill.",
      role: "constructive",
      defaultSelected: false,
      readiness: "available",
      prerequisites: [],
      capabilities: { network: false, codeExecution: false, projectWrites: "proposal-only" },
    };

    const plan = await planProjectInitialization({
      inspection: await inspectProjectFolder(fixture.root),
      request: { skillIds: [skill.id] },
      builtInSkills: [skill],
      ...TEST_IDENTITY,
    });

    expect(plan.skillActivations).toEqual([
      { id: skill.id, version: skill.version, digest: skill.digest, origin: skill.origin },
    ]);
    const lock = plan.operations.find((operation) => operation.path === ".scient/skills.lock.json");
    expect(lock?.kind).toBe("create");
    if (lock?.kind !== "create") throw new Error("Expected skills lock create operation.");
    expect(JSON.parse(lock.contents)).toEqual({ formatVersion: 1, skills: plan.skillActivations });
    expect(lock.contents).not.toContain("A test built-in skill.");
  });

  it("renders a deterministic universal foundation with identity last", async () => {
    const fixture = await makeTemporaryProject();
    cleanups.push(fixture.cleanup);

    const plan = await deterministicPlan(fixture.root);

    expect(plan.status).toBe("ready");
    expect(plan.operations.map((operation) => [operation.kind, operation.path])).toEqual([
      ["create", "PROJECT.md"],
      ["create", "AGENTS.md"],
      ["create", ".scient/skills.lock.json"],
      ["create", ".scient/project.json"],
    ]);
    const identity = plan.operations.at(-1);
    expect(identity?.kind).toBe("create");
    if (identity?.kind !== "create") throw new Error("Expected identity create operation.");
    expect(JSON.parse(identity.contents)).toEqual({
      projectId: TEST_IDENTITY.projectId,
      formatVersion: 1,
      createdAt: TEST_IDENTITY.createdAt,
    });
    expect(identity.contents).not.toContain(fixture.root);
    expect(await readFile(path.join(fixture.root, "PROJECT.md")).catch(() => null)).toBeNull();
  });

  it("preserves PROJECT.md and proposes rather than applies AGENTS.md changes", async () => {
    const fixture = await makeTemporaryProject();
    cleanups.push(fixture.cleanup);
    await writeFile(path.join(fixture.root, "PROJECT.md"), "# Human project\n");
    await writeFile(path.join(fixture.root, "AGENTS.md"), "# Human instructions\n");

    const plan = await deterministicPlan(fixture.root);

    expect(plan.operations.map((operation) => [operation.kind, operation.path])).toEqual([
      ["preserve", "PROJECT.md"],
      ["propose", "AGENTS.md"],
      ["create", ".scient/skills.lock.json"],
      ["create", ".scient/project.json"],
    ]);
    const proposal = plan.operations.find((operation) => operation.kind === "propose");
    expect(proposal?.kind === "propose" ? proposal.contents : "").toContain("# Human instructions");
    expect(await readFile(path.join(fixture.root, "AGENTS.md"), "utf8")).toBe(
      "# Human instructions\n",
    );
  });

  it("preserves existing CRLF line endings in an AGENTS.md proposal", async () => {
    const fixture = await makeTemporaryProject();
    cleanups.push(fixture.cleanup);
    await writeFile(path.join(fixture.root, "AGENTS.md"), "# Windows Rules\r\n\r\nKeep this.\r\n");

    const plan = await deterministicPlan(fixture.root);
    const proposal = plan.operations.find((operation) => operation.kind === "propose");

    expect(proposal?.kind).toBe("propose");
    if (proposal?.kind !== "propose") throw new Error("Expected AGENTS.md proposal.");
    expect(proposal.contents).toContain("# Windows Rules\r\n\r\nKeep this.\r\n");
    expect(proposal.contents.replaceAll("\r\n", "")).not.toContain("\n");
  });

  it("preserves a compatible CRLF AGENTS.md without proposing a phantom change", async () => {
    const fixture = await makeTemporaryProject();
    cleanups.push(fixture.cleanup);
    await writeFile(
      path.join(fixture.root, "AGENTS.md"),
      renderAgentsMarkdown([]).replaceAll("\n", "\r\n"),
    );

    const plan = await deterministicPlan(fixture.root);

    expect(plan.operations).toContainEqual(
      expect.objectContaining({
        kind: "preserve",
        path: "AGENTS.md",
        reason: "Keep the existing compatible AGENTS.md unchanged.",
      }),
    );
  });

  it("replaces one legacy PapiLab managed block instead of appending a duplicate", async () => {
    const fixture = await makeTemporaryProject();
    cleanups.push(fixture.cleanup);
    await writeFile(
      path.join(fixture.root, "AGENTS.md"),
      [
        "# Human Rules",
        "",
        "<!-- papilab-managed:start template=1 -->",
        "",
        "## PapiLab Baseline",
        "",
        "- Legacy instruction.",
        "",
        "<!-- papilab-managed:end -->",
        "",
        "Keep this human text.",
        "",
      ].join("\n"),
    );

    const plan = await deterministicPlan(fixture.root);
    const proposal = plan.operations.find((operation) => operation.kind === "propose");

    expect(proposal?.kind).toBe("propose");
    if (proposal?.kind !== "propose") throw new Error("Expected AGENTS.md proposal.");
    expect(proposal.contents).toContain("<!-- scient-managed:start template=1 -->");
    expect(proposal.contents).not.toContain("papilab-managed");
    expect(proposal.contents).toContain("Keep this human text.");
  });

  it("blocks top-level file symlink conflicts", async () => {
    const fixture = await makeTemporaryProject();
    const outside = await makeTemporaryProject();
    cleanups.push(fixture.cleanup, outside.cleanup);
    await writeFile(path.join(outside.root, "PROJECT.md"), "outside\n");
    await symlink(path.join(outside.root, "PROJECT.md"), path.join(fixture.root, "PROJECT.md"));

    const plan = await deterministicPlan(fixture.root);

    expect(plan.status).toBe("blocked");
    expect(plan.operations).toContainEqual(
      expect.objectContaining({ kind: "conflict", path: "PROJECT.md" }),
    );
  });

  it("allows retry planning for an empty partial metadata directory", async () => {
    const fixture = await makeTemporaryProject();
    cleanups.push(fixture.cleanup);
    await mkdir(path.join(fixture.root, ".scient"));

    const plan = await deterministicPlan(fixture.root);

    expect(plan.status).toBe("ready");
  });

  it("returns the existing identity without planning writes", async () => {
    const fixture = await makeTemporaryProject();
    cleanups.push(fixture.cleanup);
    await mkdir(path.join(fixture.root, ".scient"));
    await writeFile(path.join(fixture.root, "PROJECT.md"), "# Existing\n");
    await writeFile(path.join(fixture.root, "AGENTS.md"), "# Existing\n");
    await writeFile(
      path.join(fixture.root, ".scient/project.json"),
      `${JSON.stringify({
        projectId: TEST_IDENTITY.projectId,
        formatVersion: 1,
        createdAt: TEST_IDENTITY.createdAt,
      })}\n`,
    );

    const plan = await deterministicPlan(fixture.root);

    expect(plan.status).toBe("already-initialized");
    expect(plan.projectId).toBe(TEST_IDENTITY.projectId);
    expect(plan.operations.map((operation) => [operation.kind, operation.path])).toEqual([
      ["preserve", "PROJECT.md"],
      ["propose", "AGENTS.md"],
    ]);
  });

  it("rejects multiline project titles instead of injecting Markdown structure", async () => {
    const fixture = await makeTemporaryProject();
    cleanups.push(fixture.cleanup);

    await expect(
      planProjectInitialization({
        inspection: await inspectProjectFolder(fixture.root),
        request: { title: "Valid title\n# Injected heading" },
        ...TEST_IDENTITY,
      }),
    ).rejects.toMatchObject({ code: "INVALID_REQUEST" });
  });

  it("proves the profile extension with data-only fixture content", async () => {
    const fixture = await makeTemporaryProject();
    cleanups.push(fixture.cleanup);
    const profile: ProjectProfileDescriptor = {
      id: "test-analysis",
      version: 2,
      displayName: "Test Analysis",
      projectSections: [{ heading: "Analysis Approach", prompt: "Describe the approach." }],
      managedAgentInstructions: ["Keep units explicit."],
      files: [{ path: "analysis/NOTES.md", contents: "# Analysis Notes\n" }],
    };

    const plan = await deterministicPlan(fixture.root, [profile]);

    expect(plan.profileVersions).toEqual({ "test-analysis": 2 });
    expect(plan.operations).toContainEqual(
      expect.objectContaining({ kind: "create", path: "analysis/NOTES.md" }),
    );
    const project = plan.operations.find((operation) => operation.path === "PROJECT.md");
    const agents = plan.operations.find((operation) => operation.path === "AGENTS.md");
    expect(project?.kind === "create" ? project.contents : "").toContain("## Analysis Approach");
    expect(agents?.kind === "create" ? agents.contents : "").toContain("Keep units explicit");
  });

  it("rejects profile traversal and universal-file replacement", async () => {
    const fixture = await makeTemporaryProject();
    cleanups.push(fixture.cleanup);
    const invalidPaths = [
      "../escape.md",
      "/absolute.md",
      "PROJECT.md",
      "project.md",
      ".SCIENT/secret",
      "notes/CON.txt",
      "notes/trailing. ",
      "notes/question?.md",
    ];
    for (const invalidPath of invalidPaths) {
      await expect(
        deterministicPlan(fixture.root, [
          {
            id: "invalid-profile",
            version: 1,
            displayName: "Invalid",
            files: [{ path: invalidPath, contents: "no\n" }],
          },
        ]),
      ).rejects.toBeInstanceOf(ProjectInitializationError);
    }
  });

  it("rejects profiles that duplicate universal headings or inject multiline instructions", async () => {
    const fixture = await makeTemporaryProject();
    cleanups.push(fixture.cleanup);
    for (const profile of [
      {
        id: "duplicate-purpose",
        version: 1,
        displayName: "Duplicate Purpose",
        projectSections: [{ heading: "Purpose" }],
      },
      {
        id: "multiline-instruction",
        version: 1,
        displayName: "Multiline Instruction",
        managedAgentInstructions: ["First line\n## Injected section"],
      },
    ] satisfies readonly ProjectProfileDescriptor[]) {
      await expect(deterministicPlan(fixture.root, [profile])).rejects.toMatchObject({
        code: "INVALID_PROFILE",
      });
    }
  });

  it("rejects cross-profile file collisions case-insensitively", async () => {
    const fixture = await makeTemporaryProject();
    cleanups.push(fixture.cleanup);
    const profiles: readonly ProjectProfileDescriptor[] = [
      {
        id: "profile-one",
        version: 1,
        displayName: "One",
        files: [{ path: "Notes/README.md", contents: "one\n" }],
      },
      {
        id: "profile-two",
        version: 1,
        displayName: "Two",
        files: [{ path: "notes/readme.md", contents: "two\n" }],
      },
    ];

    await expect(deterministicPlan(fixture.root, profiles)).rejects.toMatchObject({
      code: "INVALID_PROFILE",
    });
  });

  it("rejects profile file collisions across Unicode normalization forms", async () => {
    const fixture = await makeTemporaryProject();
    cleanups.push(fixture.cleanup);
    const profile: ProjectProfileDescriptor = {
      id: "unicode-collision",
      version: 1,
      displayName: "Unicode collision",
      files: [
        { path: "notes/caf\u00e9.md", contents: "one\n" },
        { path: "notes/cafe\u0301.md", contents: "two\n" },
      ],
    };

    await expect(deterministicPlan(fixture.root, [profile])).rejects.toMatchObject({
      code: "INVALID_PROFILE",
    });
  });

  it("allows safe path segments whose names begin with two dots", async () => {
    const fixture = await makeTemporaryProject();
    cleanups.push(fixture.cleanup);
    const profile: ProjectProfileDescriptor = {
      id: "dot-prefix",
      version: 1,
      displayName: "Dot prefix",
      files: [{ path: "..notes/README.md", contents: "# Notes\n" }],
    };

    const plan = await deterministicPlan(fixture.root, [profile]);

    expect(plan.status).toBe("ready");
    expect(plan.operations).toContainEqual(
      expect.objectContaining({ kind: "create", path: "..notes/README.md" }),
    );
  });

  it("rejects profile file and directory paths that overlap", async () => {
    const fixture = await makeTemporaryProject();
    cleanups.push(fixture.cleanup);
    const profiles: readonly ProjectProfileDescriptor[] = [
      {
        id: "profile-one",
        version: 1,
        displayName: "One",
        files: [{ path: "analysis", contents: "not a directory\n" }],
      },
      {
        id: "profile-two",
        version: 1,
        displayName: "Two",
        files: [{ path: "analysis/NOTES.md", contents: "notes\n" }],
      },
    ];

    await expect(deterministicPlan(fixture.root, profiles)).rejects.toMatchObject({
      code: "INVALID_PROFILE",
    });
  });

  it("rejects duplicate project sections across selected profiles", async () => {
    const fixture = await makeTemporaryProject();
    cleanups.push(fixture.cleanup);
    const profiles: readonly ProjectProfileDescriptor[] = [
      {
        id: "profile-one",
        version: 1,
        displayName: "One",
        projectSections: [{ heading: "Analysis Approach" }],
      },
      {
        id: "profile-two",
        version: 1,
        displayName: "Two",
        projectSections: [{ heading: "analysis approach" }],
      },
    ];

    await expect(deterministicPlan(fixture.root, profiles)).rejects.toMatchObject({
      code: "INVALID_PROFILE",
    });
  });

  it("blocks portable-name collisions with an existing foundation file", async () => {
    const fixture = await makeTemporaryProject();
    cleanups.push(fixture.cleanup);
    await writeFile(path.join(fixture.root, "project.md"), "# Lowercase project\n");

    const plan = await deterministicPlan(fixture.root);

    expect(plan.status).toBe("blocked");
    expect(plan.operations).toContainEqual(
      expect.objectContaining({ kind: "conflict", path: "PROJECT.md" }),
    );
  });
});
