import { splitFilePathPosition } from "./fileLinks.ts";
import { parseFileUrlHref } from "./fileLinks.ts";
import { workspaceRelativeFilePath, fileBasename, collapseAbsoluteFilePath } from "./path.ts";
import { describe, expect, it } from "vite-plus/test";
import {
  extractMarkdownLinkHrefs,
  resolveMarkdownFileLinkTarget,
  isWindowsDrivePathHref,
} from "./markdownLinks.ts";

import {
  inlineCodeFilePathCandidate,
  isMarkdownFileLinkLabel,
  parseMarkdownFileLink,
} from "./markdownLinks.ts";

describe("isMarkdownFileLinkLabel", () => {
  it.each([
    ["validates the input", "/repo/src/example.ts:12", false],
    ["read src/example.ts", "/repo/src/example.ts:12", false],
    ["example.ts?why this matters", "/repo/src/example.ts", false],
    ["example.ts", "/repo/src/example.ts:12", true],
    ["example.ts:12", "/repo/src/example.ts:12", true],
    ["example.ts:99", "/repo/src/example.ts:12", false],
    ["example.ts:12:2", "/repo/src/example.ts:12:2", true],
    ["example.ts:12:3", "/repo/src/example.ts:12:2", false],
    ["example.ts:12", "/repo/src/example.ts", false],
    ["src/example.ts:12", "/repo/src/example.ts:12", true],
    ["./src/example.ts", "/repo/src/example.ts", true],
    ["/repo/src/example.ts", "/repo/src/example.ts", true],
    ["src/", "/home/me/project/src/", true],
    ["EXAMPLE.TS", "C:/repo/src/example.ts:12", true],
    ["file name.ts", "file:///repo/file%20name.ts", true],
    ["", "/repo/src/example.ts", true],
  ])("classifies %s for %s", (label, href, expected) => {
    expect(isMarkdownFileLinkLabel(label, href)).toBe(expected);
  });
});

describe("inlineCodeFilePathCandidate", () => {
  it.each([
    ["src\\main.ts", "src/main.ts"],
    ["C:\\Users\\demo\\image.png", "C:\\Users\\demo\\image.png"],
    ["\\\\server\\share\\image.png", "\\\\server\\share\\image.png"],
    ["conf.d/nginx.conf", "conf.d/nginx.conf"],
    ["script.pl:10", "script.pl:10"],
    ["node.meta", null],
    ["src/**/*.ts", null],
    ["docs/Report(draft).md", null],
    ["docs/סיכום.md", null],
    ["Recorded evidence here: /tmp/image.png", null],
    ["origin/main", null],
    ["127.0.0.1:3000", null],
    ["example.com/index.html", null],
    ["example.pl/index.html", null],
    ["z-ai/glm-5.3", null],
    ["z-ai/glm-5.3:12", null],
    ["python/3.12", null],
    ["Qwen/Qwen2.5-Coder", null],
    ["meta-llama/Llama-3.1-8B", null],
    ["share/man/ls.1", "share/man/ls.1"],
    ["usr/lib/libfoo.so.1", "usr/lib/libfoo.so.1"],
    ["vendor/jquery-3.6.0.min.js", "vendor/jquery-3.6.0.min.js"],
    ["./models/glm-5.3", "./models/glm-5.3"],
  ])("distinguishes file paths from code and hostnames in %s", (source, candidate) => {
    expect(inlineCodeFilePathCandidate(source)).toBe(candidate);
  });
});

describe("parseFileUrlHref", () => {
  it.each([
    ["file:///Users/julius/project/src/main.ts#L42", "/Users/julius/project/src/main.ts", "#L42"],
    [
      "file:///D:/Programme/t3code/OpenInPicker.tsx#L69",
      "D:/Programme/t3code/OpenInPicker.tsx",
      "#L69",
    ],
    ["file://server/share/workspace-image.svg", "\\\\server\\share\\workspace-image.svg", ""],
    ["file://localhost/home/me/notes.md", "/home/me/notes.md", ""],
  ])("parses %s", (href, path, hash) => {
    expect(parseFileUrlHref(href)).toEqual({ path, hash });
  });

  it("keeps percent-encoding so the caller decodes once", () => {
    expect(parseFileUrlHref("file:///Users/julius/project/file%2520name.md")?.path).toBe(
      "/Users/julius/project/file%2520name.md",
    );
    expect(parseFileUrlHref("file:///c%3A/Users/x/shot.png")?.path).toBe("/c%3A/Users/x/shot.png");
  });

  it.each(["https://example.com/a.ts", "file://%", "/Users/julius/a.ts"])("rejects %s", (href) => {
    expect(parseFileUrlHref(href)).toBeNull();
  });
});

