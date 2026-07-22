import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { AssistantArtifactShelf } from "./AssistantArtifactShelf";

describe("AssistantArtifactShelf", () => {
  it("shows a pointer cursor on the primary preview surface", () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
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
});
