// SCIENT-FORK:START
import { workspaceRelativeFilePath, collapseAbsoluteFilePath } from "./path.ts";
// SCIENT-FORK:END
import { describe, expect, it } from "vite-plus/test";
import { extractMarkdownLinkHrefs, resolveMarkdownFileLinkTarget } from "./markdownLinks.ts";

import {
  inlineCodeFilePathCandidate,
  isMarkdownFileLinkLabel,
  parseMarkdownFileLink,
} from "./markdownLinks.ts";

describe("isMarkdownFileLinkLabel", () => {
  // regression: #15509 descriptive labels are not mistaken for the linked file name
  it.each([
    ["validates the input", "/repo/src/example.ts:12", false],
    ["example.ts:12", "/repo/src/example.ts:12", true],
    ["example.ts:99", "/repo/src/example.ts:12", false],
  ])("classifies %s for %s", (label, href, expected) => {
    expect(isMarkdownFileLinkLabel(label, href)).toBe(expected);
  });
});

describe("inlineCodeFilePathCandidate", () => {
  // regression: #13909 model ids in inline code do not become file chips
  it.each([
    ["src\\main.ts", "src/main.ts"],
    // SCIENT-FORK:START
    ["C:\\Users\\demo\\image.png", "C:\\Users\\demo\\image.png"],
    ["\\\\server\\share\\image.png", "\\\\server\\share\\image.png"],
    ["conf.d/nginx.conf", "conf.d/nginx.conf"],
    ["script.pl:10", "script.pl:10"],
    ["node.meta", null],
    ["src/**/*.ts", null],
    ["docs/Report(draft).md", null],
    ["docs/סיכום.md", null],
    ["Recorded evidence here: /tmp/image.png", null],
    // SCIENT-FORK:END
    ["origin/main", null],
    ["z-ai/glm-5.3", null],
    ["share/man/ls.1", "share/man/ls.1"],
    ["src/main.ts/", null],
    ["./patches/", "./patches/"],
  ])("distinguishes file paths from code and hostnames in %s", (source, candidate) => {
    expect(inlineCodeFilePathCandidate(source)).toBe(candidate);
  });
});