describe("splitFilePathPosition", () => {
  it.each([
    ["src/main.ts", "", { path: "src/main.ts" }],
    ["src/main.ts:12", "", { path: "src/main.ts", line: 12 }],
    ["src/main.ts:12:5", "", { path: "src/main.ts", line: 12, column: 5 }],
    ["src/main.ts", "#L18C2", { path: "src/main.ts", line: 18, column: 2 }],
    ["src/main.ts:3", "#L18C2", { path: "src/main.ts", line: 3 }],
    ["src/main.ts:0", "", { path: "src/main.ts" }],
    ["src/main.ts", "#section", { path: "src/main.ts" }],
  ])("splits %s%s", (path, hash, expected) => {
    expect(splitFilePathPosition(path, hash)).toEqual(expected);
  });
});

describe("parseMarkdownFileLink", () => {
  // Both clients consume this table, so a path the web app recognizes is one
  // the mobile app recognizes too.
  it.each([
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
    ["C:%5Crepo%5Cimage.png", "C:\\repo\\image.png"],
    ["\\\\server\\share\\image.png", "\\\\server\\share\\image.png"],
    ["/D:/Programme/t3code/OpenInPicker.tsx", "D:/Programme/t3code/OpenInPicker.tsx"],
    ["</D:/Programme/t3code/ChatMarkdown.tsx:1>", "D:/Programme/t3code/ChatMarkdown.tsx"],
    ["file:///Users/julius/project/file%2520name.md", "/Users/julius/project/file%20name.md"],
    ["file://server/share/workspace-image.svg", "\\\\server\\share\\workspace-image.svg"],
    ["file://localhost/home/me/notes.md", "/home/me/notes.md"],
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
  ])("recognizes %s as a file", (href, path) => {
    expect(parseMarkdownFileLink(href)?.path).toBe(path);
  });

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
  ])("does not treat %s as a file", (href) => {
    expect(parseMarkdownFileLink(href)).toBeNull();
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

describe("fileBasename", () => {
  it.each([
    ["/tmp/favicons/", "favicons"],
    ["C:\\Users\\kelchm\\.claude\\", ".claude"],
    ["/tmp/", "tmp"],
    ["AGENTS.md", "AGENTS.md"],
    ["/", "/"],
  ])("labels %s as %s", (path, basename) => {
    expect(fileBasename(path)).toBe(basename);
  });
});

describe("workspaceRelativeFilePath", () => {
  it.each([
    ["/repo/project", "/repo/project", "."],
    ["/repo/project/", "/repo/project/", "."],
    ["/", "/", "."],
    ["C:/USERS/mike/project", "c:/users/MIKE/project", "."],
    ["C:/", "c:/", "."],
    ["/repo/project/src/main.ts", "/repo/project", "src/main.ts"],
    ["/repo/project/src/main.ts", "/repo/project/", "src/main.ts"],
    ["C:\\Users\\mike\\t3code\\apps\\web\\a.ts", "C:/Users/mike/t3code", "apps/web/a.ts"],
    ["/C:/Users/mike/t3code/apps/web/a.ts", "C:/Users/mike/t3code", "apps/web/a.ts"],
    ["/Repo/Project/src/main.ts", "/repo/project", null],
    ["/tmp/case/project/probe.txt", "/tmp/case/Project", null],
    ["//tmp/case/project/probe.txt", "//tmp/case/Project", null],
    ["/tmp/case/Project/probe.txt", "/tmp/case/Project", "probe.txt"],
    ["C:/USERS/mike/t3code/main.ts", "c:/users/MIKE/t3code", "main.ts"],
    ["/C:/USERS/mike/t3code/main.ts", "/c:/users/MIKE/t3code", "main.ts"],
    ["\\\\server\\share\\PROJECT\\main.ts", "\\\\Server\\Share\\Project", "main.ts"],
    ["/tmp/repo/file.ts", "/", "tmp/repo/file.ts"],
    ["C:/Users/MIKE/main.ts", "c:/", "Users/MIKE/main.ts"],
    ["\\\\server\\SHARE\\file.ts", "\\\\Server\\Share\\", "file.ts"],
    ["/tmp/repo/file.ts ", "/tmp/repo", "file.ts "],
    ["/tmp/report.ts", "/repo/project", null],
    ["/repo/project-two/a.ts", "/repo/project", null],
    ["/repo/project/a.ts", undefined, null],
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
  ])("relates %s to %s", (path, workspaceRoot, relativePath) => {
    expect(workspaceRelativeFilePath(path, workspaceRoot)).toBe(relativePath);
  });
});

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

describe("isWindowsDrivePathHref", () => {
  it.each([
    ["C:\\repo\\image.png", true],
    ["C:%5Crepo%5Cimage.png", true],
    ["https://example.com/image.png", false],
  ])("classifies %s as %s", (href, expected) => {
    expect(isWindowsDrivePathHref(href)).toBe(expected);
  });
});

describe("extractMarkdownLinkHrefs", () => {
  it("extracts angle-bracketed paths containing spaces", () => {
    expect(
      extractMarkdownLinkHrefs(
        "[Open the Bike Receipts folder](</Users/dara/Downloads/Lime Ride Artifacts/Bike Receipts>)",
      ),
    ).toEqual(["/Users/dara/Downloads/Lime Ride Artifacts/Bike Receipts"]);
  });

  it("preserves ordinary destinations and ignores link titles", () => {
    expect(
      extractMarkdownLinkHrefs(
        '[source](apps/web/src/markdown-links.ts "implementation") and [docs](https://example.com)',
      ),
    ).toEqual(["apps/web/src/markdown-links.ts", "https://example.com"]);
  });
});

describe("resolveMarkdownFileLinkTarget", () => {
  it("resolves absolute posix file paths", () => {
    expect(resolveMarkdownFileLinkTarget("/Users/julius/project/AGENTS.md")).toBe(
      "/Users/julius/project/AGENTS.md",
    );
  });

  it("resolves relative file paths against cwd", () => {
    expect(resolveMarkdownFileLinkTarget("src/processRunner.ts:71", "/Users/julius/project")).toBe(
      "/Users/julius/project/src/processRunner.ts:71",
    );
  });

  it("does not treat filename line references as external schemes", () => {
    expect(resolveMarkdownFileLinkTarget("script.ts:10", "/Users/julius/project")).toBe(
      "/Users/julius/project/script.ts:10",
    );
  });

  it("resolves bare file names against cwd", () => {
    expect(resolveMarkdownFileLinkTarget("AGENTS.md", "/Users/julius/project")).toBe(
      "/Users/julius/project/AGENTS.md",
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

  it("resolves file uri authorities as windows UNC paths", () => {
    expect(resolveMarkdownFileLinkTarget("file://server/share/workspace-image.svg")).toBe(
      "\\\\server\\share\\workspace-image.svg",
    );
  });

  it("resolves a localhost file uri as a local path", () => {
    expect(resolveMarkdownFileLinkTarget("file://localhost/home/me/notes.md")).toBe(
      "/home/me/notes.md",
    );
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

  it("resolves angle-bracketed windows drive paths", () => {
    expect(
      resolveMarkdownFileLinkTarget(
        "</D:/Programme/t3code/apps/web/src/components/ChatMarkdown.tsx:1>",
      ),
    ).toBe("D:/Programme/t3code/apps/web/src/components/ChatMarkdown.tsx:1");
  });

  it("does not treat app routes as file links, even with a line anchor", () => {
    expect(resolveMarkdownFileLinkTarget("/chat/settings")).toBeNull();
    expect(resolveMarkdownFileLinkTarget("/chat/settings#L3", "/repo")).toBeNull();
  });

  it("decodes an encoded drive colon in a file uri before dropping its slash", () => {
    expect(resolveMarkdownFileLinkTarget("file:///c%3A/Users/x/shot.png")).toBe(
      "c:/Users/x/shot.png",
    );
  });
});
