import { describe, expect, it } from "vite-plus/test";

import { findPublicBrandViolations, isProductSurface } from "./check-scient-brand.ts";

describe("Scient brand guard", () => {
  it("rejects inherited product copy on active application surfaces", () => {
    expect(
      findPublicBrandViolations([
        { path: "apps/web/src/example.ts", contents: 'const label = "T3 Code";' },
      ]),
    ).toEqual([
      {
        path: "apps/web/src/example.ts",
        line: 1,
        text: 'const label = "T3 Code";',
      },
    ]);
  });

  it.each([
    "packages/client-runtime/src/work-log/presentation.ts",
    "apps/mobile/src/lib/threadActivity.ts",
    "apps/mobile/src/features/threads/thread-work-log.tsx",
    "apps/mobile/src/components/CompactBrandTitle.tsx",
    "apps/mobile/src/lib/authClientMetadata.ts",
    "apps/mobile/src/features/settings/SettingsAboutRouteScreen.tsx",
  ])("covers owned tool presentation without expanding donor-wide enforcement: %s", (path) => {
    const contents = 'const label = "Reading a T3 thread";';
    expect(findPublicBrandViolations([{ path, contents }])).toEqual([
      { path, line: 1, text: contents },
    ]);
  });

  it.each([
    'Tool.make("t3_thread_read", {})',
    'const title = "T3 MCP";',
    'const instructions = "Use the t3-code MCP server";',
  ])("rejects inherited public tool identity: %s", (contents) => {
    const path = "apps/server/src/mcp/tools.ts";
    expect(findPublicBrandViolations([{ path, contents }])).toEqual([
      { path, line: 1, text: contents },
    ]);
  });

  it("rejects an inherited visual wordmark even when its name is split from the copy", () => {
    expect(
      findPublicBrandViolations([
        {
          path: "apps/web/src/components/sidebar/SidebarChrome.tsx",
          contents: "const Brand = () => <T3Wordmark />;",
        },
      ]),
    ).toEqual([
      {
        path: "apps/web/src/components/sidebar/SidebarChrome.tsx",
        line: 1,
        text: "const Brand = () => <T3Wordmark />;",
      },
    ]);
  });

  it("rejects the retired repository slug from active application surfaces", () => {
    expect(
      findPublicBrandViolations([
        {
          path: "apps/server/src/support.ts",
          contents: 'export const source = "ScientFactory/scient-desktop-next";',
        },
      ]),
    ).toEqual([
      {
        path: "apps/server/src/support.ts",
        line: 1,
        text: 'export const source = "ScientFactory/scient-desktop-next";',
      },
    ]);
  });

  it.each(["pingdotgg/t3code", "t3dotgg/t3-code"])(
    "rejects upstream release links on active application surfaces (%s)",
    (repository) => {
      const file = {
        path: "apps/web/src/components/desktopUpdate.logic.ts",
        contents: `const releaseUrl = "https://github.com/${repository}/releases/tag/v0.6.8";`,
      };
      expect(findPublicBrandViolations([file])).toEqual([
        { path: file.path, line: 1, text: file.contents },
      ]);
    },
  );

  it("permits Scient releases and upstream source attribution", () => {
    expect(
      findPublicBrandViolations([
        {
          path: "apps/web/src/components/desktopUpdate.logic.ts",
          contents:
            'const releaseUrl = "https://github.com/ScientFactory/scient-desktop/releases/tag/v0.6.8";',
        },
        {
          path: "apps/desktop/src/about.ts",
          contents: 'const upstream = "https://github.com/pingdotgg/t3code";',
        },
        {
          path: "apps/web/src/components/desktopUpdate.logic.ts",
          contents: "// Upstream source: https://github.com/pingdotgg/t3code/releases",
        },
      ]),
    ).toEqual([]);
  });

  it("permits technical commentary and donor-only surfaces", () => {
    expect(
      findPublicBrandViolations([
        { path: "apps/server/src/example.ts", contents: "// T3 Code compatibility seam" },
        { path: "apps/mobile/src/example.ts", contents: 'const label = "T3 Code";' },
        { path: "apps/marketing/src/example.ts", contents: 'const label = "T3 Code";' },
      ]),
    ).toEqual([]);
  });

  it("keeps internal package namespaces outside product-brand enforcement", () => {
    expect(isProductSurface("packages/shared/src/scientDesktopIdentity.ts")).toBe(false);
    expect(isProductSurface("packages/contracts/src/settings.ts")).toBe(true);
  });

  it("preserves captured compatibility identities in test-only replay helpers", () => {
    const contents = 'const capturedClientTitle = "T3 Code";';
    expect(
      findPublicBrandViolations([
        { path: "apps/server/src/provider/CodexAdapterV2.testkit.ts", contents },
      ]),
    ).toEqual([]);
    expect(
      findPublicBrandViolations([{ path: "apps/server/src/provider/CodexAdapterV2.ts", contents }]),
    ).toHaveLength(1);
  });
});
