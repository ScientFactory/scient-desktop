// @effect-diagnostics nodeBuiltinImport:off - Source guard pins install branches too heavy to mount in the browser suite.
import * as NodeFS from "node:fs";
import { describe, expect, it } from "vite-plus/test";

/**
 * Settings and the legacy sidebar are too heavy to mount in the browser suite
 * (their module graphs exhaust the browser runner's mocking layer), so their
 * install branches are pinned at the source level: they must restart through
 * the shared install, release their pending state, and never ask to confirm.
 * The sidebar footer is covered end to end in updateRestartFlow.browser.test.
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
  [
    "legacy sidebar",
    "../../components/LegacySidebar.tsx",
    'if (desktopUpdateButtonAction === "install") {',
  ],
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

describe("the legacy sidebar's ready notice", () => {
  it("holds its footer pending while Restart now installs", () => {
    const source = NodeFS.readFileSync(
      new URL("../../components/LegacySidebar.tsx", import.meta.url),
      "utf8",
    );
    const notice = source.slice(source.indexOf("showScientUpdateReadyNotice({"));
    expect(notice.slice(0, 500)).toMatch(
      /install: \(\) => \{\s*setDesktopUpdateActionPending\(true\);\s*return installDesktopUpdateNow\(bridge\)/,
    );
  });
});