describe("parseMarkdownFileLink", () => {
  it.each([
    // SCIENT-FORK:START
    ["/Users/julius/project/AGENTS.md", "/Users/julius/project/AGENTS.md"],
    ["/home/me/notes.md", "/home/me/notes.md"],
    ["/usr/local/bin/tool", "/usr/local/bin/tool"],
    ["/workspace/Makefile", "/workspace/Makefile"],
    ["/tmp/favicons/", "/tmp/favicons/"],
    ["C:\\Users\\mike\\project\\src\\main.ts", "C:\\Users\\mike\\project\\src\\main.ts"],
    [
      "C:/Users/Sacha/OneDrive/Bureau/REPOs/רפואה שנה א/dashboard.html",
      "C:/Users/Sacha/OneDrive/Bureau/REPOs/רפואה שנה א/dashboard.html",
    ],
    // SCIENT-FORK:END
    ["C:%5Crepo%5Cimage.png", "C:\\repo\\image.png"],
    ["</D:/Programme/t3code/ChatMarkdown.tsx:1>", "D:/Programme/t3code/ChatMarkdown.tsx"],
    ["file://localhost/home/me/notes.md", "/home/me/notes.md"],
    // SCIENT-FORK:START
    ["apps/mobile/src/index.ts:10", "apps/mobile/src/index.ts"],
    ["docs/My%20Folder/checklist.xml", "docs/My Folder/checklist.xml"],
    ["Updated%20cutover%20checklist.md", "Updated cutover checklist.md"],
    ["LTC - Cystic Fibrosis - new (readable).md", "LTC - Cystic Fibrosis - new (readable).md"],
    ["Report%20%28readable%29.md", "Report (readable).md"],
    ["סיכום.md", "סיכום.md"],
    ["Résumé & results.md", "Résumé & results.md"],
    ["🧪 Study [final].md", "🧪 Study [final].md"],
    ["Folder (draft)/סיכום [final].md:12:3", "Folder (draft)/סיכום [final].md"],
    ["Report%23one%3Ftwo.md#L12", "Report#one?two.md"],
    ["Report%2528draft%2529.md", "Report%28draft%29.md"],
    ["./scripts/deploy", "./scripts/deploy"],
    ["~/notes/today.md", "~/notes/today.md"],
    ["AGENTS.md", "AGENTS.md"],
    ["script.ts:10", "script.ts"],
    ["/tmp/clip%23one.mp4#t=2", "/tmp/clip#one.mp4"],
    // SCIENT-FORK:END
  ])("recognizes %s as a file", (href, path) => {
    expect(parseMarkdownFileLink(href)?.path).toBe(path);
  });

  // SCIENT-FORK:START
  it.each([
    "",
    "#anchor",
    "//cdn.example.com/clip.mp4",
    "https://example.com/docs",
    "mailto:someone@example.com",
    "javascript:alert(1)",
    "sandbox:/mnt/data/Report%20(readable).md",
    "scient://app/סיכום.md",
    "Report%00.md",
    "Report%09draft.md",
    "Folder/Report%0Adraft.md",
    "/chat/settings",
    "/chat/settings#L3",
    "/app#L1",
    "readme",
    "TODO:12",
    "patches",
  ])("does not treat %s as a file", (href) => {
    expect(parseMarkdownFileLink(href)).toBeNull();
  });
  // SCIENT-FORK:END

  it("recognizes a relative folder that ends in a slash", () => {
    expect(parseMarkdownFileLink("patches/")).toEqual({ path: "patches/" });
    expect(parseMarkdownFileLink("docs/My%20Folder/")?.path).toBe("docs/My Folder/");
  });

  it("accepts conventional extensionless names with or without a position", () => {
    expect(parseMarkdownFileLink("Makefile")).toEqual({ path: "Makefile" });
    expect(parseMarkdownFileLink("Dockerfile:8")).toEqual({ path: "Dockerfile", line: 8 });
    expect(parseMarkdownFileLink("/srv/app/Makefile")).toEqual({ path: "/srv/app/Makefile" });
  });

  it("reads positions from suffixes and line anchors", () => {
    expect(parseMarkdownFileLink("/Users/julius/project/src/main.ts#L42C7")).toEqual({
      path: "/Users/julius/project/src/main.ts",
      line: 42,
      column: 7,
    });
    expect(parseMarkdownFileLink("file://server/share/src/main.ts#L42C7")).toMatchObject({
      path: "\\\\server\\share\\src\\main.ts",
      line: 42,
      column: 7,
    });
  });
});

describe("workspaceRelativeFilePath", () => {
  // regression: #12449 workspace root links resolve to "."
  it.each([
    ["/repo/project", "/repo/project", "."],
    ["C:/", "c:/", "."],
    ["/repo/project/a.ts", undefined, null],
    // SCIENT-FORK:START
    // Dot segments are resolved before deciding containment.
    ["/repo/project/../notes.md", "/repo/project", null],
    ["/repo/project/../project-two/a.ts", "/repo/project", null],
    ["/repo/project/docs/../src/./a.ts", "/repo/project", "src/a.ts"],
    ["/repo/other/../project/a.ts", "/repo/project", "a.ts"],
    ["C:\\repo\\..\\other\\a.ts", "C:\\repo", null],
    // On POSIX a backslash is part of the file name and survives.
    ["/tmp/repo/a\\b.md", "/tmp/repo", "a\\b.md"],
    // A path that resolves to the root itself is the workspace, written `.`.
    ["/repo/project/docs/..", "/repo/project", "."],
    // SCIENT-FORK:END
  ])("relates %s to %s", (path, workspaceRoot, relativePath) => {
    expect(workspaceRelativeFilePath(path, workspaceRoot)).toBe(relativePath);
  });
});

