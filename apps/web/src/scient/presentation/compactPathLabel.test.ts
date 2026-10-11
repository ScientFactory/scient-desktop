import { describe, expect, it } from "vite-plus/test";

import { compactPathLabel, tracePathPresentation } from "./compactPathLabel";

describe("compactPathLabel", () => {
  it("keeps the last two segments of an absolute path", () => {
    expect(
      compactPathLabel(
        "/Users/someone/REPOs/worktrees/sync/apps/server/src/orchestration/Layers/ProviderCommandReactor.ts",
        undefined,
      ),
    ).toBe("Layers/ProviderCommandReactor.ts");
    expect(
      compactPathLabel("~/REPOs/worktrees/sync/packages/contracts/src/orchestration.ts", undefined),
    ).toBe("src/orchestration.ts");
    expect(compactPathLabel("C:\\Users\\someone\\project\\src\\app.ts", undefined)).toBe(
      "src/app.ts",
    );
  });

  it("shortens a path inside the workspace the same way", () => {
    expect(compactPathLabel("/work/project/apps/web/src/main.tsx", "/work/project")).toBe(
      "src/main.tsx",
    );
    expect(compactPathLabel("/work/project/README.md", "/work/project")).toBe("project/README.md");
  });

  it("keeps a line number with the file name", () => {
    expect(compactPathLabel("/work/project/src/deep/file.ts:42", undefined)).toBe(
      "deep/file.ts:42",
    );
  });

  it("leaves text that is not a single path unchanged", () => {
    for (const text of [
      "TODO in src",
      "Read upstream-alignment-protocol.md",
      "pnpm lint",
      "/Users/someone/a.ts\nsecond line",
      "node:internal/modules/esm/resolve:271 throw new ERR_MODULE_NOT_FOUND(",
    ]) {
      expect(compactPathLabel(text, undefined)).toBe(text);
    }
  });
});

describe("tracePathPresentation", () => {
  it.each([
    [
      "/work/project/apps/web/src/deep/view.tsx:42:9",
      "/work/project",
      "deep/view.tsx:42:9",
      "/work/project/apps/web/src/deep/view.tsx:42:9",
    ],
    [
      "~/REPOs/worktrees/sync/apps/web/view.tsx",
      "/work/project",
      "web/view.tsx",
      "~/REPOs/worktrees/sync/apps/web/view.tsx",
    ],
    [
      "apps/web/src/deep/view.tsx",
      "/work/project",
      "deep/view.tsx",
      "/work/project/apps/web/src/deep/view.tsx",
    ],
    ["README.md", "/work/project", "README.md", "/work/project/README.md"],
    ["README.md", "/", "README.md", "/README.md"],
    ["../other/notes.md", "/work/project", "other/notes.md", "/work/other/notes.md"],
    ["apps/web/view.tsx", undefined, "web/view.tsx", "apps/web/view.tsx"],
    ["C:\\other\\src\\view.tsx", "C:\\project", "src/view.tsx", "C:\\other\\src\\view.tsx"],
    ["src\\deep\\view.tsx", "C:\\project", "deep/view.tsx", "C:\\project\\src\\deep\\view.tsx"],
    [
      "\\\\host\\share\\deep\\view.tsx",
      "/work/project",
      "deep/view.tsx",
      "\\\\host\\share\\deep\\view.tsx",
    ],
    ["//host/share/deep/view.tsx", "/work/project", "deep/view.tsx", "//host/share/deep/view.tsx"],
    [
      "/work/project/notes/my file.tex",
      "/work/project",
      "notes/my file.tex",
      "/work/project/notes/my file.tex",
    ],
    [
      "/work/project/notes/with\\backslash.tex",
      "/work/project",
      "notes/with\\backslash.tex",
      "/work/project/notes/with\\backslash.tex",
    ],
  ])("retains the full target of %s", (path, root, label, fullPath) => {
    expect(tracePathPresentation(path!, root)).toEqual({ label, fullPath });
  });
});
