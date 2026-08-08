// @effect-diagnostics nodeBuiltinImport:off -- These tests exercise the real filesystem boundary.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, describe, expect, it } from "@effect/vitest";

import {
  initializeScientProject,
  inspectScientProject,
  SCIENT_AGENTS_FILE,
  SCIENT_IDENTITY_FILE,
  SCIENT_PREVIOUS_TRANSACTION_FILE,
  SCIENT_PROJECT_FILE,
  SCIENT_TRANSACTION_FILE,
  renderAgentsTemplate,
  renderProjectTemplate,
} from "./index.ts";

const fixtures: string[] = [];

const hash = (content: string) => NodeCrypto.createHash("sha256").update(content).digest("hex");
const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;

async function fixture(): Promise<string> {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "scient-project-init-"));
  fixtures.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(
    fixtures.splice(0).map((root) => NodeFSP.rm(root, { recursive: true, force: true })),
  );
});

describe("Scient project initialization", () => {
  it("starts with broad project guidance without choosing the project's domain", () => {
    const project = renderProjectTemplate("My project");
    const agents = renderAgentsTemplate();

    expect(project).toContain("# My project");
    expect(project).toContain("## Current focus");
    expect(project).toContain("## Continuation notes");
    expect(project).toContain("Remove guidance comments");
    expect(agents).toContain("Follow explicit user instructions");
    expect(agents).toContain("first-principles reasoning");
    expect(agents).toContain("do not update them automatically after every task");
    expect(`${project}\n${agents}`).not.toMatch(/scientific domain|scientific project/iu);
  });

  it("expands a home-relative root before inspecting it", async () => {
    const directoryName = `.scient-project-init-missing-${NodeCrypto.randomUUID()}`;
    const inspection = await inspectScientProject(`~/${directoryName}`);

    expect(inspection.root).toBe(NodePath.join(NodeOS.homedir(), directoryName));
    await expect(NodeFSP.stat(inspection.root)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("creates the portable foundation and removes the transaction after writing identity", async () => {
    const root = await fixture();
    expect((await inspectScientProject(root)).state).toBe("ordinary");

    const result = await initializeScientProject({ root, title: "My study" });

    expect(result.state).toBe("initialized");
    expect(result.created).toEqual([SCIENT_PROJECT_FILE, SCIENT_AGENTS_FILE, SCIENT_IDENTITY_FILE]);
    expect(await NodeFSP.readFile(NodePath.join(root, SCIENT_PROJECT_FILE), "utf8")).toContain(
      "# My study",
    );
    expect(await NodeFSP.readFile(NodePath.join(root, SCIENT_AGENTS_FILE), "utf8")).toContain(
      "Preserve user-authored context and instructions",
    );
    expect(
      JSON.parse(await NodeFSP.readFile(NodePath.join(root, SCIENT_IDENTITY_FILE), "utf8")),
    ).toMatchObject({ formatVersion: 1 });
    await expect(
      NodeFSP.readFile(NodePath.join(root, SCIENT_TRANSACTION_FILE), "utf8"),
    ).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("preserves existing project and agent documents byte for byte", async () => {
    const root = await fixture();
    await NodeFSP.writeFile(NodePath.join(root, SCIENT_PROJECT_FILE), "# Human project\n", "utf8");
    await NodeFSP.writeFile(NodePath.join(root, SCIENT_AGENTS_FILE), "# Human rules\n", "utf8");

    const result = await initializeScientProject({ root });

    expect(result.created).toEqual([SCIENT_IDENTITY_FILE]);
    expect(result.preserved).toEqual([SCIENT_PROJECT_FILE, SCIENT_AGENTS_FILE]);
    expect(await NodeFSP.readFile(NodePath.join(root, SCIENT_PROJECT_FILE), "utf8")).toBe(
      "# Human project\n",
    );
    expect(await NodeFSP.readFile(NodePath.join(root, SCIENT_AGENTS_FILE), "utf8")).toBe(
      "# Human rules\n",
    );
  });

  it("is idempotent and returns the same durable identity", async () => {
    const root = await fixture();
    await initializeScientProject({ root });
    const identity = await NodeFSP.readFile(NodePath.join(root, SCIENT_IDENTITY_FILE), "utf8");

    const second = await initializeScientProject({ root, title: "A different title" });

    expect(second.state).toBe("initialized");
    expect(second.created).toEqual([]);
    expect(await NodeFSP.readFile(NodePath.join(root, SCIENT_IDENTITY_FILE), "utf8")).toBe(
      identity,
    );
  });

  it("refuses to replace an invalid existing identity", async () => {
    const root = await fixture();
    const identityPath = NodePath.join(root, SCIENT_IDENTITY_FILE);
    await NodeFSP.mkdir(NodePath.dirname(identityPath));
    await NodeFSP.writeFile(identityPath, "not json\n", "utf8");

    const result = await initializeScientProject({ root });

    expect(result.state).toBe("conflicting");
    expect(result.created).toEqual([]);
    expect(await NodeFSP.readFile(identityPath, "utf8")).toBe("not json\n");
  });

  it("recognizes the compatible identity written by the previous Scient app", async () => {
    const root = await fixture();
    await NodeFSP.mkdir(NodePath.join(root, ".scient"));
    await NodeFSP.writeFile(
      NodePath.join(root, SCIENT_IDENTITY_FILE),
      `${JSON.stringify({
        projectId: "0e193b71-9477-43da-bd4c-17440c455acf",
        formatVersion: 1,
        createdAt: "2026-08-07T08:00:00.000Z",
      })}\n`,
      "utf8",
    );

    expect((await inspectScientProject(root)).state).toBe("initialized");
  });

  it("coalesces concurrent initialization attempts", async () => {
    const root = await fixture();
    const [first, second] = await Promise.all([
      initializeScientProject({ root }),
      initializeScientProject({ root }),
    ]);

    expect(first).toEqual(second);
    expect((await inspectScientProject(root)).state).toBe("initialized");
  });

  it("recovers an interrupted setup only when its pending files are unchanged", async () => {
    const root = await fixture();
    const identity = {
      projectId: "b2e64d52-665d-46fb-869c-1adbdcab3487",
      formatVersion: 1,
      createdAt: "2026-08-07T08:00:00.000Z",
    };
    const project = "# Recovered study\n";
    const agents = "# Project agent guidance\n";
    await NodeFSP.mkdir(NodePath.join(root, ".scient"));
    await NodeFSP.writeFile(
      NodePath.join(root, SCIENT_TRANSACTION_FILE),
      `${JSON.stringify(
        {
          schemaVersion: 1,
          operationId: "6da0c02a-d740-4601-9f91-f285df4663f6",
          createdAt: "2026-08-07T08:00:00.000Z",
          title: "Recovered study",
          identity,
          files: [
            { path: SCIENT_PROJECT_FILE, content: project, sha256: hash(project) },
            { path: SCIENT_AGENTS_FILE, content: agents, sha256: hash(agents) },
          ],
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    expect((await inspectScientProject(root)).state).toBe("recoverable");
    const result = await initializeScientProject({ root });

    expect(result.state).toBe("initialized");
    expect(result.created).toEqual([SCIENT_PROJECT_FILE, SCIENT_AGENTS_FILE, SCIENT_IDENTITY_FILE]);
    expect(await NodeFSP.readFile(NodePath.join(root, SCIENT_IDENTITY_FILE), "utf8")).toContain(
      identity.projectId,
    );
  });

  it("finishes recovery when identity was written before the transaction was removed", async () => {
    const root = await fixture();
    const identity = {
      projectId: "8ea269ae-77fe-4325-bbb5-7a674e84412b",
      formatVersion: 1,
      createdAt: "2026-08-07T08:00:00.000Z",
    } as const;
    const project = "# Recovered project\n";
    const agents = "# Project agent guidance\n";
    const transaction = {
      schemaVersion: 1,
      operationId: "60566b72-884b-43a8-ada5-7b56efbfc7b2",
      createdAt: "2026-08-07T08:00:00.000Z",
      title: "Recovered project",
      identity,
      files: [
        { path: SCIENT_PROJECT_FILE, content: project, sha256: hash(project) },
        { path: SCIENT_AGENTS_FILE, content: agents, sha256: hash(agents) },
      ],
    };
    await NodeFSP.mkdir(NodePath.join(root, ".scient"));
    await Promise.all([
      NodeFSP.writeFile(NodePath.join(root, SCIENT_PROJECT_FILE), project, "utf8"),
      NodeFSP.writeFile(NodePath.join(root, SCIENT_AGENTS_FILE), agents, "utf8"),
      NodeFSP.writeFile(NodePath.join(root, SCIENT_IDENTITY_FILE), json(identity), "utf8"),
      NodeFSP.writeFile(NodePath.join(root, SCIENT_TRANSACTION_FILE), json(transaction), "utf8"),
    ]);

    expect((await inspectScientProject(root)).state).toBe("recoverable");
    const result = await initializeScientProject({ root });

    expect(result.state).toBe("initialized");
    expect(result.created).toEqual([]);
    expect(result.preserved).toEqual([
      SCIENT_PROJECT_FILE,
      SCIENT_AGENTS_FILE,
      SCIENT_IDENTITY_FILE,
    ]);
    await expect(NodeFSP.stat(NodePath.join(root, SCIENT_TRANSACTION_FILE))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("reports a conflicting identity before retrying interrupted setup", async () => {
    const root = await fixture();
    const transactionIdentity = {
      projectId: "1c5eecf4-28b4-47ba-8342-5ea7e837634c",
      formatVersion: 1,
      createdAt: "2026-08-07T08:00:00.000Z",
    } as const;
    const existingIdentity = {
      ...transactionIdentity,
      createdAt: "2026-08-07T09:00:00.000Z",
    };
    const transaction = {
      schemaVersion: 1,
      operationId: "75c60a5d-e3ce-4f20-8e81-76452d989d43",
      createdAt: "2026-08-07T08:00:00.000Z",
      title: "Interrupted project",
      identity: transactionIdentity,
      files: [],
    };
    await NodeFSP.mkdir(NodePath.join(root, ".scient"));
    await Promise.all([
      NodeFSP.writeFile(NodePath.join(root, SCIENT_IDENTITY_FILE), json(existingIdentity), "utf8"),
      NodeFSP.writeFile(NodePath.join(root, SCIENT_TRANSACTION_FILE), json(transaction), "utf8"),
    ]);

    const inspection = await inspectScientProject(root);
    const result = await initializeScientProject({ root });

    expect(inspection.state).toBe("conflicting");
    expect(inspection.issues).toContainEqual({
      path: SCIENT_IDENTITY_FILE,
      message: "The project identity does not exactly match the interrupted setup record.",
    });
    expect(result.state).toBe("conflicting");
    expect(await NodeFSP.readFile(NodePath.join(root, SCIENT_TRANSACTION_FILE), "utf8")).toBe(
      json(transaction),
    );
  });

  it("stops recovery when a pending project file was changed", async () => {
    const root = await fixture();
    const expected = "# Expected setup\n";
    await NodeFSP.mkdir(NodePath.join(root, ".scient"));
    await NodeFSP.writeFile(
      NodePath.join(root, SCIENT_PROJECT_FILE),
      "# User replacement\n",
      "utf8",
    );
    await NodeFSP.writeFile(
      NodePath.join(root, SCIENT_TRANSACTION_FILE),
      `${JSON.stringify(
        {
          schemaVersion: 1,
          operationId: "5b111563-771f-4c3c-b0bf-4c9b96aa7e2b",
          createdAt: "2026-08-07T08:00:00.000Z",
          title: "Expected setup",
          identity: {
            projectId: "e8d4c664-f547-4c09-bc79-2c76916fc4ec",
            formatVersion: 1,
            createdAt: "2026-08-07T08:00:00.000Z",
          },
          files: [{ path: SCIENT_PROJECT_FILE, content: expected, sha256: hash(expected) }],
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    const inspection = await inspectScientProject(root);
    const result = await initializeScientProject({ root });

    expect(inspection.state).toBe("conflicting");
    expect(result.state).toBe("conflicting");
    expect(result.created).toEqual([]);
    expect(await NodeFSP.readFile(NodePath.join(root, SCIENT_PROJECT_FILE), "utf8")).toBe(
      "# User replacement\n",
    );
  });

  it("refuses metadata symlinks and unfinished transactions from the previous app", async () => {
    const root = await fixture();
    const outside = await fixture();
    await NodeFSP.symlink(outside, NodePath.join(root, ".scient"));

    expect((await inspectScientProject(root)).state).toBe("conflicting");

    await NodeFSP.rm(NodePath.join(root, ".scient"));
    await NodeFSP.mkdir(NodePath.join(root, ".scient"));
    await NodeFSP.writeFile(NodePath.join(root, SCIENT_PREVIOUS_TRANSACTION_FILE), "{}\n", "utf8");

    const inspection = await inspectScientProject(root);
    expect(inspection.state).toBe("conflicting");
    expect(inspection.issues[0]?.path).toBe(SCIENT_PREVIOUS_TRANSACTION_FILE);
  });
});
