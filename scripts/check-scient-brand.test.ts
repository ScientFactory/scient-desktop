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
});
