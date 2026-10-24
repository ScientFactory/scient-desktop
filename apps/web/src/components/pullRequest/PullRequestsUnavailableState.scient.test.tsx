import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { PullRequestsUnavailableState } from "./PullRequestsUnavailableState";

// Restored from the upstream-deleted PullRequestsUnavailableState.test.tsx.
// regression: 7068e86f76 fix(web): open GitHub pull requests in browser when loading fails (#8507)
describe("PullRequestsUnavailableState", () => {
  it("can offer the browser without offering a retry", () => {
    const html = renderToStaticMarkup(
      <PullRequestsUnavailableState
        error="This server cannot read the pull request."
        host={{ url: "https://github.com/pingdotgg/t3code/pull/9", openLabel: "Open on GitHub" }}
      />,
    );

    expect(html).toContain("Open on GitHub");
    expect(html).not.toContain("Retry");
  });

  it("can offer a retry without offering GitHub", () => {
    const html = renderToStaticMarkup(
      <PullRequestsUnavailableState error="The host did not answer." onRetry={() => {}} />,
    );

    expect(html).toContain("Retry");
    expect(html).not.toContain("Open on GitHub");
  });

  it("renders no action content without a retry or browser target", () => {
    const html = renderToStaticMarkup(
      <PullRequestsUnavailableState error="This project has no known remote." />,
    );

    expect(html).not.toContain('data-slot="empty-content"');
    expect(html).not.toContain("href=");
  });
});
