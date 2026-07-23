// FILE: Sidebar.import.test.ts
// Purpose: Smoke-test that the large Sidebar module still imports after project-run wiring.
// Layer: Web component module test
// Depends on: Vitest module mocking and Sidebar's transitive imports.

import { readFileSync } from "node:fs";

import { ProjectId } from "@synara/contracts";
import { describe, expect, it, vi } from "vitest";

vi.mock("./terminal/terminalRuntimeRegistry", () => ({
  terminalRuntimeRegistry: {
    disposeTerminal: vi.fn(),
  },
}));

describe("Sidebar module", () => {
  it("loads after project-run wiring", async () => {
    vi.stubGlobal("self", globalThis);
    const module = await import("./Sidebar");

    expect(module.default).toBeTypeOf("function");
    // Full-suite runs transform many web files concurrently; this import can cross Vitest's 5s default.
  }, 15_000);

  it("routes bulk sidebar outcomes to stable Activity records", async () => {
    vi.stubGlobal("self", globalThis);
    const { createSidebarBulkThreadActivity } = await import("./Sidebar");
    const projectId = ProjectId.makeUnsafe("project-1");

    expect(
      createSidebarBulkThreadActivity({
        operation: "archive",
        projectId,
        projectName: "LitRev",
        completedCount: 3,
        failureCount: 0,
      }),
    ).toMatchObject({
      dedupeKey: "sidebar:archive:project:project-1",
      source: "system",
      status: "recent",
      tone: "success",
      title: "Archived 3 threads",
    });

    expect(
      createSidebarBulkThreadActivity({
        operation: "delete",
        projectId,
        projectName: "LitRev",
        completedCount: 2,
        failureCount: 1,
      }),
    ).toMatchObject({
      dedupeKey: "sidebar:delete:project:project-1",
      status: "needs_attention",
      tone: "warning",
      title: "Deleted 2 threads",
    });

    expect(
      createSidebarBulkThreadActivity({
        operation: "archive",
        projectId,
        projectName: "LitRev",
        completedCount: 0,
        failureCount: 0,
        skippedRunningCount: 0,
      }),
    ).toBeNull();
  }, 15_000);

  it("keeps project setup outcomes reviewable without success cards", async () => {
    vi.stubGlobal("self", globalThis);
    const { createProjectInitializationActivity } = await import("./Sidebar");

    expect(
      createProjectInitializationActivity("/repo/LitRev", {
        kind: "applied",
        result: {} as never,
      }),
    ).toMatchObject({
      dedupeKey: "sidebar:project-setup:/repo/LitRev",
      status: "recent",
      tone: "success",
      title: "Scient project initialized",
    });

    expect(
      createProjectInitializationActivity("/repo/LitRev", {
        kind: "rolled-back",
        result: { complete: false, preserved: ["AGENTS.md"] } as never,
      }),
    ).toMatchObject({
      dedupeKey: "sidebar:project-setup:/repo/LitRev",
      status: "needs_attention",
      tone: "warning",
      title: "Some changed files were preserved",
      description: "AGENTS.md",
    });
  }, 15_000);

  it("keeps one centralized transient error outlet and no copy-success cards", () => {
    const source = readFileSync(new URL("./Sidebar.tsx", import.meta.url), "utf8");

    expect(source).not.toContain("toastManager");
    expect(source.match(/transientAlertManager\.add\(/g)).toHaveLength(1);
    expect(source).not.toContain("useCopyPathToClipboard");
    expect(source).not.toContain("useCopyThreadIdToClipboard");
    expect(source).not.toContain("Path copied");
    expect(source).not.toContain("Thread ID copied");
    expect(source).not.toContain("showEmptyToast");
    expect(source).not.toContain("showResultToast");
  });

  it("clears exact durable sidebar failures after successful retries", () => {
    const source = readFileSync(new URL("./Sidebar.tsx", import.meta.url), "utf8");

    expect(source).toMatch(
      /const activityKey = `sidebar:handoff:thread:[\s\S]*?await createThreadHandoff\(thread, targetProvider\);\s*activityManager\.remove\(activityKey\);/,
    );
    expect(source).toMatch(
      /const activityKey = `sidebar:archive-restore:thread:[\s\S]*?isThreadAlreadyUnarchivedError[\s\S]*?activityManager\.remove\(activityKey\);/,
    );
  });

  it("removes resolved desktop update Activity instead of retaining a success alert", () => {
    const source = readFileSync(new URL("./Sidebar.tsx", import.meta.url), "utf8");

    expect(source).toMatch(
      /shouldClearDesktopUpdateActivity\(desktopUpdateState\)[\s\S]*?activityManager\.remove\("update:desktop"\);/,
    );
    expect(source).not.toContain('title: "You\'re up to date"');
    expect(source).not.toContain('title: "Already up to date"');
  });
});
