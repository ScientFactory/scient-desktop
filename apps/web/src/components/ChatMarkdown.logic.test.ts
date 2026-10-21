import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { resolveMarkdownFileLinkMeta } from "../markdown-links";

import {
  canUseMarkdownFileShellActions,
  markdownFileCopyMenuItems,
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

describe("markdownFileCopyMenuItems", () => {
  it.each([
    {
      name: "project file",
      href: "/Users/jordan/project/src/main.ts",
      cwd: "/Users/jordan/project",
      relative: "src/main.ts",
      full: "/Users/jordan/project/src/main.ts",
    },
    {
      name: "worktree file with a line and column",
      href: "src/main.ts:12:3",
      cwd: "/Users/jordan/project/.claude/worktrees/topic",
      relative: "src/main.ts:12:3",
      full: "/Users/jordan/project/.claude/worktrees/topic/src/main.ts:12:3",
    },
    {
      name: "main checkout file outside the thread worktree",
      href: "/Users/jordan/project/src/main.ts",
      cwd: "/Users/jordan/project/.claude/worktrees/topic",
      relative: null,
      full: "/Users/jordan/project/src/main.ts",
    },
  ])("offers the available copy actions for $name", ({ href, cwd, relative, full }) => {
    const meta = resolveMarkdownFileLinkMeta(href, cwd);
    expect(meta).not.toBeNull();
    if (!meta) throw new Error(`Expected a file link for ${href}`);
    expect(meta.targetPath).toBe(full);

    expect(markdownFileCopyMenuItems(meta)).toEqual([
      ...(relative === null
        ? []
        : [
            {
              id: "copy-relative",
              label: "Copy relative path",
            },
          ]),
      {
        id: "copy-full",
        label: "Copy full path",
      },
    ]);
  });
});
