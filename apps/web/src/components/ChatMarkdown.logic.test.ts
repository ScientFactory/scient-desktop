import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  canUseMarkdownFileShellActions,
  shouldUseMarkdownFileBrowserPrimaryAction,
} from "./ChatMarkdown";

describe("canUseMarkdownFileShellActions", () => {
  const environmentId = EnvironmentId.make("environment-1");

  it("allows editor and file manager actions only for resolved local environments", () => {
    expect(canUseMarkdownFileShellActions(environmentId, "local-exec", true)).toBe(true);
    expect(canUseMarkdownFileShellActions(environmentId, "local-exec", false)).toBe(false);
    expect(canUseMarkdownFileShellActions(environmentId, "remote-links", true)).toBe(false);
    expect(canUseMarkdownFileShellActions(environmentId, "remote-unavailable", true)).toBe(false);
    expect(canUseMarkdownFileShellActions(null, "local-exec", true)).toBe(false);
  });
});

describe("shouldUseMarkdownFileBrowserPrimaryAction", () => {
  it("uses the browser whenever the resolved file policy supplies it", () => {
    expect(
      shouldUseMarkdownFileBrowserPrimaryAction({
        canOpenInBrowser: true,
      }),
    ).toBe(true);
  });

  it("falls back to the file actions when browser preview is unavailable", () => {
    expect(
      shouldUseMarkdownFileBrowserPrimaryAction({
        canOpenInBrowser: false,
      }),
    ).toBe(false);
  });
});
