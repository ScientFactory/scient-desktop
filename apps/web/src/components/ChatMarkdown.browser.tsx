import "../index.css";

import { page, userEvent } from "vitest/browser";
import { describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import ChatMarkdown from "./ChatMarkdown";

describe("ChatMarkdown frontmatter source positions", () => {
  it("keeps a task checkbox aligned to its original source line", async () => {
    const onTaskToggle = vi.fn();
    const source = [
      "---",
      "name: task-document",
      "description: A document with a task.",
      "---",
      "",
      "# Tasks",
      "",
      "- [ ] Verify the preview",
    ].join("\n");
    const screen = await render(
      <ChatMarkdown
        text={source}
        cwd={undefined}
        isStreaming={false}
        recognizeFrontmatter
        onTaskToggle={onTaskToggle}
      />,
    );

    try {
      await page.getByRole("checkbox", { name: "" }).click();

      expect(onTaskToggle).toHaveBeenCalledOnce();
      expect(onTaskToggle).toHaveBeenCalledWith({ sourceLine: 8, checked: true });
    } finally {
      await screen.unmount();
    }
  });
});

describe("ChatMarkdown image activation", () => {
  it("renders source access without a dead Preview control when expansion is unavailable", async () => {
    const imageUrl = new URL("/apple-touch-icon.png", window.location.href).href;
    const screen = await render(
      <ChatMarkdown text={`![Remote capture](${imageUrl})`} cwd={undefined} isStreaming={false} />,
    );

    try {
      await expect.element(page.getByRole("img", { name: "Remote capture" })).toBeInTheDocument();
      expect(page.getByRole("button", { name: "Preview Remote capture" }).query()).toBeNull();
      expect(page.getByText("Preview", { exact: true }).query()).toBeNull();
      await expect
        .element(page.getByRole("link", { name: "Open source for Remote capture" }))
        .toBeInTheDocument();
    } finally {
      await screen.unmount();
    }
  });

  it("activates an available image preview by click and Enter", async () => {
    const onImageExpand = vi.fn();
    const imageUrl = new URL("/apple-touch-icon.png", window.location.href).href;
    const screen = await render(
      <ChatMarkdown
        text={`![Remote capture](${imageUrl})`}
        cwd={undefined}
        isStreaming={false}
        onImageExpand={onImageExpand}
      />,
    );

    try {
      const preview = page.getByRole("button", { name: "Preview Remote capture" });
      await preview.click();
      expect(onImageExpand).toHaveBeenCalledOnce();

      const previewElement = await preview.element();
      previewElement.focus();
      await expect.element(preview).toHaveFocus();
      await userEvent.keyboard("{Enter}");
      expect(onImageExpand).toHaveBeenCalledTimes(2);
    } finally {
      await screen.unmount();
    }
  });
});
