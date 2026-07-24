import "../index.css";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { page } from "vitest/browser";
import { describe, expect, it } from "vitest";
import { render } from "vitest-browser-react";

import { projectQueryKeys } from "~/lib/projectReactQuery";
import { WorkspaceFilePreview } from "./WorkspaceFilePreview";

describe("WorkspaceFilePreview Markdown frontmatter", () => {
  it("hides frontmatter in Preview and preserves it byte-for-byte in Source", async () => {
    const workspaceRoot = "/project";
    const filePath = "skills/evidence-to-note/SKILL.md";
    const contents = [
      "---",
      "name: scient-evidence-to-note",
      'description: "Turn evidence into a note."',
      "---",
      "",
      "# Evidence to Note",
      "",
      "Study content.",
    ].join("\n");
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false, staleTime: Number.POSITIVE_INFINITY },
      },
    });
    queryClient.setQueryData(projectQueryKeys.readFile(workspaceRoot, filePath), {
      relativePath: filePath,
      contents,
      truncated: false,
    });
    const screen = await render(
      <QueryClientProvider client={queryClient}>
        <WorkspaceFilePreview
          workspaceRoot={workspaceRoot}
          filePath={filePath}
          markdownPreviewDefault={false}
        />
      </QueryClientProvider>,
    );

    try {
      const sourceBody = screen.container.querySelector(
        ".editor-file-viewer__plain, .editor-file-viewer__highlight",
      );
      expect(sourceBody?.textContent).toBe(contents);

      await page.getByRole("radio", { name: "Preview" }).click();
      const previewBody = screen.container.querySelector(".editor-markdown-preview");
      expect(previewBody?.textContent).not.toContain("scient-evidence-to-note");
      expect(previewBody?.textContent).not.toContain("Turn evidence into a note.");
      await expect
        .element(page.getByRole("heading", { level: 1 }))
        .toHaveTextContent("Evidence to Note");
      expect(previewBody?.querySelectorAll("h1, h2, h3, h4, h5, h6")).toHaveLength(1);

      await page.getByRole("radio", { name: "Source" }).click();
      const restoredSourceBody = screen.container.querySelector(
        ".editor-file-viewer__plain, .editor-file-viewer__highlight",
      );
      expect(restoredSourceBody?.textContent).toBe(contents);
    } finally {
      await screen.unmount();
      queryClient.clear();
    }
  });

  it("keeps the established rendered Markdown experience and lossless Source toggle", async () => {
    const workspaceRoot = "/project";
    const filePath = "notes/review.md";
    const contents = [
      "# Review notes",
      "",
      "A paragraph with **strong evidence** and an [internal link](./details.md).",
      "",
      "- [ ] Reproduce the result",
      "- [x] Record the observation",
      "",
      "| Sample | Result |",
      "| --- | --- |",
      "| A | Positive |",
      "",
      "```ts",
      "export const result = true;",
      "```",
    ].join("\n");
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false, staleTime: Number.POSITIVE_INFINITY },
      },
    });
    queryClient.setQueryData(projectQueryKeys.readFile(workspaceRoot, filePath), {
      relativePath: filePath,
      contents,
      truncated: false,
    });
    const screen = await render(
      <QueryClientProvider client={queryClient}>
        <WorkspaceFilePreview
          workspaceRoot={workspaceRoot}
          filePath={filePath}
          markdownPreviewDefault
        />
      </QueryClientProvider>,
    );

    try {
      await expect
        .element(page.getByRole("heading", { level: 1 }))
        .toHaveTextContent("Review notes");
      await expect.element(page.getByRole("table")).toBeVisible();
      await expect.element(page.getByRole("link", { name: "internal link" })).toBeVisible();
      expect(screen.container.querySelectorAll('input[type="checkbox"]')).toHaveLength(2);

      await page.getByRole("radio", { name: "Source" }).click();
      const sourceBody = screen.container.querySelector(
        ".editor-file-viewer__plain, .editor-file-viewer__highlight",
      );
      expect(sourceBody?.textContent).toBe(contents);

      await page.getByRole("radio", { name: "Preview" }).click();
      await expect
        .element(page.getByRole("heading", { level: 1 }))
        .toHaveTextContent("Review notes");
    } finally {
      await screen.unmount();
      queryClient.clear();
    }
  });
});

describe("WorkspaceFilePreview SVG", () => {
  it("opens visually by default and offers a lossless source view", async () => {
    const workspaceRoot = "/project";
    const filePath = "art/diagram.svg";
    const contents = '<svg xmlns="http://www.w3.org/2000/svg"><text>Scient diagram</text></svg>';
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false, staleTime: Number.POSITIVE_INFINITY },
      },
    });
    queryClient.setQueryData(projectQueryKeys.readFile(workspaceRoot, filePath), {
      relativePath: filePath,
      contents,
      truncated: false,
    });
    const screen = await render(
      <QueryClientProvider client={queryClient}>
        <WorkspaceFilePreview workspaceRoot={workspaceRoot} filePath={filePath} />
      </QueryClientProvider>,
    );

    try {
      await expect.element(page.getByRole("radiogroup", { name: "SVG view" })).toBeVisible();
      await expect.element(page.getByRole("button", { name: "Open" })).toBeEnabled();
      expect(screen.container.querySelector(".local-image-preview")).not.toBeNull();

      await page.getByRole("radio", { name: "Source" }).click();
      const sourceBody = screen.container.querySelector(
        ".editor-file-viewer__plain, .editor-file-viewer__highlight",
      );
      expect(sourceBody?.textContent).toBe(contents);

      await page.getByRole("radio", { name: "Preview" }).click();
      expect(screen.container.querySelector(".local-image-preview")).not.toBeNull();
    } finally {
      await screen.unmount();
      queryClient.clear();
    }
  });
});
