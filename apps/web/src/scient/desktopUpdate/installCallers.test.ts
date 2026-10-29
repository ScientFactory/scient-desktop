// @effect-diagnostics nodeBuiltinImport:off - Source guard pins install branches too heavy to mount in the browser suite.
import * as NodeFS from "node:fs";
import { describe, expect, it } from "vite-plus/test";

/**
 * The Settings module graph exhausts browser mocking, so pin its install branch at source level.
 * The sidebar footer's actual restart flow is covered by updateRestartFlow.browser.test.
 */
function installBranch(relativePath: string, opening: string): string {
  const source = NodeFS.readFileSync(new URL(relativePath, import.meta.url), "utf8");
  const start = source.indexOf(opening);
  expect(start, `${relativePath} has no install branch`).toBeGreaterThanOrEqual(0);
  const end = source.indexOf("\n    }\n", start);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end);
}

describe.each([
  ["Settings", "../../components/settings/SettingsPanels.tsx", 'if (action === "install") {'],
])("%s install", (_name, relativePath, opening) => {
  const branch = installBranch(relativePath, opening);

  it("restarts through the shared install and releases its pending state", () => {
    expect(branch).toMatch(
      /installDesktopUpdateNow\(bridge\)\.finally\(\(\) =>\s*set\w*Pending\(false\)/,
    );
  });

  it("never asks for confirmation first", () => {
    expect(branch).not.toMatch(/confirm\w*\s*\(/i);
    expect(branch).not.toContain("installUpdate()");
  });
});
