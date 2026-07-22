import "../../index.css";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { page } from "vitest/browser";
import { describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { projectQueryKeys } from "~/lib/projectReactQuery";

import { DockFilePane } from "./DockFilePane";

function createQueryClient() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Number.POSITIVE_INFINITY } },
  });
  const workspaceRoot = "/project";
  queryClient.setQueryData(projectQueryKeys.readFile(workspaceRoot, "README.md"), {
    relativePath: "README.md",
    contents: "# Scient\n\nA local-first scientific workspace.",
    truncated: false,
  });
  queryClient.setQueryData(projectQueryKeys.listDirectories(workspaceRoot, null, true), {
    entries: [
      { path: "README.md", name: "README.md", kind: "file" },
      { path: "notes.md", name: "notes.md", kind: "file" },
    ],
  });
  return queryClient;
}

describe("DockFilePane", () => {
  it("keeps the file and controlled explorer visible together", async () => {
    const queryClient = createQueryClient();
    const onOpenFile = vi.fn();
    const pane = (explorerOpen: boolean) => (
      <QueryClientProvider client={queryClient}>
        <DockFilePane
          workspaceRoot="/project"
          filePath="README.md"
          explorerOpen={explorerOpen}
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
});
