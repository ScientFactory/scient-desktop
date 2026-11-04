import { EnvironmentId } from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { FileBreadcrumbNavigator } from "./FileBreadcrumbNavigator";

describe("FileBreadcrumbNavigator", () => {
  // regression: bec3561054 feat(markdown): toolbar overhaul, default write mode, empty doc placeholder
  it("can turn the current filename into an owned inline action", () => {
    const html = renderToStaticMarkup(
      <FileBreadcrumbNavigator
        environmentId={EnvironmentId.make("breadcrumb-test")}
        cwd="/repo"
        projectName="Scient"
        relativePath="notes/result.md"
        onOpenFile={() => undefined}
        currentFileControl={<button aria-label="Rename result.md">result.md</button>}
      />,
    );

    expect(html).toContain('data-current-file-crumb="true"');
    expect(html).toContain('aria-label="Rename result.md"');
  });

  it("makes project and directory crumbs browseable while keeping the file crumb static", () => {
    const html = renderToStaticMarkup(
      <FileBreadcrumbNavigator
        environmentId={EnvironmentId.make("breadcrumb-test")}
        cwd="C:\\repo"
        projectName="Scient"
        relativePath="sources/drafts/paper.tex"
        onOpenFile={() => undefined}
      />,
    );

    expect(html).toContain('aria-label="Browse Scient"');
    expect(html).toContain('aria-label="Browse sources"');
    expect(html).toContain('aria-label="Browse sources/drafts"');
    expect(html).toContain('data-current-file-crumb="true"');
    expect(html).not.toContain('aria-label="Browse sources/drafts/paper.tex"');
  });
});
