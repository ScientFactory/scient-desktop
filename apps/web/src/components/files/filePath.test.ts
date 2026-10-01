import { describe, expect, it } from "vite-plus/test";

import {
  fileTabTitles,
  fileBreadcrumbChildren,
  fileBreadcrumbParent,
  fileBreadcrumbs,
  resolveFileTabPath,
} from "./filePath";

describe("resolveFileTabPath", () => {
  it("turns a path that climbs out of the workspace into the host path it names", () => {
    expect(
      resolveFileTabPath("../reviews/document-editing/notes.md", "/Users/me/ScientFactory"),
    ).toBe("/Users/me/reviews/document-editing/notes.md");
    expect(resolveFileTabPath("docs/../../notes.md", "/Users/me/ScientFactory/")).toBe(
      "/Users/me/notes.md",
    );
    expect(resolveFileTabPath("..\\notes.md", "C:\\work\\project")).toBe("C:\\work\\notes.md");
  });

  it("leaves workspace paths, absolute paths, and attachment tabs unchanged", () => {
    expect(resolveFileTabPath("docs/notes.md", "/repo")).toBe("docs/notes.md");
    expect(resolveFileTabPath("docs/../notes.md", "/repo")).toBe("docs/../notes.md");
    expect(resolveFileTabPath("/tmp/report.md", "/repo")).toBe("/tmp/report.md");
    expect(resolveFileTabPath("../notes.md", "")).toBe("../notes.md");
    // On POSIX a workspace folder may be named with a trailing backslash.
    expect(resolveFileTabPath("notes.md", "/tmp/project\\")).toBe("notes.md");
    expect(resolveFileTabPath("../notes.md", "/tmp/project\\")).toBe("/tmp/notes.md");
  });
});

describe("fileBreadcrumbs", () => {
  it("builds project, directory, and file crumbs", () => {
    expect(fileBreadcrumbs("t3code", "apps/web/src/main.tsx")).toEqual([
      { label: "t3code", path: "", kind: "project" },
      { label: "apps", path: "apps", kind: "directory" },
      { label: "web", path: "apps/web", kind: "directory" },
      { label: "src", path: "apps/web/src", kind: "directory" },
      { label: "main.tsx", path: "apps/web/src/main.tsx", kind: "file" },
    ]);
  });

  it("normalizes repeated separators", () => {
    expect(fileBreadcrumbs("workspace", "src//index.ts").map((crumb) => crumb.label)).toEqual([
      "workspace",
      "src",
      "index.ts",
    ]);
  });

  it("starts host paths outside the workspace at the filesystem root", () => {
    expect(fileBreadcrumbs("t3code", "/tmp/t3-cleanup/report.md")).toEqual([
      { label: "tmp", path: "/tmp", kind: "directory" },
      { label: "t3-cleanup", path: "/tmp/t3-cleanup", kind: "directory" },
      { label: "report.md", path: "/tmp/t3-cleanup/report.md", kind: "file" },
    ]);
    expect(fileBreadcrumbs("t3code", "C:\\Temp\\report.md")).toEqual([
      { label: "C:", path: "C:", kind: "directory" },
      { label: "Temp", path: "C:\\Temp", kind: "directory" },
      { label: "report.md", path: "C:\\Temp\\report.md", kind: "file" },
    ]);
    expect(fileBreadcrumbs("t3code", "\\\\server\\share\\report.md").map((c) => c.path)).toEqual([
      "\\\\server",
      "\\\\server\\share",
      "\\\\server\\share\\report.md",
    ]);
  });
});

describe("fileBreadcrumbChildren", () => {
  const entries = [
    { path: "README.md", kind: "file" as const },
    { path: "src", kind: "directory" as const },
    { path: "src-old", kind: "directory" as const },
    { path: "src/index.ts", kind: "file" as const },
    { path: "src/lib", kind: "directory" as const },
    { path: "src/lib/file10.ts", kind: "file" as const },
    { path: "src/lib/file2.ts", kind: "file" as const },
    { path: "src-old/index.ts", kind: "file" as const },
  ];

  it("returns only the immediate children of the project root", () => {
    expect(fileBreadcrumbChildren(entries, "")).toEqual([
      { path: "src", kind: "directory", label: "src" },
      { path: "src-old", kind: "directory", label: "src-old" },
      { path: "README.md", kind: "file", label: "README.md" },
    ]);
  });

  it("honors segment boundaries and sorts folders before files", () => {
    expect(fileBreadcrumbChildren(entries, "src")).toEqual([
      { path: "src/lib", kind: "directory", label: "lib" },
      { path: "src/index.ts", kind: "file", label: "index.ts" },
    ]);
  });

  it("uses natural file-name ordering and preserves input order for equivalent names", () => {
    const files = ["file10.ts", "File2.ts", "file02.ts", "file2.ts"].map((name) => ({
      path: `src/lib/${name}`,
      kind: "file" as const,
    }));

    expect(fileBreadcrumbChildren(files, "src/lib").map((entry) => entry.label)).toEqual([
      "File2.ts",
      "file02.ts",
      "file2.ts",
      "file10.ts",
    ]);
  });

  it("returns an empty list for an empty or missing directory", () => {
    expect(fileBreadcrumbChildren(entries, "missing")).toEqual([]);
  });
});

describe("fileBreadcrumbParent", () => {
  it.each([
    ["src/lib", "src"],
    ["src", ""],
    ["", null],
  ])("returns the parent of %j", (path, expected) => {
    expect(fileBreadcrumbParent(path)).toBe(expected);
  });
});

describe("fileTabTitles", () => {
  it("uses the bare name when no other open file shares it", () => {
    expect([...fileTabTitles(["drafts/a/plan.md", "README.md"])]).toEqual([
      ["drafts/a/plan.md", "plan.md"],
      ["README.md", "README.md"],
    ]);
  });

  it("adds the shortest folders that tell same-name files apart", () => {
    const titles = fileTabTitles(["drafts/a/plan.md", "drafts/b/plan.md", "notes.md"]);
    expect(titles.get("drafts/a/plan.md")).toBe("plan.md — a");
    expect(titles.get("drafts/b/plan.md")).toBe("plan.md — b");
    expect(titles.get("notes.md")).toBe("notes.md");
  });

  it("goes further up only as far as needed", () => {
    const titles = fileTabTitles(["x/shared/plan.md", "y/shared/plan.md", "z/other/plan.md"]);
    expect(titles.get("x/shared/plan.md")).toBe("plan.md — x/shared");
    expect(titles.get("y/shared/plan.md")).toBe("plan.md — y/shared");
    expect(titles.get("z/other/plan.md")).toBe("plan.md — other");
  });

  it("keeps a root-level file bare and still distinguishes the others", () => {
    const titles = fileTabTitles(["plan.md", "drafts/plan.md", "/Users/me/out/plan.md"]);
    expect(titles.get("plan.md")).toBe("plan.md");
    expect(titles.get("drafts/plan.md")).toBe("plan.md — drafts");
    expect(titles.get("/Users/me/out/plan.md")).toBe("plan.md — out");
  });

  it("handles Windows separators and a path opened twice", () => {
    const titles = fileTabTitles(["C:\\work\\a\\plan.md", "b/plan.md", "b/plan.md"]);
    expect(titles.get("C:\\work\\a\\plan.md")).toBe("plan.md — a");
    expect(titles.get("b/plan.md")).toBe("plan.md — b");
  });
});