// SCIENT-FORK:START
describe("collapseAbsoluteFilePath", () => {
  it.each([
    ["/Users/me/project/../reviews/notes.md", "/Users/me/reviews/notes.md"],
    ["/a/./b//c/", "/a/b/c"],
    ["/../../etc/hosts", "/etc/hosts"],
    ["/", "/"],
    ["C:\\repo\\..\\other\\a.ts", "C:\\other\\a.ts"],
    ["C:/repo/../other/a.ts", "C:/other/a.ts"],
    ["/C:/repo/../a.ts", "C:/a.ts"],
    ["C:\\..\\a.ts", "C:\\a.ts"],
    ["\\\\server\\share\\docs\\..\\a.ts", "\\\\server\\share\\a.ts"],
    ["\\\\server\\share\\..\\..\\a.ts", "\\\\server\\share\\a.ts"],
    // On POSIX a backslash is part of a file name, never a separator.
    ["/tmp/reports/a\\b.md", "/tmp/reports/a\\b.md"],
    ["/tmp/reports/x/../a\\..\\b.md", "/tmp/reports/a\\..\\b.md"],
    // `//` could be POSIX or a forward-slash UNC share; it is left as written.
    ["//server/share/docs/../a.ts", "//server/share/docs/../a.ts"],
    ["///tmp/a/../b.md", "/tmp/b.md"],
    // Relative paths are left alone: only the host knows their base.
    ["../reviews/notes.md", "../reviews/notes.md"],
    ["docs/./a.md", "docs/./a.md"],
  ])("collapses %s to %s", (path, collapsed) => {
    expect(collapseAbsoluteFilePath(path)).toBe(collapsed);
  });
});

// SCIENT-FORK:END
describe("extractMarkdownLinkHrefs", () => {
  it.each([
    ["[".repeat(32_000), []],
    ["[a](<foo)bar> invalid [b](ok)", ["<foo", "ok"]],
    ["[[[nested](src/main.ts) [unfinished", ["src/main.ts"]],
  ])("extracts links from incomplete and nested text", (markdown, hrefs) => {
    expect(extractMarkdownLinkHrefs(markdown)).toEqual(hrefs);
  });
});

describe("resolveMarkdownFileLinkTarget", () => {
  it("resolves a relative folder with a trailing slash against cwd", () => {
    expect(resolveMarkdownFileLinkTarget("patches/", "/repo/project")).toBe(
      "/repo/project/patches/",
    );
    expect(resolveMarkdownFileLinkTarget("patches", "/repo/project")).toBeNull();
  });

  it("does not treat filename line references as external schemes", () => {
    expect(resolveMarkdownFileLinkTarget("script.ts:10", "/Users/julius/project")).toBe(
      "/Users/julius/project/script.ts:10",
    );
  });

  it("maps #L line anchors to editor line suffixes", () => {
    expect(resolveMarkdownFileLinkTarget("/Users/julius/project/src/main.ts#L42C7")).toBe(
      "/Users/julius/project/src/main.ts:42:7",
    );
  });

  it("ignores external urls", () => {
    expect(resolveMarkdownFileLinkTarget("https://example.com/docs")).toBeNull();
    expect(resolveMarkdownFileLinkTarget("//cdn.example.com/clip.mp4", "/workspace")).toBeNull();
  });

  it("does not double-decode file URLs", () => {
    expect(resolveMarkdownFileLinkTarget("file:///Users/julius/project/file%2520name.md")).toBe(
      "/Users/julius/project/file%20name.md",
    );
  });

  it("links a network path only inside the project's share", () => {
    const cwd = "\\\\server\\share";
    expect(resolveMarkdownFileLinkTarget("file://server/share/workspace-image.svg", cwd)).toBe(
      "\\\\server\\share\\workspace-image.svg",
    );
    // Opening these sent the Windows user's NTLM credentials to attacker.test.
    for (const href of ["file://attacker.test/s/x.ts", "\\\\attacker.test\\s\\x.ts"]) {
      expect(resolveMarkdownFileLinkTarget(href, cwd)).toBeNull();
    }
  });

  it("keeps an encoded final space in the absolute target", () => {
    expect(resolveMarkdownFileLinkTarget("/tmp/repo/file.ts%20", "/tmp/repo")).toBe(
      "/tmp/repo/file.ts ",
    );
  });

  it("normalizes slash-prefixed windows drive paths before resolving", () => {
    expect(
      resolveMarkdownFileLinkTarget(
        "/D:/Programme/t3code/apps/web/src/components/chat/OpenInPicker.tsx#L69",
      ),
    ).toBe("D:/Programme/t3code/apps/web/src/components/chat/OpenInPicker.tsx:69");
  });

  it("decodes an encoded drive colon in a file uri before dropping its slash", () => {
    expect(resolveMarkdownFileLinkTarget("file:///c%3A/Users/x/shot.png")).toBe(
      "c:/Users/x/shot.png",
    );
  });
});
