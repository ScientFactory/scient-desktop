import "../index.css";

import { page } from "vitest/browser";
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
