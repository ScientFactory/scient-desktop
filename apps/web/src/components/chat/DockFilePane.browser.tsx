import "../../index.css";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { page } from "vitest/browser";
import { describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import { useState } from "react";

import { projectQueryKeys } from "~/lib/projectReactQuery";

import { DockExplorerPane } from "./DockExplorerPane";
import { DockFilePane } from "./DockFilePane";
import { useDockWorkspaceExplorer } from "./useDockWorkspaceExplorer";

function createQueryClient() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Number.POSITIVE_INFINITY } },
  });
  for (const workspaceRoot of ["/project", "/other-project"]) {
    queryClient.setQueryData(projectQueryKeys.readFile(workspaceRoot, "README.md"), {
      relativePath: "README.md",
      contents: "# Scient\n\nA local-first scientific workspace.",
      truncated: false,
    });
    queryClient.setQueryData(projectQueryKeys.readFile(workspaceRoot, "notes.md"), {
      relativePath: "notes.md",
      contents: "# Notes\n\nPersistent explorer state.",
      truncated: false,
    });
    queryClient.setQueryData(projectQueryKeys.listDirectories(workspaceRoot, null, true), {
      entries: [
        { path: "src", name: "src", kind: "directory" },
        { path: "README.md", name: "README.md", kind: "file" },
        { path: "notes.md", name: "notes.md", kind: "file" },
      ],
    });
    queryClient.setQueryData(projectQueryKeys.listDirectories(workspaceRoot, "src", true), {
      entries: [{ path: "src/index.ts", name: "index.ts", kind: "file" }],
    });
    queryClient.setQueryData(projectQueryKeys.searchEntries(workspaceRoot, "notes", 80, "file"), {
      entries: [{ path: "notes.md", name: "notes.md", kind: "file" }],
      truncated: false,
    });
  }
  return queryClient;
}

function ExplorerTransitionHarness() {
  const [workspaceRoot, setWorkspaceRoot] = useState("/project");
  const explorer = useDockWorkspaceExplorer(workspaceRoot);
  const [filePath, setFilePath] = useState<string | null>(null);

  return (
    <>
      <button type="button" onClick={() => setFilePath(null)}>
        Show standalone explorer
      </button>
      <button
        type="button"
        onClick={() => {
          setFilePath(null);
          setWorkspaceRoot((current) => (current === "/project" ? "/other-project" : "/project"));
        }}
      >
        Switch workspace
      </button>
      {filePath ? (
        <DockFilePane
          workspaceRoot={workspaceRoot}
          filePath={filePath}
          explorerOpen
          explorer={explorer}
          onOpenFile={setFilePath}
        />
      ) : (
        <DockExplorerPane
          workspaceRoot={workspaceRoot}
          explorer={explorer}
          onOpenFile={setFilePath}
        />
      )}
    </>
  );
}

describe("DockFilePane", () => {
  it("keeps the file and controlled explorer visible together", async () => {
    const queryClient = createQueryClient();
    const onOpenFile = vi.fn();
    const explorer = {
      expandedDirectories: new Set<string>(),
      searchQuery: "",
      setSearchQuery: vi.fn(),
      toggleDirectory: vi.fn(),
    };
    const pane = (explorerOpen: boolean) => (
      <QueryClientProvider client={queryClient}>
        <DockFilePane
          workspaceRoot="/project"
          filePath="README.md"
          explorerOpen={explorerOpen}
          explorer={explorer}
          onOpenFile={onOpenFile}
        />
      </QueryClientProvider>
    );
    const screen = await render(pane(true));

    try {
      await expect.element(page.getByRole("heading", { name: "Scient" })).toBeVisible();
      await expect.element(page.getByRole("textbox", { name: "Search files" })).toBeVisible();

      await page.getByRole("button", { name: /^notes\.md/ }).click();
      expect(onOpenFile).toHaveBeenCalledWith("notes.md");

      await screen.rerender(pane(false));
      expect(
        screen.container
          .querySelector("[data-dock-file-explorer-region]")
          ?.getAttribute("aria-hidden"),
      ).toBe("true");

      await screen.rerender(pane(true));
      await expect.element(page.getByRole("textbox", { name: "Search files" })).toBeVisible();
    } finally {
      await screen.unmount();
      queryClient.clear();
    }
  });

  it("preserves explorer search while promoting a file and returning to the explorer", async () => {
    const queryClient = createQueryClient();
    const screen = await render(
      <QueryClientProvider client={queryClient}>
        <ExplorerTransitionHarness />
      </QueryClientProvider>,
    );

    try {
      const search = page.getByRole("textbox", { name: "Search files" });
      await search.fill("notes");
      await page.getByRole("button", { name: /^notes\.md/ }).click();

      await expect.element(page.getByRole("heading", { name: "Notes" })).toBeVisible();
      await expect
        .element(page.getByRole("textbox", { name: "Search files" }))
        .toHaveValue("notes");

      await page.getByRole("button", { name: "Show standalone explorer" }).click();
      await expect
        .element(page.getByRole("textbox", { name: "Search files" }))
        .toHaveValue("notes");
    } finally {
      await screen.unmount();
      queryClient.clear();
    }
  });

  it("resets explorer state when the workspace scope changes", async () => {
    const queryClient = createQueryClient();
    const screen = await render(
      <QueryClientProvider client={queryClient}>
        <ExplorerTransitionHarness />
      </QueryClientProvider>,
    );

    try {
      const sourceDirectory = page.getByRole("button", { name: /^src/ });
      await sourceDirectory.click();
      await expect.element(sourceDirectory).toHaveAttribute("aria-expanded", "true");

      const search = page.getByRole("textbox", { name: "Search files" });
      await search.fill("notes");
      await expect.element(search).toHaveValue("notes");

      await page.getByRole("button", { name: "Switch workspace" }).click();
      await expect.element(page.getByRole("textbox", { name: "Search files" })).toHaveValue("");
      await expect
        .element(page.getByRole("button", { name: /^src/ }))
        .toHaveAttribute("aria-expanded", "false");

      await page.getByRole("button", { name: "Switch workspace" }).click();
      await expect.element(page.getByRole("textbox", { name: "Search files" })).toHaveValue("");
      await expect
        .element(page.getByRole("button", { name: /^src/ }))
        .toHaveAttribute("aria-expanded", "false");
    } finally {
      await screen.unmount();
      queryClient.clear();
    }
  });
});
