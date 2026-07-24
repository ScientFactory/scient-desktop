import "../../index.css";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { page } from "vitest/browser";
import { describe, expect, it } from "vitest";
import { render } from "vitest-browser-react";

import { serverQueryKeys } from "~/lib/serverReactQuery";

import { AssistantArtifactShelf } from "./AssistantArtifactShelf";

function createQueryClient() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Number.POSITIVE_INFINITY } },
  });
  queryClient.setQueryData(serverQueryKeys.config(), { availableEditors: [] });
  return queryClient;
}

describe("AssistantArtifactShelf", () => {
  it("reveals and collapses files after two complete rows and a partial teaser", async () => {
    const screen = await render(
      <QueryClientProvider client={createQueryClient()}>
        <AssistantArtifactShelf
          markdown="[One](one.md) [Two](two.md) [Three](three.md) [Four](four.md) [Five](five.md) [Six](six.md) [Seven](seven.md) [Eight](eight.md) [Nine](nine.md) [Ten](ten.md) [Eleven](eleven.md) [Twelve](twelve.md)"
          markdownCwd="/study"
          workspaceRoot="/study"
        />
      </QueryClientProvider>,
    );

    try {
      const showMore = page.getByRole("button", { name: "Show 10 more files" });
      await expect.element(showMore).toBeVisible();
      await expect.element(showMore).toHaveAttribute("aria-expanded", "false");

      const teaser = screen.container.querySelector<HTMLElement>("[inert][aria-hidden='true']");
      expect(teaser?.textContent).toContain("Three");
      expect(teaser?.matches(":focus-within")).toBe(false);

      await showMore.click();
      await expect.element(page.getByText("Three", { exact: true })).toBeVisible();
      await expect.element(page.getByText("Twelve", { exact: true })).toBeVisible();

      const showFewer = page.getByRole("button", { name: "Show fewer files" });
      await expect.element(showFewer).toHaveAttribute("aria-expanded", "true");
      await showFewer.click();

      await expect.element(showMore).toHaveAttribute("aria-expanded", "false");
      await expect.element(showMore).toHaveFocus();
      expect(
        screen.container.querySelector<HTMLElement>("[inert][aria-hidden='true']")?.textContent,
      ).toContain("Three");
    } finally {
      await screen.unmount();
    }
  });
});
