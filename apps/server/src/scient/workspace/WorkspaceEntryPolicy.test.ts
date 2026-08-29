import { describe, expect, it } from "vite-plus/test";

import {
  type WorkspaceEntryDisposition,
  workspaceEntryDisposition,
} from "./WorkspaceEntryPolicy.ts";

const ordinaryFiles = (reasonCode: string): WorkspaceEntryDisposition => ({
  visibility: "ordinary",
  mutation: "files",
  reasonCode,
});

const ordinaryOwner = (reasonCode: string): WorkspaceEntryDisposition => ({
  visibility: "ordinary",
  mutation: "owner",
  reasonCode,
});

const internalOwner = (reasonCode: string): WorkspaceEntryDisposition => ({
  visibility: "internal",
  mutation: "owner",
  reasonCode,
});

describe("workspaceEntryDisposition", () => {
  it.each([
    ["README.md", ordinaryFiles("workspace.project-material")],
    [".env", ordinaryFiles("workspace.project-material")],
    [".env.local", ordinaryFiles("workspace.project-material")],
    [".github/workflows/ci.yml", ordinaryFiles("workspace.project-material")],
    [".github-notes/decision.md", ordinaryFiles("workspace.project-material")],
    ["data/results.csv", ordinaryFiles("workspace.project-material")],
    ["build/report.pdf", ordinaryFiles("workspace.project-material")],
    ["target/figure.svg", ordinaryFiles("workspace.project-material")],
    ["vendor/paper.txt", ordinaryFiles("workspace.project-material")],
    ["cache/notes.md", ordinaryFiles("workspace.project-material")],
    [".scient", ordinaryOwner("scient.container")],
    [".scient/project.json", ordinaryOwner("scient.project-identity")],
    [".scient/skills.lock.json", ordinaryOwner("scient.skills-lock")],
    [".scient/skills/review/SKILL.md", ordinaryFiles("scient.project-skill")],
    [".scient/notes.md", ordinaryFiles("scient.unknown-project-material")],
    [".git/config", internalOwner("tool.git")],
    ["packages/app/.svn/entries", internalOwner("tool.svn")],
    ["node_modules/pkg/index.js", internalOwner("dependency.node-modules")],
    ["packages/app/.yarn/cache/pkg.zip", internalOwner("dependency.yarn-cache")],
    ["analysis/.venv/bin/python", internalOwner("dependency.python-venv")],
    ["analysis/__pycache__/model.pyc", internalOwner("cache.python-bytecode")],
    ["figures/.DS_Store", internalOwner("os.metadata")],
    [".scient-next/userdata/state.sqlite", internalOwner("scient.runtime-state")],
    [".scient/project-init.json", internalOwner("scient.project-transaction")],
    [".scient/init-transaction.json", internalOwner("scient.project-transaction")],
    [".scient/sources/records/source.json", internalOwner("scient.sources-store")],
    [".scient/sources/files/sha256/ab/paper.pdf", internalOwner("scient.sources-store")],
  ] satisfies ReadonlyArray<readonly [string, WorkspaceEntryDisposition]>)(
    "classifies %s without broad name heuristics",
    (relativePath, expected) => {
      expect(workspaceEntryDisposition(relativePath)).toEqual(expected);
    },
  );

  it("normalizes Windows separators without treating lookalikes as internals", () => {
    expect(workspaceEntryDisposition("packages\\app\\node_modules\\pkg")).toEqual(
      internalOwner("dependency.node-modules"),
    );
    expect(workspaceEntryDisposition("notes\\.git-history.md")).toEqual(
      ordinaryFiles("workspace.project-material"),
    );
  });

  it("defaults unknown in-workspace material to visible and Files-owned", () => {
    expect(workspaceEntryDisposition(".unknown/cache/history.json")).toEqual(
      ordinaryFiles("workspace.project-material"),
    );
    expect(workspaceEntryDisposition(".scient/future-subsystem/evidence.json")).toEqual(
      ordinaryFiles("scient.unknown-project-material"),
    );
  });
});
