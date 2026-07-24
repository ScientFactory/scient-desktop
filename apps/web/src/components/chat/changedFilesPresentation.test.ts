import { describe, expect, it } from "vitest";

import {
  CHANGED_FILES_AUTO_EXPAND_FILE_LIMIT,
  CHANGED_FILES_AUTO_EXPAND_LINE_LIMIT,
  compactChangedFilePath,
  resolveChangedFilesPresentation,
  selectChangedFilePreview,
  shouldAutoExpandChangedFiles,
} from "./changedFilesPresentation";

const file = (path: string, additions = 1, deletions = 0) => ({
  path,
  additions,
  deletions,
});

describe("changed-files presentation defaults", () => {
  it("auto-expands only the current small, low-churn change", () => {
    const smallChange = [file("src/a.ts", 80, 20), file("src/b.ts", 60, 20)];

    expect(shouldAutoExpandChangedFiles(smallChange, true)).toBe(true);
    expect(shouldAutoExpandChangedFiles(smallChange, false)).toBe(false);
  });

  it("collapses the current change above either bulk threshold", () => {
    expect(
      shouldAutoExpandChangedFiles(
        Array.from({ length: CHANGED_FILES_AUTO_EXPAND_FILE_LIMIT + 1 }, (_, index) =>
          file(`src/${index}.ts`),
        ),
        true,
      ),
    ).toBe(false);
    expect(
      shouldAutoExpandChangedFiles(
        [file("src/large.ts", CHANGED_FILES_AUTO_EXPAND_LINE_LIMIT + 1)],
        true,
      ),
    ).toBe(false);
  });

  it("keeps the documented limits inclusive", () => {
    expect(
      shouldAutoExpandChangedFiles(
        Array.from({ length: CHANGED_FILES_AUTO_EXPAND_FILE_LIMIT }, (_, index) =>
          file(
            `src/${index}.ts`,
            CHANGED_FILES_AUTO_EXPAND_LINE_LIMIT / CHANGED_FILES_AUTO_EXPAND_FILE_LIMIT,
          ),
        ),
        true,
      ),
    ).toBe(true);
  });

  it("resolves expanded, preview, and collapsed defaults without overriding the user", () => {
    const bulkyFiles = Array.from(
      { length: CHANGED_FILES_AUTO_EXPAND_FILE_LIMIT + 1 },
      (_, index) => file(`src/${index}.ts`),
    );
    const files = [file("src/a.ts")];

    expect(resolveChangedFilesPresentation({ files, isCurrentChange: true })).toBe("expanded");
    expect(resolveChangedFilesPresentation({ files: bulkyFiles, isCurrentChange: true })).toBe(
      "preview",
    );
    expect(
      resolveChangedFilesPresentation({
        files: [file("src/high-churn.ts", CHANGED_FILES_AUTO_EXPAND_LINE_LIMIT + 1)],
        isCurrentChange: true,
      }),
    ).toBe("preview");
    expect(resolveChangedFilesPresentation({ files, isCurrentChange: false })).toBe("collapsed");
    expect(
      resolveChangedFilesPresentation({ files, isCurrentChange: false, userOverride: true }),
    ).toBe("expanded");
    expect(
      resolveChangedFilesPresentation({
        files: bulkyFiles,
        isCurrentChange: true,
        userOverride: false,
      }),
    ).toBe("collapsed");
    expect(
      resolveChangedFilesPresentation({ files: [], isCurrentChange: true, userOverride: true }),
    ).toBe("collapsed");
  });
});

describe("changed-files compact preview", () => {
  it("selects stable representatives from distinct parent directories before filling", () => {
    const files = [
      file("apps/web/src/components/chat/MessagesTimeline.tsx"),
      file("apps/web/src/components/chat/ChangedFilesCard.tsx"),
      file("apps/web/src/components/chat/ChangedFilesCard.test.tsx"),
      file("apps/server/src/provider/Layers/OpenCodeAdapter.ts"),
      file("packages/contracts/src/orchestration.ts"),
    ];

    expect(selectChangedFilePreview(files)).toEqual([
      { file: files[0], label: "chat/MessagesTimeline.tsx" },
      { file: files[3], label: "Layers/OpenCodeAdapter.ts" },
      { file: files[4], label: "contracts/src/orchestration.ts" },
    ]);
  });

  it("fills remaining slots in source order when all files share a parent", () => {
    const files = [file("src/a.ts"), file("src/b.ts"), file("src/c.ts"), file("src/d.ts")];

    expect(
      selectChangedFilePreview(files).map(({ file: selectedFile }) => selectedFile.path),
    ).toEqual(["src/a.ts", "src/b.ts", "src/c.ts"]);
  });

  it("uses the shortest useful unique suffix for duplicate names and generic parents", () => {
    const paths = [
      "apps/web/src/index.ts",
      "apps/server/src/index.ts",
      "packages/contracts/src/orchestration.ts",
      "README.md",
    ];

    expect(compactChangedFilePath(paths[0]!, paths)).toBe("web/src/index.ts");
    expect(compactChangedFilePath(paths[1]!, paths)).toBe("server/src/index.ts");
    expect(compactChangedFilePath(paths[2]!, paths)).toBe("contracts/src/orchestration.ts");
    expect(compactChangedFilePath(paths[3]!, paths)).toBe("README.md");
  });

  it("normalizes Windows separators, skips duplicate paths, and honors a zero limit", () => {
    const first = file("apps\\web\\src\\a.ts");
    const duplicate = file("apps/web/src/a.ts");
    const second = file("apps\\server\\src\\b.ts");

    expect(selectChangedFilePreview([first, duplicate, second])).toEqual([
      { file: first, label: "web/src/a.ts" },
      { file: second, label: "server/src/b.ts" },
    ]);
    expect(selectChangedFilePreview([first, second], 0)).toEqual([]);
    expect(selectChangedFilePreview([first, second], Number.NaN)).toEqual([]);
  });

  it("does not mutate the donor file array or its entries", () => {
    const files = [file("src/a.ts"), file("src/b.ts"), file("src/c.ts")];
    const snapshot = structuredClone(files);

    selectChangedFilePreview(files, 2);

    expect(files).toEqual(snapshot);
  });
});
