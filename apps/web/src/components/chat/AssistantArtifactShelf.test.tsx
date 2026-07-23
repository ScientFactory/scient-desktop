import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { AssistantArtifactShelf } from "./AssistantArtifactShelf";

function createQueryClient() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
}

describe("AssistantArtifactShelf", () => {
  it("shows a pointer cursor on the primary preview surface", () => {
    const queryClient = createQueryClient();
    const markup = renderToStaticMarkup(
      <QueryClientProvider client={queryClient}>
        <AssistantArtifactShelf
          markdown="Open [Heart failure](topics/cardiology/heart-failure.html)."
          markdownCwd="/study"
          workspaceRoot="/study"
        />
      </QueryClientProvider>,
    );

    expect(markup).toMatch(
      /<button[^>]*class="[^"]*cursor-pointer[^"]*"[^>]*title="Preview \/study\/topics\/cardiology\/heart-failure\.html"/,
    );
  });

  it("keeps short shelves fully visible", () => {
    const markup = renderToStaticMarkup(
      <QueryClientProvider client={createQueryClient()}>
        <AssistantArtifactShelf
          markdown="[One](one.md) [Two](two.md) [Three](three.md)"
          markdownCwd="/study"
          workspaceRoot="/study"
        />
      </QueryClientProvider>,
    );

    expect(markup).not.toContain("more files");
    expect(markup).toContain('title="Preview /study/three.md"');
  });

  it("shows two complete rows and an inert third-row teaser for long shelves", () => {
    const markup = renderToStaticMarkup(
      <QueryClientProvider client={createQueryClient()}>
        <AssistantArtifactShelf
          markdown="[One](one.md) [Two](two.md) [Three](three.md) [Four](four.md)"
          markdownCwd="/study"
          workspaceRoot="/study"
        />
      </QueryClientProvider>,
    );

    expect(markup).toContain("4 files");
    expect(markup).toContain("Show 2 more files");
    expect(markup).toContain('aria-expanded="false"');
    expect(markup).toMatch(/aria-hidden="true"[^>]*inert=""/);
  });
});
