import { describe, expect, it } from "vite-plus/test";

import {
  fileBreadcrumbChildren,
  fileBreadcrumbs,
  fileTabTitles,
  resolveFileTabPath,
  retainedBreadcrumbTrail,
  workspaceFileHostPath,
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
  it("starts host paths outside the workspace at the filesystem root", () => {
    expect(fileBreadcrumbs("t3code", "/tmp/t3-cleanup/report.md")).toEqual([
      { label: "tmp", path: "/tmp", kind: "directory" },
      { label: "t3-cleanup", path: "/tmp/t3-cleanup", kind: "directory" },
      { label: "report.md", path: "/tmp/t3-cleanup/report.md", kind: "file" },
    ]);
    expect(fileBreadcrumbs("t3code", "C:\\Temp\\report.md")).toEqual([
      { label: "C:", path: "C:\\", kind: "directory" },
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

  it("honors segment boundaries and sorts folders before files", () => {
    expect(fileBreadcrumbChildren(entries, "src")).toEqual([
      { path: "src/lib", kind: "directory", label: "lib" },
      { path: "src/index.ts", kind: "file", label: "index.ts" },
    ]);
  });
});

describe("retainedBreadcrumbTrail", () => {
  it.each([
    ["apps/web/src", "apps/web", "apps/web/src"],
    ["apps/web/src", "", "apps/web/src"],
    ["apps/web/src", "apps/web/src", "apps/web/src"],
    ["apps/web/src", "apps/mobile", "apps/mobile"],
    ["src/lib", "src-old", "src-old"],
    ["apps/web", "apps/web/src/main.tsx", "apps/web/src/main.tsx"],
    ["apps/web/src", "/tmp/report", "/tmp/report"],
    ["/tmp/report", "", ""],
    ["C:\\Temp\\a", "", ""],
    ["/Users/me/projects/scope", "/Users/me", "/Users/me/projects/scope"],
    ["/Users/me/projects/scope", "/Users/me/proj", "/Users/me/proj"],
    ["/Volumes/Work/a", "/Volumes/Work/a/", "/Volumes/Work/a"],
    ["C:\\Users\\me\\scope", "C:\\", "C:\\Users\\me\\scope"],
    ["C:\\Users\\me\\scope", "C:\\Users", "C:\\Users\\me\\scope"],
    ["C:\\Users\\me\\scope", "D:\\", "D:\\"],
    ["\\\\nas\\share\\docs\\notes", "\\\\nas\\share", "\\\\nas\\share\\docs\\notes"],
  ])("from trail %j to %j keeps %j", (trail, path, expected) => {
    expect(retainedBreadcrumbTrail(trail, path)).toBe(expected);
  });
});

describe("workspaceFileHostPath", () => {
  it("joins a workspace locator to its root and leaves a host path alone", () => {
    expect(workspaceFileHostPath("docs/a.md", "/repo")).toBe("/repo/docs/a.md");
    expect(workspaceFileHostPath("docs/a.md", "/repo/")).toBe("/repo/docs/a.md");
    expect(workspaceFileHostPath("docs/a.md", "C:\\repo")).toBe("C:\\repo\\docs\\a.md");
    expect(workspaceFileHostPath("/tmp/a.md", "/repo")).toBe("/tmp/a.md");
    expect(workspaceFileHostPath("C:\\tmp\\a.md", "/repo")).toBe("C:\\tmp\\a.md");
  });

  it("keeps a workspace folder named ~ under the workspace, never the home folder", () => {
    expect(workspaceFileHostPath("~/notes.md", "/Users/ada/project")).toBe(
      "/Users/ada/project/~/notes.md",
    );
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
    expect(titles.get("drafts/a/plan.md")).toBe("plan.md (a)");
    expect(titles.get("drafts/b/plan.md")).toBe("plan.md (b)");
    expect(titles.get("notes.md")).toBe("notes.md");
  });

  it("goes further up only as far as needed", () => {
    const titles = fileTabTitles(["x/shared/plan.md", "y/shared/plan.md", "z/other/plan.md"]);
    expect(titles.get("x/shared/plan.md")).toBe("plan.md (x/shared)");
    expect(titles.get("y/shared/plan.md")).toBe("plan.md (y/shared)");
    expect(titles.get("z/other/plan.md")).toBe("plan.md (other)");
  });

  it("keeps a root-level file bare and still distinguishes the others", () => {
    const titles = fileTabTitles(["plan.md", "drafts/plan.md", "/Users/me/out/plan.md"]);
    expect(titles.get("plan.md")).toBe("plan.md");
    expect(titles.get("drafts/plan.md")).toBe("plan.md (drafts)");
    expect(titles.get("/Users/me/out/plan.md")).toBe("plan.md (out)");
  });

  it("tells a host file from a workspace file whose folders are spelled alike", () => {
    const titles = fileTabTitles(["tmp/report.md", "/tmp/report.md", "\\\\nas\\tmp\\report.md"]);
    expect(titles.get("tmp/report.md")).toBe("report.md (tmp)");
    expect(titles.get("/tmp/report.md")).toBe("report.md (/tmp)");
    expect(titles.get("\\\\nas\\tmp\\report.md")).toBe("report.md (\\\\nas/tmp)");
  });

  it("keeps a POSIX backslash as part of a folder's name", () => {
    const titles = fileTabTitles(["/tmp/a\\b/report.md", "/tmp/a/b/report.md"]);
    expect(titles.get("/tmp/a\\b/report.md")).toBe("report.md (a\\b)");
    expect(titles.get("/tmp/a/b/report.md")).toBe("report.md (b)");
  });

  it("handles Windows separators and a path opened twice", () => {
    const titles = fileTabTitles(["C:\\work\\a\\plan.md", "b/plan.md", "b/plan.md"]);
    expect(titles.get("C:\\work\\a\\plan.md")).toBe("plan.md (a)");
    expect(titles.get("b/plan.md")).toBe("plan.md (b)");
  });
});
