// FILE: BranchToolbarBranchSelector.browser.tsx
// Purpose: Browser-level coverage for accessible branch-name copy actions.
// Layer: Vitest browser tests

import "../index.css";

import type { GitListBranchesResult, GitStatusResult } from "@synara/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { page, userEvent } from "vitest/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { gitQueryKeys } from "../lib/gitReactQuery";
import { readNativeApi } from "../nativeApi";
import { transientAlertManager } from "../notifications/transientAlert";
import type { ThreadWorkspacePatch } from "../types";
import { BranchToolbarBranchSelector } from "./BranchToolbarBranchSelector";

const CWD = "/Users/tester/scient";

const branchesResult: GitListBranchesResult = {
  branches: [
    {
      name: "main",
      current: true,
      isDefault: true,
      worktreePath: CWD,
    },
    {
      name: "feature/copy-listed-branch",
      current: false,
      isDefault: false,
      worktreePath: null,
    },
  ],
  isRepo: true,
  hasOriginRemote: true,
};

const statusResult: GitStatusResult = {
  branch: "main",
  hasWorkingTreeChanges: false,
  workingTree: { files: [], insertions: 0, deletions: 0 },
  hasUpstream: true,
  upstreamBranch: "origin/main",
  aheadCount: 0,
  behindCount: 0,
  pr: null,
};

async function renderSelector(input?: {
  activeThreadBranch?: string | null;
  branchCwd?: string | null;
  onSetThreadWorkspace?: (patch: ThreadWorkspacePatch) => void;
  seedBranches?: boolean;
}) {
  const branchCwd = input?.branchCwd === undefined ? CWD : input.branchCwd;
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  if (input?.seedBranches !== false && branchCwd) {
    queryClient.setQueryData(gitQueryKeys.branches(branchCwd), branchesResult);
    queryClient.setQueryData(gitQueryKeys.status(branchCwd), statusResult);
  }

  const onSetThreadWorkspace =
    input?.onSetThreadWorkspace ?? vi.fn<(patch: ThreadWorkspacePatch) => void>();
  await render(
    <QueryClientProvider client={queryClient}>
      <BranchToolbarBranchSelector
        activeProjectCwd={CWD}
        activeThreadBranch={
          input?.activeThreadBranch === undefined ? "main" : input.activeThreadBranch
        }
        activeWorktreePath={null}
        branchCwd={branchCwd}
        effectiveEnvMode="local"
        envLocked={false}
        hasServerThread
        onSetThreadWorkspace={onSetThreadWorkspace}
      />
    </QueryClientProvider>,
  );
  return { onSetThreadWorkspace };
}

describe("BranchToolbarBranchSelector branch-name copy actions", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("copies the active branch through the discoverable picker action", async () => {
    const writeText = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();
    await renderSelector();

    await page.getByText("main", { exact: true }).click();
    await page.getByRole("button", { name: "Copy branch name: main" }).click();

    await expect.poll(() => writeText.mock.calls).toEqual([["main"]]);
  });

  it("copies a listed branch from its native context action without checking it out", async () => {
    const writeText = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();
    const previousNativeApi = window.nativeApi;
    const baseApi = readNativeApi();
    if (!baseApi) throw new Error("Expected browser native API fixture.");
    const showContextMenu = vi.fn().mockResolvedValue("copy-branch-name");
    const checkout = vi.fn();
    const createBranch = vi.fn();
    Object.defineProperty(window, "nativeApi", {
      configurable: true,
      value: {
        ...baseApi,
        contextMenu: { ...baseApi.contextMenu, show: showContextMenu },
        git: { ...baseApi.git, checkout, createBranch },
      },
    });

    try {
      const { onSetThreadWorkspace } = await renderSelector();
      await page.getByText("main", { exact: true }).click();
      const listedBranch = page.getByRole("option", { name: /feature\/copy-listed-branch/i });
      listedBranch
        .element()
        .dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: 12, clientY: 18 }));

      await expect.poll(() => writeText.mock.calls).toEqual([["feature/copy-listed-branch"]]);
      expect(showContextMenu).toHaveBeenCalledOnce();
      expect(checkout).not.toHaveBeenCalled();
      expect(createBranch).not.toHaveBeenCalled();
      expect(onSetThreadWorkspace).not.toHaveBeenCalled();
    } finally {
      Object.defineProperty(window, "nativeApi", {
        configurable: true,
        value: previousNativeApi,
      });
    }
  });

  it("copies a keyboard-filtered branch without checking it out", async () => {
    const writeText = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();
    const previousNativeApi = window.nativeApi;
    const baseApi = readNativeApi();
    if (!baseApi) throw new Error("Expected browser native API fixture.");
    const checkout = vi.fn();
    const createBranch = vi.fn();
    Object.defineProperty(window, "nativeApi", {
      configurable: true,
      value: { ...baseApi, git: { ...baseApi.git, checkout, createBranch } },
    });

    try {
      const { onSetThreadWorkspace } = await renderSelector();
      await page.getByText("main", { exact: true }).click();
      await page.getByPlaceholder("Search branches...").fill("feature/copy-listed-branch");

      const copyButton = page.getByRole("button", {
        name: "Copy branch name: feature/copy-listed-branch",
      });
      await expect.element(copyButton).toBeVisible();
      expect(copyButton.element().tabIndex).toBeGreaterThanOrEqual(0);
      copyButton.element().focus();
      await userEvent.keyboard("{Enter}");

      await expect.poll(() => writeText.mock.calls).toEqual([["feature/copy-listed-branch"]]);
      expect(checkout).not.toHaveBeenCalled();
      expect(createBranch).not.toHaveBeenCalled();
      expect(onSetThreadWorkspace).not.toHaveBeenCalled();
    } finally {
      Object.defineProperty(window, "nativeApi", {
        configurable: true,
        value: previousNativeApi,
      });
    }
  });

  it("keeps branch actions unavailable when there is no branch context", async () => {
    await renderSelector({ activeThreadBranch: null, branchCwd: null });

    await page.getByText("Select branch", { exact: true }).click();
    await expect.element(page.getByRole("button", { name: "Copy branch name" })).toBeDisabled();
  });

  it("reports clipboard failure without switching branches", async () => {
    vi.spyOn(navigator.clipboard, "writeText").mockRejectedValue(new Error("Clipboard denied"));
    vi.spyOn(document, "execCommand").mockReturnValue(false);
    const addAlert = vi.spyOn(transientAlertManager, "add");
    await renderSelector();

    await page.getByText("main", { exact: true }).click();
    await page.getByRole("button", { name: "Copy branch name: main" }).click();

    await expect.poll(() => addAlert.mock.calls.length).toBe(1);
    expect(addAlert).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "error",
        title: "Failed to copy branch name",
        description: "main: Clipboard denied",
      }),
    );
  });
});
