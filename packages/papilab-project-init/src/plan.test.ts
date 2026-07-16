import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { inspectProjectFolder } from "./inspect.ts";
import { planProjectInitialization } from "./plan.ts";
import { makeTemporaryProject, TEST_IDENTITY } from "./testUtils.ts";
import { ProjectInitializationError, type ProjectProfileDescriptor } from "./types.ts";

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
  it("renders a deterministic universal foundation with identity last", async () => {
    const fixture = await makeTemporaryProject();
    cleanups.push(fixture.cleanup);

    const plan = await deterministicPlan(fixture.root);

    expect(plan.status).toBe("ready");
    expect(plan.operations.map((operation) => [operation.kind, operation.path])).toEqual([
      ["create", "PROJECT.md"],
      ["create", "AGENTS.md"],
      ["create", ".papilab/project.json"],
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
      ["create", ".papilab/project.json"],
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
    await mkdir(path.join(fixture.root, ".papilab"));

    const plan = await deterministicPlan(fixture.root);

    expect(plan.status).toBe("ready");
  });

  it("returns the existing identity without planning writes", async () => {
    const fixture = await makeTemporaryProject();
    cleanups.push(fixture.cleanup);
    await mkdir(path.join(fixture.root, ".papilab"));
    await writeFile(path.join(fixture.root, "PROJECT.md"), "# Existing\n");
    await writeFile(path.join(fixture.root, "AGENTS.md"), "# Existing\n");
    await writeFile(
      path.join(fixture.root, ".papilab/project.json"),
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
    const invalidPaths = ["../escape.md", "/absolute.md", "PROJECT.md", ".papilab/secret"];
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
});
